import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

function parseArgs(argv) {
  const out = {
    server: "http://127.0.0.1:8080",
    page: "/examples/hello-world/",
    users: 10,
    duration: 120,
    repeats: 5,
    outDir: "results",
    headless: true,
    scene: "/examples/assets/splats/butterfly.spz",
    sceneVersion: "v1",
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "server") out.server = v;
    else if (k === "page") out.page = v;
    else if (k === "users") out.users = Number.parseInt(v || "10", 10);
    else if (k === "duration") out.duration = Number.parseInt(v || "120", 10);
    else if (k === "repeats") out.repeats = Number.parseInt(v || "5", 10);
    else if (k === "out") out.outDir = v || "results";
    else if (k === "headless") out.headless = v !== "false";
    else if (k === "scene") out.scene = v || out.scene;
    else if (k === "scene_version") out.sceneVersion = v || out.sceneVersion;
  }
  return out;
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function stats(values) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return {
    count: nums.length,
    median: pct(nums, 50),
    p95: pct(nums, 95),
    p99: pct(nums, 99),
    min: nums[0] ?? null,
    max: nums[nums.length - 1] ?? null,
    mean: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null,
  };
}

function normNum(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeDiv(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return a / b;
}

function classify(summaryA, summaryB, summaryC) {
  const wallA = summaryA.wall_ms.median;
  const wallB = summaryB.wall_ms.median;
  const wallC = summaryC.wall_ms.median;
  const ttfbA = summaryA.network_ttfb_ms.median;
  const ttfbB = summaryB.network_ttfb_ms.median;
  const dlA = summaryA.network_download_ms.median;
  const dlB = summaryB.network_download_ms.median;
  const longA = summaryA.longtask_total_ms.median;
  const longB = summaryB.longtask_total_ms.median;
  const fpsA = summaryA.fps_avg.median;
  const fpsB = summaryB.fps_avg.median;
  const fpsC = summaryC.fps_avg.median;

  const wallRise = safeDiv(wallB - wallA, wallA);
  const wallRecovery = safeDiv(wallB - wallC, wallB);
  const ttfbRise = safeDiv(ttfbB - ttfbA, ttfbA || 1);
  const dlRise = safeDiv(dlB - dlA, dlA || 1);
  const longRise = safeDiv(longB - longA, (longA ?? 1));
  const fpsDrop = safeDiv(fpsA - fpsB, fpsA || 1);
  const fpsRecover = safeDiv(fpsC - fpsB, fpsB || 1);

  const networkStrong = (ttfbRise ?? 0) > 0.25 || (dlRise ?? 0) > 0.25;
  const renderStrong = (longRise ?? 0) > 0.3 || (fpsDrop ?? 0) > 0.2 || (wallRecovery ?? 0) > 0.12 || (fpsRecover ?? 0) > 0.15;

  let verdict = "mixed_or_uncertain";
  if (networkStrong && !renderStrong) verdict = "network_bottleneck_likely";
  else if (renderStrong && !networkStrong) verdict = "web_render_bottleneck_likely";
  else if (networkStrong && renderStrong) verdict = "mixed_bottleneck";

  return {
    verdict,
    signals: { wallRise, wallRecovery, ttfbRise, dlRise, longRise, fpsDrop, fpsRecover },
  };
}

function addUrlParams(base, params) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.toString();
}

