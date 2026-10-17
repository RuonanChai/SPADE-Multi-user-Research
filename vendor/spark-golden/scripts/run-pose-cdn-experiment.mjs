import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

function percentile(values, p) {
  const sorted = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx];
}

function summarizeChromeTrace(traceEvents) {
  const beginMap = new Map();
  let mainThreadTaskTotalUs = 0;
  let compositorTaskTotalUs = 0;
  let rasterTaskTotalUs = 0;
  let gpuTaskTotalUs = 0;
  let longestGpuUs = 0;
  const mainTasksUs = [];
  const frameTsUs = [];
  let delayedFrames = 0;

  const lane = (evt) => {
    const n = String(evt.name || "");
    const c = String(evt.cat || "");
    if (c.includes("gpu") || n.toLowerCase().includes("gpu")) return "gpu";
    if (c.includes("cc") || n.toLowerCase().includes("compositor")) return "compositor";
    if (n.toLowerCase().includes("raster") || c.includes("viz")) return "raster";
    if (c.includes("devtools.timeline") || c.includes("toplevel")) return "main";
    return "other";
  };

  for (const evt of traceEvents || []) {
    if (!evt || typeof evt.ts !== "number") continue;
    if (String(evt.name) === "DrawFrame" || String(evt.name).includes("Frame")) frameTsUs.push(evt.ts);
    if (evt.ph === "X" && typeof evt.dur === "number") {
      const l = lane(evt);
      if (l === "main") {
        mainThreadTaskTotalUs += evt.dur;
        mainTasksUs.push(evt.dur);
      } else if (l === "compositor") compositorTaskTotalUs += evt.dur;
      else if (l === "raster") rasterTaskTotalUs += evt.dur;
      else if (l === "gpu") {
        gpuTaskTotalUs += evt.dur;
        longestGpuUs = Math.max(longestGpuUs, evt.dur);
      }
      continue;
    }
    if ((evt.ph === "B" || evt.ph === "E") && evt.pid != null && evt.tid != null) {
      const key = `${evt.pid}:${evt.tid}:${evt.name}`;
      if (evt.ph === "B") beginMap.set(key, evt.ts);
      else if (beginMap.has(key)) {
        const dur = evt.ts - beginMap.get(key);
        beginMap.delete(key);
        if (dur > 0) {
          const l = lane(evt);
          if (l === "main") {
            mainThreadTaskTotalUs += dur;
            mainTasksUs.push(dur);
          } else if (l === "compositor") compositorTaskTotalUs += dur;
          else if (l === "raster") rasterTaskTotalUs += dur;
          else if (l === "gpu") {
            gpuTaskTotalUs += dur;
            longestGpuUs = Math.max(longestGpuUs, dur);
          }
        }
      }
    }
  }

  const sortedFrame = frameTsUs.sort((a, b) => a - b);
  const frameIntervalsMs = [];
  for (let i = 1; i < sortedFrame.length; i += 1) {
    const dtMs = (sortedFrame[i] - sortedFrame[i - 1]) / 1000;
    if (dtMs > 0) {
      frameIntervalsMs.push(dtMs);
      if (dtMs > 34) delayedFrames += 1;
    }
  }

  return {
    main_thread_task_total_ms: mainThreadTaskTotalUs / 1000,
    long_main_thread_tasks: mainTasksUs.filter((x) => x / 1000 > 50).length,
    compositor_task_total_ms: compositorTaskTotalUs / 1000,
    raster_task_total_ms: rasterTaskTotalUs / 1000,
    gpu_process_task_total_ms: gpuTaskTotalUs / 1000,
    frame_count: sortedFrame.length,
    dropped_or_delayed_frame_count: delayedFrames,
    frame_interval_p50_ms: percentile(frameIntervalsMs, 0.5),
    frame_interval_p95_ms: percentile(frameIntervalsMs, 0.95),
    frame_interval_p99_ms: percentile(frameIntervalsMs, 0.99),
    longest_gpu_related_event_ms: longestGpuUs / 1000,
    note: "Chromium trace GPU events are browser pipeline diagnostics, not exact GPU draw-call execution time.",
  };
}