async function runClient({
  browser,
  userIndex,
  url,
  durationMs,
  lowQuality,
  runId,
  scene,
  sceneVersion,
}) {
  const context = await browser.newContext({
    viewport: lowQuality ? { width: 960, height: 540 } : { width: 1280, height: 720 },
    deviceScaleFactor: lowQuality ? 1 : 1.5,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");

  const failEvents = [];
  const reqMap = new Map();

  cdp.on("Network.requestWillBeSent", (evt) => {
    reqMap.set(evt.requestId, { request: evt, response: null, finished: null, failed: null });
  });
  cdp.on("Network.responseReceived", (evt) => {
    const row = reqMap.get(evt.requestId);
    if (row) row.response = evt;
  });
  cdp.on("Network.loadingFinished", (evt) => {
    const row = reqMap.get(evt.requestId);
    if (row) row.finished = evt;
  });
  cdp.on("Network.loadingFailed", (evt) => {
    const row = reqMap.get(evt.requestId);
    if (row) row.failed = evt;
    failEvents.push(evt);
  });

  await page.addInitScript(() => {
    const t0 = performance.now();
    const longTask = { count: 0, total: 0, max: 0, items: [] };
    const raf = { deltas: [], fpsSamples: [], last: 0, secFrames: 0, secStart: 0 };
    const gl = { contextLost: 0, shaderCompileMs: [], shaderCompilePeakMs: 0 };

    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const d = e.duration || 0;
          longTask.count += 1;
          longTask.total += d;
          if (d > longTask.max) longTask.max = d;
          longTask.items.push(d);
        }
      });
      po.observe({ entryTypes: ["longtask"] });
    } catch (_err) {
      // ignore unsupported browser entry types
    }

    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function patchedGetContext(type, attrs) {
      const ctx = originalGetContext.call(this, type, attrs);
      if (ctx && (type === "webgl" || type === "webgl2")) {
        this.addEventListener("webglcontextlost", () => {
          gl.contextLost += 1;
        });
        const proto = Object.getPrototypeOf(ctx);
        if (proto && proto.compileShader && !proto.__benchCompileWrapped) {
          const origCompile = proto.compileShader;
          proto.compileShader = function compileShaderWrapped(shader) {
            const s = performance.now();
            const r = origCompile.call(this, shader);
            const d = performance.now() - s;
            gl.shaderCompileMs.push(d);
            if (d > gl.shaderCompilePeakMs) gl.shaderCompilePeakMs = d;
            return r;
          };
          proto.__benchCompileWrapped = true;
        }
      }
      return ctx;
    };

    function rafLoop(ts) {
      if (raf.last) {
        raf.deltas.push(ts - raf.last);
      }
      raf.last = ts;
      if (!raf.secStart) raf.secStart = ts;
      raf.secFrames += 1;
      if (ts - raf.secStart >= 1000) {
        raf.fpsSamples.push((raf.secFrames * 1000) / (ts - raf.secStart));
        raf.secFrames = 0;
        raf.secStart = ts;
      }
      requestAnimationFrame(rafLoop);
    }
    requestAnimationFrame(rafLoop);

    window.__bench = {
      t0,
      finish() {
        const sortedDelta = [...raf.deltas].sort((a, b) => a - b);
        const sortedFps = [...raf.fpsSamples].sort((a, b) => a - b);
        const quantile = (arr, p) => {
          if (!arr.length) return null;
          const i = Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1));
          return arr[i];
        };
        return {
          longtask: {
            count: longTask.count,
            totalMs: longTask.total,
            maxMs: longTask.max,
            p95Ms: quantile([...longTask.items].sort((a, b) => a - b), 95),
          },
          raf: {
            frameCount: raf.deltas.length,
            p50Ms: quantile(sortedDelta, 50),
            p95Ms: quantile(sortedDelta, 95),
            p99Ms: quantile(sortedDelta, 99),
          },
          fps: {
            avg: sortedFps.length ? sortedFps.reduce((a, b) => a + b, 0) / sortedFps.length : null,
            low1: quantile(sortedFps, 1),
          },
          webgl: {
            contextLost: gl.contextLost,
            shaderCompilePeakMs: gl.shaderCompilePeakMs,
          },
          marks: window._marks ?? {},
        };
      },
    };
  });

  await page.setExtraHTTPHeaders({ "Cache-Control": "no-cache, no-store", Pragma: "no-cache" });
  const finalURL = addUrlParams(url, {
    _cb: `${Date.now()}_${userIndex}_${Math.random().toString(36).slice(2)}`,
    bench_quality: lowQuality ? "low" : "normal",
    quality: lowQuality ? "low" : "high",
    run_id: runId,
    user_id: `user${userIndex}`,
    duration: durationMs,
    scene,
    scene_version: sceneVersion,
  });

  const startedAt = Date.now();
  let errMsg = null;
  try {
    await page.goto(finalURL, { waitUntil: "load", timeout: 45000 });
    await page.waitForFunction(() => window._marks?.["interactive-ready"] != null, { timeout: 35000 });
    await page.waitForTimeout(durationMs);
  } catch (err) {
    errMsg = err instanceof Error ? err.message : String(err);
  }

  const finishedAt = Date.now();
  let perf = null;
  try {
    perf = await page.evaluate(() => window.__bench?.finish?.() ?? null);
  } catch (_err) {
    perf = null;
  }

  // Best-effort network timing for main document & first splat
  const allNet = [...reqMap.values()];
  const doc = allNet.find((x) => x.response?.type === "Document");
  const splat = allNet.find((x) => {
    const u = x.request?.request?.url || "";
    return u.includes(".spz");
  });
  const pickTiming = (row) => {
    const t = row?.response?.response?.timing;
    if (!t) return {};
    const reqStart = t.requestTime * 1000;
    const dnsMs = Number.isFinite(t.dnsEnd) && Number.isFinite(t.dnsStart) ? t.dnsEnd - t.dnsStart : null;
    const tcpMs = Number.isFinite(t.connectEnd) && Number.isFinite(t.connectStart) ? t.connectEnd - t.connectStart : null;
    const tlsMs = Number.isFinite(t.sslEnd) && Number.isFinite(t.sslStart) && t.sslStart >= 0 ? t.sslEnd - t.sslStart : null;
    const responseStartMs = Number.isFinite(t.receiveHeadersEnd) ? t.receiveHeadersEnd : null;
    const responseEndMs = row?.finished?.timestamp && row?.request?.request?.wallTime
      ? (row.finished.timestamp - row.request.timestamp) * 1000
      : null;
    return {
      dnsMs,
      tcpMs,
      tlsMs,
      ttfbMs: responseStartMs,
      downloadMs: responseEndMs != null && responseStartMs != null ? Math.max(0, responseEndMs - responseStartMs) : null,
      _requestStartEpochMs: reqStart,
    };
  };

  const marks = perf?.marks ?? {};
  const worker_init = marks["worker-init-start"] != null && marks["worker-init-end"] != null
    ? marks["worker-init-end"] - marks["worker-init-start"]
    : null;
  const first_byte_gap = marks["first-spz-request"] != null && marks["first-spz-first-byte"] != null
    ? marks["first-spz-first-byte"] - marks["first-spz-request"]
    : null;
  const first_frame_gap = marks["first-spz-first-byte"] != null && marks["first-nonempty-frame"] != null
    ? marks["first-nonempty-frame"] - marks["first-spz-first-byte"]
    : null;
  const ready_gap = marks["first-nonempty-frame"] != null && marks["interactive-ready"] != null
    ? marks["interactive-ready"] - marks["first-nonempty-frame"]
    : null;
  const decode_ms = marks["first-spz-first-byte"] != null && marks["decode-complete"] != null
    ? marks["decode-complete"] - marks["first-spz-first-byte"]
    : null;
  const upload_gpu_ms = marks["decode-complete"] != null && marks["first-nonempty-frame"] != null
    ? marks["first-nonempty-frame"] - marks["decode-complete"]
    : null;
  const first_interaction_ms = marks["first-interaction"] != null ? marks["first-interaction"] : null;

  const netSplat = pickTiming(splat);

  const result = {
    user: userIndex,
    error: errMsg,
    wall_ms: finishedAt - startedAt,
    worker_init: normNum(worker_init),
    first_byte_gap: normNum(first_byte_gap),
    first_frame_gap: normNum(first_frame_gap),
    ready_gap: normNum(ready_gap),
    decode_ms: normNum(decode_ms),
    upload_gpu_ms: normNum(upload_gpu_ms),
    first_interaction_ms: normNum(first_interaction_ms),
    network: {
      doc: pickTiming(doc),
      splat: netSplat,
      failure_count: failEvents.length,
      failures: failEvents.map((x) => ({ errorText: x.errorText, type: x.type, canceled: x.canceled })),
    },
    main_thread: {
      longtask_total_ms: normNum(perf?.longtask?.totalMs),
      longtask_count: normNum(perf?.longtask?.count),
      longtask_p95_ms: normNum(perf?.longtask?.p95Ms),
      raf_p50_ms: normNum(perf?.raf?.p50Ms),
      raf_p95_ms: normNum(perf?.raf?.p95Ms),
      raf_p99_ms: normNum(perf?.raf?.p99Ms),
      fps_avg: normNum(perf?.fps?.avg),
      fps_low_1p: normNum(perf?.fps?.low1),
      webgl_context_lost: normNum(perf?.webgl?.contextLost),
      shader_compile_peak_ms: normNum(perf?.webgl?.shaderCompilePeakMs),
    },
    raw_marks: marks,
  };

  await context.close();
  return result;
}