function parseArgs(argv) {
  const out = {
    scenario: "C_nearcohort_partial_overlap",
    clients: 8,
    cacheMode: "mixed_cache",
    runs: 1,
    cdnBaseUrl: "",
    mode: "direct-cdn",
    workload: "pose-driven",
    appBaseUrl: "http://127.0.0.1:8090",
    enableChromeTrace: false,
    outputRoot: "260429",
    includeInvalid: false,
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "scenario") out.scenario = v || out.scenario;
    else if (k === "clients") out.clients = Number.parseInt(v || "8", 10);
    else if (k === "cache-mode") out.cacheMode = v || out.cacheMode;
    else if (k === "runs") out.runs = Number.parseInt(v || "1", 10);
    else if (k === "cdn-base-url") out.cdnBaseUrl = v || out.cdnBaseUrl;
    else if (k === "mode") out.mode = v || out.mode;
    else if (k === "workload") out.workload = v || out.workload;
    else if (k === "app-base-url") out.appBaseUrl = (v || out.appBaseUrl).replace(/\/$/, "");
    else if (k === "enable-chrome-trace") out.enableChromeTrace = v === "true" || v === "1" || v === "";
    else if (k === "output-root") out.outputRoot = v || out.outputRoot;
  }
  return out;
}

async function readScenario(scenarioArg) {
  const asPath = path.resolve(scenarioArg);
  try {
    return JSON.parse(await fs.readFile(asPath, "utf8"));
  } catch {
    const defaultPath = path.resolve("experiments/scenarios", `${scenarioArg}.json`);
    return JSON.parse(await fs.readFile(defaultPath, "utf8"));
  }
}

function jsonl(rows) {
  return rows.map((x) => JSON.stringify(x)).join("\n") + (rows.length ? "\n" : "");
}