function summarizeUsers(users) {
  const pick = (fn) => users.map(fn).filter((x) => Number.isFinite(x));
  return {
    wall_ms: stats(pick((u) => u.wall_ms)),
    worker_init: stats(pick((u) => u.worker_init)),
    first_byte_gap: stats(pick((u) => u.first_byte_gap)),
    first_frame_gap: stats(pick((u) => u.first_frame_gap)),
    ready_gap: stats(pick((u) => u.ready_gap)),
    decode_ms: stats(pick((u) => u.decode_ms)),
    upload_gpu_ms: stats(pick((u) => u.upload_gpu_ms)),
    first_interaction_ms: stats(pick((u) => u.first_interaction_ms)),
    network_ttfb_ms: stats(pick((u) => u.network?.splat?.ttfbMs)),
    network_download_ms: stats(pick((u) => u.network?.splat?.downloadMs)),
    network_dns_ms: stats(pick((u) => u.network?.splat?.dnsMs)),
    network_tcp_ms: stats(pick((u) => u.network?.splat?.tcpMs)),
    network_tls_ms: stats(pick((u) => u.network?.splat?.tlsMs)),
    network_failures: stats(pick((u) => u.network?.failure_count)),
    longtask_total_ms: stats(pick((u) => u.main_thread?.longtask_total_ms)),
    longtask_count: stats(pick((u) => u.main_thread?.longtask_count)),
    raf_p95_ms: stats(pick((u) => u.main_thread?.raf_p95_ms)),
    raf_p99_ms: stats(pick((u) => u.main_thread?.raf_p99_ms)),
    fps_avg: stats(pick((u) => u.main_thread?.fps_avg)),
    fps_low_1p: stats(pick((u) => u.main_thread?.fps_low_1p)),
    webgl_context_lost: stats(pick((u) => u.main_thread?.webgl_context_lost)),
    shader_compile_peak_ms: stats(pick((u) => u.main_thread?.shader_compile_peak_ms)),
  };
}