async function prepareCache({ cacheMode, runId, cdnBaseUrl, runCdnDir }) {
  const prep = {
    cache_mode: cacheMode,
    method: "none",
    warmed_objects: [],
    warmup_duration_ms: 0,
  };
  const warm = async (objects) => {
    const t0 = Date.now();
    for (const obj of objects) {
      const url = `${cdnBaseUrl}/${obj}${cacheMode === "cold_cache" ? `?v=${runId}` : ""}`;
      try {
        await fetch(url, { headers: { Range: "bytes=0-262143" } });
        prep.warmed_objects.push(obj);
      } catch {
        // best effort
      }
    }
    prep.warmup_duration_ms = Date.now() - t0;
  };
  if (cacheMode === "warm_cache") {
    prep.method = "warmup_fetch";
    await warm(["butterfly.spz"]);
  } else if (cacheMode === "mixed_cache") {
    prep.method = "partial_warmup_fetch";
    await warm(["butterfly.spz"]);
    prep.cold_tail_hint = ["high_lod_or_view_specific_chunks"];
  } else {
    prep.method = "cache_key_versioning";
    prep.cache_key = `v=${runId}`;
  }
  await fs.mkdir(runCdnDir, { recursive: true });
  await fs.writeFile(path.join(runCdnDir, "cache-preparation.json"), JSON.stringify(prep, null, 2));
  return prep;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode !== "legacy-proxy-debug" && args.mode !== "direct-cdn") {
    throw new Error("mode 仅支持 direct-cdn 或 legacy-proxy-debug");
  }
  if (!args.cdnBaseUrl && args.mode === "direct-cdn") {
    throw new Error("direct-cdn 需要 --cdn-base-url");
  }
  if (args.workload !== "pose-driven" && args.workload !== "trace-replay-debug") {
    throw new Error("workload 仅支持 pose-driven 或 trace-replay-debug");
  }
  const scenario = await readScenario(args.scenario);
  const experimentId = `exp-${Date.now()}`;
  const baseRoot = path.resolve(args.outputRoot);
  const logsRoot = path.join(baseRoot, "logs", experimentId);
  await fs.mkdir(logsRoot, { recursive: true });
  await fs.writeFile(
    path.join(logsRoot, "experiment-metadata.json"),
    JSON.stringify(
      {
        experiment_id: experimentId,
        scenario_id: scenario.scenario_id,
        mode: args.mode,
        workload: args.workload,
        created_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  for (let runIdx = 0; runIdx < args.runs; runIdx += 1) {
    const runId = `run-${Date.now()}-${String(runIdx + 1).padStart(2, "0")}`;
    const runDir = path.join(logsRoot, runId);
    const runCdnDir = path.join(runDir, "cdn");
    await fs.mkdir(runDir, { recursive: true });
    const cachePrep = await prepareCache({
      cacheMode: args.cacheMode,
      runId,
      cdnBaseUrl: args.cdnBaseUrl.replace(/\/$/, ""),
      runCdnDir,
    });
    const browser = await chromium.launch({ headless: true });
    const selectedClients = scenario.clients.slice(0, Math.min(args.clients, scenario.clients.length));
    const contexts = [];
    const startAtMs = Date.now() + 4000;
    const runMeta = {
      experiment_id: experimentId,
      run_id: runId,
      scenario_id: scenario.scenario_id,
      cache_mode: args.cacheMode,
      client_count: selectedClients.length,
      cdn_base_url: args.cdnBaseUrl,
      mode: args.mode,
      workload: args.workload,
      start_time_unix_ms: startAtMs,
      valid: true,
      invalid_reason: null,
      cache_preparation_method: cachePrep.method,
    };

    try {
      for (const client of selectedClients) {
        const clientDir = path.join(runDir, `client-${client.client_id}`);
        await fs.mkdir(clientDir, { recursive: true });
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        const page = await context.newPage();
        const posePath = path.join(clientDir, "pose-script.json");
        const poseScript = {
          scenario_id: scenario.scenario_id,
          client_id: client.client_id,
          sample_interval_ms: client.sample_interval_ms,
          poses: client.poses,
        };
        await fs.writeFile(posePath, JSON.stringify(poseScript, null, 2));
        const poseVirtualPath = `/__pose/${runId}-${client.client_id}.json`;
        await context.route(`**${poseVirtualPath}`, async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(poseScript),
          });
        });

        let traceChunks = [];
        let cdp = null;
        if (args.enableChromeTrace) {
          cdp = await context.newCDPSession(page);
          await cdp.send("Tracing.start", {
            categories:
              "loading,netlog,v8,blink,cc,gpu,viz,toplevel,devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,disabled-by-default-gpu.service,disabled-by-default-viz",
            transferMode: "ReportEvents",
          });
          cdp.on("Tracing.dataCollected", (evt) => {
            traceChunks.push(...(evt.value || []));
          });
        }

        // Use explicit index.html to avoid directory listing fallback.
        const url = new URL(`${args.appBaseUrl}/examples/hello-world/index.html`);
        url.searchParams.set("mode", args.workload === "pose-driven" ? "pose-driven" : "replay");
        url.searchParams.set("run_id", runId);
        url.searchParams.set("scenario_id", scenario.scenario_id);
        url.searchParams.set("cache_mode", args.cacheMode);
        url.searchParams.set("client_id", client.client_id);
        url.searchParams.set("experiment_id", experimentId);
        url.searchParams.set("workload", args.workload);
        url.searchParams.set("user_id", client.client_id);
        url.searchParams.set("trace_id", `${scenario.scenario_id}-${client.client_id}`);
        url.searchParams.set("pose_script_url", `${args.appBaseUrl}${poseVirtualPath}`);
        url.searchParams.set("cdn_base_url", args.cdnBaseUrl.replace(/\/$/, ""));
        if (args.cacheMode === "cold_cache") {
          url.searchParams.set("cache_key_version", runId);
        }
        url.searchParams.set("start_offset_ms", String(Math.max(0, startAtMs - Date.now())));

        await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 120000 });
        contexts.push({ context, page, clientId: client.client_id, clientDir, cdp, traceChunks });
      }

      await new Promise((r) => setTimeout(r, 95000));

      const cacheRows = [];
      for (const c of contexts) {
        const data = await c.page.evaluate(() => ({
          pose: window.__clientTrace?.get_pose_trace?.() || [],
          scheduler: window.__clientTrace?.get_scheduler_decisions?.() || [],
          resource: window.__clientTrace?.get_resource_timing?.() || [],
          marks: window.__clientTrace?.get_app_marks?.() || [],
          pageSummary: window.__clientTrace?.get_page_main_thread_summary?.() || {},
          fetchLogs: window.__clientTrace?.get_fetch_logs?.() || [],
          hasClientTrace: Boolean(window.__clientTrace),
        }));
        if (!data.hasClientTrace) {
          throw new Error("client trace bridge missing: __clientTrace unavailable in page context");
        }
        await fs.writeFile(path.join(c.clientDir, "pose-trace.jsonl"), jsonl(data.pose));
        await fs.writeFile(path.join(c.clientDir, "scheduler-decisions.jsonl"), jsonl(data.scheduler));
        await fs.writeFile(path.join(c.clientDir, "resource-timing.jsonl"), jsonl(data.resource));
        await fs.writeFile(path.join(c.clientDir, "app-performance-marks.jsonl"), jsonl(data.marks));
        await fs.writeFile(
          path.join(c.clientDir, "page-main-thread-summary.json"),
          `${JSON.stringify(data.pageSummary, null, 2)}\n`,
        );
        if (args.enableChromeTrace && c.cdp) {
          await c.cdp.send("Tracing.end");
          await new Promise((r) => setTimeout(r, 500));
          const tracePath = path.join(c.clientDir, "chrome-trace.json");
          await fs.writeFile(tracePath, JSON.stringify({ traceEvents: c.traceChunks }, null, 2));
          const summary = summarizeChromeTrace(c.traceChunks);
          await fs.writeFile(path.join(c.clientDir, "chrome-trace-summary.json"), JSON.stringify(summary, null, 2));
        }
        await fs.writeFile(
          path.join(c.clientDir, "gpu-timer-query.jsonl"),
          `${JSON.stringify({
            run_id: runId,
            scenario_id: scenario.scenario_id,
            cache_mode: args.cacheMode,
            client_id: c.clientId,
            gpu_timer_query_supported: false,
          })}\n`,
        );

        for (const f of data.fetchLogs) {
          cacheRows.push({
            object_url: f.url,
            transfer_size: f.transfer_size ?? null,
            cf_cache_status: f.cf_cache_status || "unknown",
            age: f.age || null,
            cf_ray: f.cf_ray || null,
            server_timing: f.server_timing || null,
            client_id: c.clientId,
          });
        }
      }
      await fs.writeFile(
        path.join(runCdnDir, "cache-status-summary.json"),
        JSON.stringify(
          {
            run_id: runId,
            summary_by_status: cacheRows.reduce((acc, row) => {
              acc[row.cf_cache_status] = (acc[row.cf_cache_status] || 0) + 1;
              return acc;
            }, {}),
            rows: cacheRows,
          },
          null,
          2,
        ),
      );
      await fs.writeFile(
        path.join(runCdnDir, "cloudflare-analytics-summary.json"),
        JSON.stringify(
          {
            skipped: !process.env.CLOUDFLARE_API_TOKEN,
            reason: process.env.CLOUDFLARE_API_TOKEN ? null : "missing_credentials",
          },
          null,
          2,
        ),
      );
      await fs.writeFile(
        path.join(runCdnDir, "r2-ops-summary.json"),
        JSON.stringify(
          {
            skipped: !process.env.R2_BUCKET_NAME,
            reason: process.env.R2_BUCKET_NAME ? null : "missing_credentials",
          },
          null,
          2,
        ),
      );

      const hasAnyClientData = contexts.length === selectedClients.length;
      if (!hasAnyClientData) {
        runMeta.valid = false;
        runMeta.invalid_reason = "missing_clients";
      }
      if (args.mode === "direct-cdn" && /localhost|127\.0\.0\.1/i.test(args.cdnBaseUrl)) {
        runMeta.valid = false;
        runMeta.invalid_reason = "proxy_or_localhost_detected_in_direct_mode";
      }
    } catch (error) {
      runMeta.valid = false;
      runMeta.invalid_reason = String(error?.message || error);
    } finally {
      for (const c of contexts) {
        await c.context.close().catch(() => {});
      }
      await browser.close().catch(() => {});
      await fs.writeFile(path.join(runDir, "run-metadata.json"), JSON.stringify(runMeta, null, 2));
    }
  }
  console.log(`experiment completed: ${logsRoot}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