function toCsv(rows) {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    if (/[",\n]/.test(s)) return `"${s.replaceAll("\"", "\"\"")}"`;
    return s;
  };
  return [keys.join(","), ...rows.map((r) => keys.map((k) => esc(r[k])).join(","))].join("\n") + "\n";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const server = args.server.endsWith("/") ? args.server.slice(0, -1) : args.server;
  const url = `${server}${args.page.startsWith("/") ? args.page : `/${args.page}`}`;
  const rawDir = path.join(args.outDir, "raw");
  await fs.mkdir(rawDir, { recursive: true });

  const groups = [
    { id: "A", name: "N=1 baseline", users: 1, lowQuality: false },
    { id: "B", name: `N=${args.users} normal`, users: args.users, lowQuality: false },
    { id: "C", name: `N=${args.users} low-quality`, users: args.users, lowQuality: true },
  ];

  const browser = await chromium.launch({ headless: args.headless });
  const all = [];
  try {
    for (const group of groups) {
      for (let r = 1; r <= args.repeats; r += 1) {
        console.log(`\n[bench] Group ${group.id} repeat ${r}/${args.repeats} users=${group.users} lowQuality=${group.lowQuality}`);
        const runId = `${group.id}-r${r}-${Date.now()}`;
        try {
          await fetch(`${url.replace(/\/[^/]*$/, "")}/bench/start`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ run_id: runId }),
          });
        } catch (_err) {
          // optional endpoint
        }

        const users = await Promise.all(
          Array.from({ length: group.users }, (_, i) =>
            runClient({
              browser,
              userIndex: i,
              url,
              durationMs: args.duration * 1000,
              lowQuality: group.lowQuality,
              runId,
              scene: args.scene,
              sceneVersion: args.sceneVersion,
            }),
          ),
        );
        const run = {
          group: group.id,
          group_name: group.name,
          repeat: r,
          users: group.users,
          low_quality: group.lowQuality,
          duration_s: args.duration,
          run_id: runId,
          ts: new Date().toISOString(),
          data: users,
        };
        all.push(run);
        await fs.writeFile(path.join(rawDir, `${group.id}_repeat${r}.json`), JSON.stringify(run, null, 2), "utf8");
        try {
          await fetch(`${url.replace(/\/[^/]*$/, "")}/bench/stop`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ run_id: runId }),
          });
        } catch (_err) {
          // optional endpoint
        }
      }
    }
  } finally {
    await browser.close();
  }

  const groupSummary = {};
  const csvRows = [];

  for (const group of groups) {
    const runs = all.filter((x) => x.group === group.id);
    const users = runs.flatMap((x) => x.data);
    const summary = summarizeUsers(users);
    groupSummary[group.id] = summary;

    csvRows.push({
      group: group.id,
      repeats: runs.length,
      users_per_run: group.users,
      low_quality: String(group.lowQuality),
      wall_ms_median: summary.wall_ms.median,
      wall_ms_p95: summary.wall_ms.p95,
      network_ttfb_median: summary.network_ttfb_ms.median,
      network_download_median: summary.network_download_ms.median,
      longtask_total_median: summary.longtask_total_ms.median,
      longtask_count_median: summary.longtask_count.median,
      raf_p95_median: summary.raf_p95_ms.median,
      raf_p99_median: summary.raf_p99_ms.median,
      fps_avg_median: summary.fps_avg.median,
      fps_low1_median: summary.fps_low_1p.median,
      worker_init_median: summary.worker_init.median,
      first_byte_gap_median: summary.first_byte_gap.median,
      first_frame_gap_median: summary.first_frame_gap.median,
      ready_gap_median: summary.ready_gap.median,
      decode_ms_median: summary.decode_ms.median,
      upload_gpu_ms_median: summary.upload_gpu_ms.median,
      first_interaction_ms_median: summary.first_interaction_ms.median,
      failures_p95: summary.network_failures.p95,
      webgl_context_lost_max: summary.webgl_context_lost.max,
      shader_compile_peak_p95: summary.shader_compile_peak_ms.p95,
    });
  }

  const verdict = classify(groupSummary.A, groupSummary.B, groupSummary.C);
  const summaryCsvPath = path.join(args.outDir, "summary.csv");
  await fs.writeFile(summaryCsvPath, toCsv(csvRows), "utf8");

  const reportPath = path.join(args.outDir, "report.md");
  const report = `# 10 Clients Remote Bench Report

- server: \`${server}\`
- page: \`${args.page}\`
- repeats/group: \`${args.repeats}\`
- duration/run: \`${args.duration}s\`
- generated_at: \`${new Date().toISOString()}\`

## Experiment Design
- A: N=1 baseline
- B: N=${args.users} local concurrent
- C: N=${args.users} + low quality/resolution
- fixed scene/camera/resource version assumed by page URL

## Aggregated Metrics (Median / P95)

${csvRows.map((r) => `- ${r.group}: wall=${r.wall_ms_median}/${r.wall_ms_p95}, ttfb=${r.network_ttfb_median}, download=${r.network_download_median}, longtask=${r.longtask_total_median}, raf_p95=${r.raf_p95_median}, fps=${r.fps_avg_median}`).join("\n")}

## Root Cause Classification
- verdict: **${verdict.verdict}**
- wall rise (A->B): ${verdict.signals.wallRise}
- wall recovery (B->C): ${verdict.signals.wallRecovery}
- ttfb rise (A->B): ${verdict.signals.ttfbRise}
- download rise (A->B): ${verdict.signals.dlRise}
- longtask rise (A->B): ${verdict.signals.longRise}
- fps drop (A->B): ${verdict.signals.fpsDrop}
- fps recovery (B->C): ${verdict.signals.fpsRecover}

## Notes
- \`first_byte_gap\` comes from worker first chunk, suitable for internal timing, not strict network TTFB.
- network retry/transmission details are CDP-limited in this script; failure counts are collected.
- raw per-user results are in \`results/raw/*.json\`.
`;
  await fs.writeFile(reportPath, report, "utf8");

  console.log("\nDone.");
  console.log(`- raw: ${rawDir}`);
  console.log(`- summary: ${summaryCsvPath}`);
  console.log(`- report: ${reportPath}`);
  console.log(`- verdict: ${verdict.verdict}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
