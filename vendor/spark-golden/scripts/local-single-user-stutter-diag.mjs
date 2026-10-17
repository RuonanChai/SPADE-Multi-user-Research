/**
 * 单用户本机卡顿诊断（独立脚本，不改 vrc-paper / examples 源码）。
 *
 *   node scripts/local-single-user-stutter-diag.mjs [--phaseMs=40000] [--warmupMs=20000] [--headless=0]
 *
 * 产出：260506_local_diag/single_user_stutter/<ts>/summary/stutter_diag.{json,md}
 */
import { createServer } from "node:http";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { CdpNetworkAuditor, summarizeCdpNetworkAudit } from "../vrc-paper/experiments/cdp_network_audit.mjs";
import { computeLatencyAttribution } from "../vrc-paper/experiments/latency_attribution.mjs";
import { writeAuditCsv } from "../vrc-paper/experiments/audit_io.mjs";
import {
  resourceTimingRowsFromPageEntries,
  summarizeResourceTiming,
  writeResourceTimingAuditCsv,
} from "../vrc-paper/experiments/resource_timing_audit.mjs";
import { attachLocalStutterTraceCollector } from "./lib/local_stutter_trace_collector.mjs";
import { MonitoredAssetServer, probeMonitoredServer } from "./lib/local_stutter_asset_server.mjs";
import { ServerProcessMonitor } from "./lib/local_stutter_server_process_monitor.mjs";
import { WindowsSystemMonitor } from "./lib/local_stutter_windows_system_monitor.mjs";
import { writeServerMonitorArtifacts } from "./lib/local_stutter_server_summary.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const LOCAL_RAD = path.join(projectRoot, "examples", "streaming-lod", "coit-40m-sh1-lod.rad");
const SESSION_ID = `local_stutter_u0_${Date.now()}`;

function parseArgs(argv) {
  const o = {
    outDir: path.join(projectRoot, "260506_local_diag", "single_user_stutter"),
    phaseMs: 40_000,
    warmupMs: 20_000,
    headless: false,
    assetPort: 0,
    pagePort: 0,
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "outDir") o.outDir = v || o.outDir;
    else if (k === "phaseMs") o.phaseMs = Math.max(5000, Number.parseInt(v || "25000", 10));
    else if (k === "warmupMs") o.warmupMs = Math.max(3000, Number.parseInt(v || "15000", 10));
    else if (k === "headless") o.headless = v !== "0" && v.toLowerCase() !== "false";
    else if (k === "assetPort") o.assetPort = Number.parseInt(v || "0", 10);
    else if (k === "pagePort") o.pagePort = Number.parseInt(v || "0", 10);
  }
  return o;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function parseSimpleCsv(filePath) {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, "utf8").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(",");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = lines[i].split(",");
    const o = {};
    header.forEach((h, j) => {
      const v = cols[j] ?? "";
      o[h] = v === "" ? null : Number.isFinite(Number(v)) && String(v).trim() !== "" ? Number(v) : v;
    });
    rows.push(o);
  }
  return rows;
}

async function cleanupStaleProcesses() {
  if (process.platform !== "win32") return;
  const selfPid = process.pid;
  try {
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.ProcessId -ne ${selfPid} -and ($_.CommandLine -like '*http-server*' -or $_.CommandLine -like '*local-single-user-stutter*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { stdio: "ignore" },
    );
    execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq \'powershell.exe\' -and $_.CommandLine -like \'*windows_monitor.ps1*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
      { stdio: "ignore" },
    );
  } catch { /* */ }
}

async function startMonitoredAssetServer(runDir, runId, preferredPort) {
  const port = preferredPort > 0 ? preferredPort : 19140;
  const srv = new MonitoredAssetServer({
    rootDir: projectRoot,
    port,
    runDir,
    runId,
    host: "127.0.0.1",
  });
  const info = await srv.start();
  await probeMonitoredServer(info.base);
  return { srv, ...info, implementation: "node_http_createReadStream_range" };
}

function applyDiagnosticImportMap(html) {
  const THREE_CDN = "https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js";
  const LIL_CDN = "https://cdn.jsdelivr.net/npm/lil-gui@0.20.0/dist/lil-gui.esm.js";
  const sparkLocal = existsSync(path.join(projectRoot, "dist", "spark.module.js"));
  const SPARK = sparkLocal
    ? "/dist/spark.module.js"
    : "https://cdn.jsdelivr.net/npm/@sparkjsdev/spark@2.0.0/dist/spark.module.js";
  let h = html;
  h = h.replace(
    /"three"\s*:\s*"\.\.\/js\/vendor\/three\/build\/three\.module\.js"/,
    `"three": "${THREE_CDN}"`,
  );
  h = h.replace(
    /"lil-gui"\s*:\s*"\/examples\/js\/vendor\/lil-gui\/dist\/lil-gui\.esm\.js"/,
    `"lil-gui": "${LIL_CDN}"`,
  );
  h = h.replace(
    /"@sparkjsdev\/spark"\s*:\s*"\.\.\/\.\.\/dist\/spark\.module\.js"/,
    `"@sparkjsdev/spark": "${SPARK}"`,
  );
  return { html: h, spark: SPARK, three: THREE_CDN };
}

async function buildPatchedHtml(assetBase) {
  const orig = path.join(projectRoot, "examples", "streaming-lod", "index.html");
  let html = await fs.readFile(orig, "utf8");
  const localRadUrl = `${assetBase}/examples/streaming-lod/coit-40m-sh1-lod.rad`;

  ({ html } = applyDiagnosticImportMap(html));
  html = html.replace(/<title>[\s\S]*?<\/title>/, "<title>单用户本机卡顿诊断 · Coit Tower</title>");
  html = html.replace(
    /url:\s*"https:\/\/storage\.googleapis\.com\/forge-dev-public\/asundqui\/rad\/260217\/coit-40m-sh1-lod\.rad"/,
    `url: "${localRadUrl}"`,
  );

  const diagInit = `
    window.__stutterDiag = {
      frame_times: [],
      stall_events: 0,
      long_frame_count: 0,
      jank_frames_over_33ms: 0,
      jank_frames_over_50ms: 0,
      first_visible_ms: null,
      splat_mesh_ready: false,
    };
    const __origSelectWorld = selectWorld;
    selectWorld = function(worldKey) {
      __origSelectWorld(worldKey);
      window.__stutterDiag.splat_mesh_ready = true;
      if (window.__stutterDiag.first_visible_ms == null) {
        window.__stutterDiag.first_visible_ms = performance.now();
      }
    };
  `;

  const origLoop = `    renderer.setAnimationLoop(function animate(time) {
      if (tracePlayer) tracePlayer.update();
      else if (controls) controls.update(camera);
      renderer.render(scene, camera);
    });`;

  const patchedLoop = `    let __lastRaf = performance.now();
    renderer.setAnimationLoop(function animate(time) {
      const __now = performance.now();
      const __dt = __now - __lastRaf;
      __lastRaf = __now;
      if (tracePlayer) tracePlayer.update();
      else if (controls) controls.update(camera);
      renderer.render(scene, camera);
      const __d = window.__stutterDiag;
      if (__dt > 0 && __dt < 2000) {
        __d.frame_times.push(__dt);
        if (__d.frame_times.length > 600) __d.frame_times.shift();
        if (__dt > 33.33) __d.jank_frames_over_33ms += 1;
        if (__dt > 50) __d.jank_frames_over_50ms += 1;
        if (__dt > 100) { __d.long_frame_count += 1; __d.stall_events += 1; }
      }
    });`;

  if (!html.includes(origLoop)) throw new Error("注入锚点缺失：animation loop");
  html = html.replace(origLoop, `${diagInit}\n${patchedLoop}`);

  const cacheDir = path.join(projectRoot, ".diag-cache", "single-user-stutter");
  const outFile = path.join(cacheDir, "examples", "streaming-lod", "index.html");
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, html, "utf8");
  return { outFile, localRadUrl, cacheDir };
}

async function startPageStaticServer(preferredPort, pathOverrides) {
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".wasm": "application/wasm",
  };
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      let p = decodeURIComponent(u.pathname);
      if (p === "/") p = "/index.html";
      let disk = pathOverrides?.has(p) ? pathOverrides.get(p) : null;
      if (!disk) {
        const rel = p.replace(/^\//, "");
        if (p.startsWith("/examples/")) disk = path.join(projectRoot, rel);
        else if (p.startsWith("/dist/")) disk = path.join(projectRoot, rel);
        else if (p.startsWith("/src/")) disk = path.join(projectRoot, rel);
        else {
          res.writeHead(404);
          res.end("404");
          return;
        }
      }
      if (!existsSync(disk) || !statSync(disk).isFile()) {
        res.writeHead(404);
        res.end("missing " + p);
        return;
      }
      const ext = path.extname(disk).toLowerCase();
      res.setHeader("Content-Type", mime[ext] || "application/octet-stream");
      res.writeHead(200);
      res.end(readFileSync(disk));
    } catch (e) {
      res.writeHead(500);
      res.end(String(e?.message || e));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(preferredPort > 0 ? preferredPort : 0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr && "port" in addr ? addr.port : 0;
  return { server, port, base: `http://127.0.0.1:${port}` };
}

async function orbitCamera(page, durationMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < durationMs) {
    const elapsed = Date.now() - t0;
    const a = (elapsed / durationMs) * Math.PI * 2;
    await page.evaluate((angle) => {
      const c = window.__slDiagCam;
      if (!c) return;
      const r = 6;
      c.position.set(Math.sin(angle) * r, 2.2 + Math.sin(angle * 0.5) * 0.5, Math.cos(angle) * r - 1.1);
      c.lookAt(0, 0, 0);
      c.updateMatrixWorld(true);
    }, a);
    await new Promise((r) => setTimeout(r, 80));
  }
}

function summarizeFrameMetrics(diag) {
  const fts = (diag?.frame_times ?? []).filter((x) => x > 0 && x < 5000);
  if (!fts.length) {
    return { fps_mean: 0, fps_p5: 0, frame_p95_ms: 0, frame_p99_ms: 0, stall_events: 0, long_frame_count: 0, jank_frames_over_33ms: 0, jank_frames_over_50ms: 0, sample_count: 0 };
  }
  const sorted = [...fts].sort((a, b) => a - b);
  const mean = fts.reduce((a, b) => a + b, 0) / fts.length;
  const fpsFromMean = mean > 0 ? 1000 / mean : 0;
  const fpsSamples = fts.map((dt) => (dt > 0 ? 1000 / dt : 0)).sort((a, b) => a - b);
  const fpsLow = percentile(fpsSamples, 0.05);
  return {
    fps_mean: Math.round(fpsFromMean * 10) / 10,
    fps_low: Math.round(fpsLow * 10) / 10,
    fps_p5: Math.round(fpsLow * 10) / 10,
    frame_p50_ms: Math.round(percentile(sorted, 0.5) * 100) / 100,
    frame_p95_ms: Math.round(percentile(sorted, 0.95) * 100) / 100,
    frame_p99_ms: Math.round(percentile(sorted, 0.99) * 100) / 100,
    stall_events: diag.stall_events ?? 0,
    long_frame_count: diag.long_frame_count ?? 0,
    jank_frames_over_33ms: diag.jank_frames_over_33ms ?? 0,
    jank_frames_over_50ms: diag.jank_frames_over_50ms ?? 0,
    first_visible_ms: diag.first_visible_ms ?? null,
    sample_count: fts.length,
  };
}

async function collectGpuStatus(page, headless) {
  return page.evaluate((headlessFlag) => {
    const out = {
      navigator_gpu: typeof navigator.gpu !== "undefined",
      webgl_renderer: null,
      webgl_vendor: null,
      is_swiftshader: false,
      is_angle: false,
      is_software_renderer: false,
    };
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      if (gl) {
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        if (dbg) {
          out.webgl_renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "";
          out.webgl_vendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || "";
        }
        const r = String(out.webgl_renderer || "").toLowerCase();
        out.is_swiftshader = r.includes("swiftshader");
        out.is_angle = r.includes("angle");
        out.is_software_renderer =
          out.is_swiftshader || r.includes("llvmpipe") || r.includes("software") || r.includes("microsoft basic");
      }
    } catch (e) {
      out.error = String(e?.message || e);
    }
    out.chrome_headless = headlessFlag;
    out.gpu_trace_confidence = headlessFlag || out.is_software_renderer ? "low" : "medium";
    return out;
  }, headless);
}

function deriveAttribution({ frame, net, trace, resourceTiming, gpuStatus, serverSummary }) {
  const reasons = [];
  let attribution = "unknown";
  let confidence = "low";

  const netP95 = Number(net.net_total_p95_ms) || 0;
  const mainMs = Number(trace.trace_main_script_ms) || 0;
  const gpuMs = (Number(trace.trace_gpu_ms) || 0) + (Number(trace.trace_composite_ms) || 0) + (Number(trace.trace_raster_ms) || 0);
  const longTasks = Number(trace.trace_longtask_count) || 0;
  const radLoads = Number(net.net_completed_request_count) || 0;
  const jank = Number(frame.jank_frames_over_33ms) || 0;
  const longFrames = Number(frame.long_frame_count) || 0;

  if (!trace.trace_ok) {
    reasons.push(`trace_ok=false:${trace.trace_error || "unknown"}`);
    if (radLoads > 50 && netP95 > 80) {
      attribution = "RAD Range loading";
      reasons.push("cdp_network_only_rad_streaming");
    }
    confidence = "low";
    return { attribution, attribution_confidence: confidence, reason: reasons.join(";") };
  }

  const scores = {
    rad: radLoads > 80 && netP95 > 70 ? netP95 : 0,
    main: mainMs + longTasks * 30,
    gpu: gpuMs,
  };
  if (longFrames > 5 || frame.fps_low < 20) scores.gpu += 50;

  const maxKey = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (maxKey === "rad" && scores.rad >= scores.main && scores.rad >= scores.gpu) {
    attribution = "RAD Range loading";
    reasons.push(`rad_requests=${radLoads}`, `net_total_p95_ms=${netP95.toFixed(0)}`);
    confidence = netP95 > 150 ? "high" : "medium";
  } else if (maxKey === "main" && scores.main > scores.gpu) {
    attribution = "main thread";
    reasons.push(`main_script_ms=${mainMs}`, `long_task_count=${longTasks}`);
    confidence = longTasks >= 3 ? "medium" : "low";
  } else if (maxKey === "gpu" && scores.gpu > 0) {
    attribution = "GPU/compositor";
    reasons.push(`gpu_ms=${gpuMs}`, `jank_frames=${jank}`);
    confidence = gpuStatus?.is_software_renderer ? "low" : "medium";
  } else if (scores.rad > 0 && (scores.main > 0 || scores.gpu > 0)) {
    attribution = "mixed";
    reasons.push(`scores_rad=${scores.rad}`, `scores_main=${scores.main}`, `scores_gpu=${scores.gpu}`);
    confidence = "medium";
  }

  if (resourceTiming && !resourceTiming.resource_timing_ok) {
    reasons.push("resource_timing_tao_or_zero_localhost");
  }
  if (gpuStatus?.is_software_renderer) {
    reasons.push("software_webgl_renderer");
  }
  if (serverSummary?.bottleneck) {
    const sb = serverSummary.bottleneck;
    if (sb.server_side_likely_bottleneck === false) {
      reasons.push("server_monitor:local_io_not_dominant");
    } else if (sb.server_side_likely_bottleneck === true) {
      reasons.push("server_monitor:local_io_contributes");
    }
  }

  return { attribution, attribution_confidence: confidence, reason: reasons.join(";") };
}

function buildStutterDiagMd({
  report,
  attribution,
  frame,
  net,
  trace,
  resourceTiming,
  gpuStatus,
  serverSummary,
}) {
  const traceLine = trace.trace_ok
    ? `main≈${trace.trace_main_script_ms}ms long_task=${trace.trace_longtask_count} layout+paint≈${trace.trace_layout_paint_ms}ms raster≈${trace.trace_raster_ms}ms composite≈${trace.trace_composite_ms}ms gpu≈${trace.trace_gpu_ms}ms`
    : `**失败** — \`${trace.trace_error || "unknown"}\``;

  return [
    "# 单用户本机卡顿诊断 · Coit Tower",
    "",
    `## 1. trace_ok = **${trace.trace_ok}**`,
    trace.trace_ok ? "" : `精确原因：\`${trace.trace_error}\`（详见 summary/trace_failure_diagnosis.md）`,
    "",
    "## 2. CDP Network（localhost .rad，非公网 RTT）",
    "",
    "| 指标 | 值 |",
    "|------|-----|",
    `| completed .rad requests | ${net.net_completed_request_count} |`,
    `| TTFB P50 / P95 | ${Math.round(net.net_ttfb_p50_ms)} / ${Math.round(net.net_ttfb_p95_ms)} ms |`,
    `| download P50 / P95 | ${Math.round(net.net_download_p50_ms)} / ${Math.round(net.net_download_p95_ms)} ms |`,
    `| network_total P50 / P95 | ${Math.round(net.net_total_p50_ms)} / ${Math.round(net.net_total_p95_ms)} ms |`,
    `| bytes (encoded) | ${(net.net_bytes / 1e6).toFixed(1)} MB |`,
    "",
    "## 3. Frame",
    "",
    "| 指标 | 值 |",
    "|------|-----|",
    `| fps_mean | ${frame.fps_mean} |`,
    `| fps_low (P5) | ${frame.fps_low ?? frame.fps_p5} |`,
    `| frame_time_p95 | ${frame.frame_p95_ms} ms |`,
    `| frames_over_33ms | ${frame.jank_frames_over_33ms} |`,
    `| frames_over_100ms | ${frame.long_frame_count} |`,
    "",
    "## 4. Chrome Trace",
    "",
    traceLine,
    "",
    trace.trace_ok
      ? [
          `| total_events | ${trace.total_events} |`,
          `| trace_file_size | ${((trace.trace_file_size || 0) / 1e6).toFixed(2)} MB |`,
          `| loading_event_ms (trace only, not primary net latency) | ${trace.loading_event_ms} ms |`,
        ].join("\n")
      : "未采集成功 — **不得**将 main/gpu/composite=0 解读为无负载。",
    "",
    "## 5. Server-side Monitor",
    "",
    serverSummary
      ? [
          "| 指标 | 值 | 判断 |",
          "|------|-----|------|",
          `| server_total P95 | ${serverSummary.request_level.server_total_p95_ms.toFixed(1)} ms | ${serverSummary.request_level.server_total_p95_ms < 80 ? "本机读盘+发送较快" : "服务端偏慢"} |`,
          `| server_ttfb P95 | ${serverSummary.request_level.server_ttfb_p95_ms.toFixed(1)} ms | — |`,
          `| node CPU P95 | ${serverSummary.process_level.node_cpu_p95_percent.toFixed(1)}% | ${serverSummary.process_level.node_cpu_p95_percent > 80 ? "Node 进程 CPU 偏高" : "不高"} |`,
          `| event loop delay P95 | ${serverSummary.process_level.event_loop_delay_p95_ms} ms | ${serverSummary.process_level.event_loop_delay_p95_ms > 50 ? "事件循环延迟偏高" : "正常"} |`,
          `| disk read P95 | ${serverSummary.system_level.disk_read_mbps_p95.toFixed(2)} MB/s | — |`,
          `| disk queue P95 | ${serverSummary.system_level.disk_queue_length_p95} | ${serverSummary.system_level.disk_queue_length_p95 > 2 ? "磁盘排队" : "正常"} |`,
          `| disk active P95 | ${serverSummary.system_level.disk_active_time_p95}% | — |`,
          `| server bottleneck? | ${serverSummary.bottleneck.server_side_likely_bottleneck} | ${serverSummary.bottleneck.reason} |`,
          "",
          serverSummary.bottleneck.server_side_likely_bottleneck === false
            ? "> server-side file serving is unlikely to be the dominant bottleneck; the dominant visible stalls are client-side processing/rendering."
            : "> server-side local file serving contributes to the observed latency and must be optimized before claiming client-side bottleneck.",
        ].join("\n")
      : "| — | monitor 缺失 | unknown |",
    "",
    "## 6. Attribution",
    "",
    `| 项 | 值 |`,
    `|----|-----|`,
    `| attribution | **${attribution.attribution}** |`,
    `| confidence | ${attribution.attribution_confidence} |`,
    `| reason | ${attribution.reason} |`,
    "",
    gpuStatus?.is_software_renderer
      ? "> GPU/rendering attribution is **low confidence** (SwiftShader/software renderer detected)."
      : "",
    "",
    "## 7. 运行配置",
    "",
    `- page: \`${report.page_url}\``,
    `- local RAD: \`${report.local_rad_path}\``,
    `- asset server: \`${report.asset_base}\` (127.0.0.1 loopback)`,
    `- duration: warmup ${report.phases.warmup_ms}ms + move ${report.phases.move_ms}ms`,
    `- chrome_headless: ${report.chrome_headless}`,
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function writeTraceFailureDiagnosis(summaryDir, diag) {
  const md = [
    "# trace_failure_diagnosis",
    "",
    `- trace_ok: false`,
    `- trace_error: \`${diag.trace_error}\``,
    `- tracing_complete_received: ${diag.tracing_complete_received ?? false}`,
    `- stream_read_bytes: ${diag.stream_read_bytes ?? 0}`,
    `- trace_file_size: ${diag.trace_file_size ?? 0}`,
    `- parser_error: ${diag.parser_error ?? ""}`,
    "",
    "## 根因说明",
    "",
    diag.root_cause || "见 trace_meta.json",
    "",
  ].join("\n");
  await fs.writeFile(path.join(summaryDir, "trace_failure_diagnosis.md"), md, "utf8");
}

function buildChineseVerdict({ attribution, frame, net, trace, reasons }) {
  const lines = [];
  const attr = attribution.latency_attribution;
  const conf = attribution.latency_attribution_confidence;

  lines.push(`## 结论：卡顿主因 → **${labelAttribution(attr)}**（置信度：${conf}）`, "");

  if (attr === "network") {
    lines.push(
      "页面在拉取本地 `.rad` 分块时，**HTTP 往返/下载耗时**占主导（CDP `network_total_ms` P95 偏高）。",
      "表现为：相机移动触发新 Range 请求时，帧时间尖峰与网络完成时间对齐。",
      "",
      "**建议**：确认本机 `http-server` 走 SSD、无杀毒实时扫描该 1.2GB 文件；对比 CDN/R2 与本地源的 P95；减小 `lodSplatScale` 或初始视锥负载。",
    );
  } else if (attr === "rendering_gpu") {
    lines.push(
      "**GPU/合成/光栅** 在 Chrome Trace 中累计时长高，且/或 **FPS 偏低、>33ms 帧占比高**（40M Coit 单用户仍可能吃满 GPU）。",
      "",
      "**建议**：降低 `renderer.setPixelRatio`（诊断页已跟 `highDpi`）；关其它 GPU 占用；用 `--headless=0` 对比有头/无头；检查 WebGL 是否落在独显。",
    );
  } else if (attr === "browser_main_thread") {
    lines.push(
      "**主线程长任务 / JS** 导致掉帧（Trace 中 `RunTask`/长任务多，网络 P95 相对不高）。",
      "",
      "**建议**：减少 GUI/控制台开销；确认 `dist/spark.module.js` 为本地构建非调试巨包；分段加载后观察是否缓解。",
    );
  } else if (attr === "mixed") {
    lines.push("网络与渲染/主线程 **同时有贡献**，无单一桶独占。建议先按下面分项表中最高的两项优化。");
  } else {
    lines.push(`信号不足或采集异常：${attribution.attribution_reason || reasons.join("; ")}`);
  }

  lines.push(
    "",
    "## 分项证据",
    "",
    "| 维度 | 关键指标 | 解读 |",
    "|------|----------|------|",
    `| 帧率/卡顿 | 平均 FPS≈${frame.fps_mean}，P5 FPS≈${frame.fps_p5}；P95 帧时≈${frame.frame_p95_ms}ms；>33ms 帧 ${frame.jank_frames_over_33ms} 次；>100ms 长帧 ${frame.long_frame_count} 次 | ${frame.fps_mean < 24 || frame.jank_frames_over_33ms > frame.sample_count * 0.15 ? "明显掉帧" : frame.fps_mean < 45 ? "轻度卡顿" : "帧率尚可"} |`,
    `| 网络(.rad) | 完成请求 ${net.net_completed_request_count}；TTFB P95≈${Math.round(net.net_ttfb_p95_ms)}ms；总耗时 P95≈${Math.round(net.net_total_p95_ms)}ms；下载字节≈${(net.net_bytes / 1e6).toFixed(1)}MB | ${net.net_total_p95_ms > 200 ? "分块延迟偏高" : net.net_completed_request_count === 0 ? "未观察到 .rad 完成（检查 URL/服务）" : "网络延迟不突出"} |`,
    `| Chrome Trace | main≈${Math.round(trace.trace_main_script_ms ?? 0)}ms layout≈${Math.round(trace.trace_layout_paint_ms ?? 0)}ms gpu≈${Math.round(trace.trace_gpu_ms ?? 0)}ms composite≈${Math.round(trace.trace_composite_ms ?? 0)}ms 长任务≈${trace.trace_longtask_count ?? 0} trace_ok=${trace.trace_ok} | ${!trace.trace_ok ? "Trace 未采集" : trace.trace_gpu_ms + trace.trace_composite_ms > trace.trace_main_script_ms ? "偏 GPU/合成" : trace.trace_main_script_ms > 80 ? "偏主线程" : "—"} |`,
    "",
    "## 归因说明",
    "",
    attribution.attribution_reason || "—",
  );
  return lines.join("\n");
}

function labelAttribution(a) {
  const map = {
    network: "网络（.rad Range 拉取）",
    rendering_gpu: "渲染 / GPU",
    browser_main_thread: "浏览器主线程",
    mixed: "混合",
    unknown: "未知",
    metrics_collection_bug: "指标采集异常",
  };
  return map[a] ?? a;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const serverMonitorEnabled = process.env.VRC_SERVER_MONITOR !== "0";
  await cleanupStaleProcesses();

  if (!existsSync(LOCAL_RAD)) {
    throw new Error(`本地 RAD 不存在: ${LOCAL_RAD}`);
  }
  const radStat = statSync(LOCAL_RAD);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = path.join(opts.outDir, ts);
  const summaryDir = path.join(runDir, "summary");
  const runId = SESSION_ID;
  await fs.mkdir(summaryDir, { recursive: true });

  const sessionT0 = Date.now();
  let procMon = null;
  let winMon = null;
  let assetSrv = null;
  let serverSummary = null;
  let pageSrv = null;
  let browser = null;

  console.log("[stutter-diag] 启动 instrumented asset server（Node Range + per-request log）…");
  assetSrv = await startMonitoredAssetServer(runDir, runId, opts.assetPort);
  if (serverMonitorEnabled) {
    procMon = new ServerProcessMonitor(runDir, { serverPid: assetSrv.pid });
    await procMon.start();
    winMon = new WindowsSystemMonitor(runDir, { nodePid: process.pid });
    await winMon.start();
  }
  const { outFile: patchedHtml } = await buildPatchedHtml(assetSrv.base);

  const pathOverrides = new Map();
  pathOverrides.set("/examples/streaming-lod/index.html", patchedHtml);
  pageSrv = await startPageStaticServer(opts.pagePort, pathOverrides);
  const pageUrl = `${pageSrv.base}/examples/streaming-lod/index.html?world=${encodeURIComponent("Coit Tower, SF")}`;

  console.log(`[stutter-diag] 资源根: ${assetSrv.base} (pid=${assetSrv.pid}, ${assetSrv.implementation})`);
  console.log(`[stutter-diag] server log: ${assetSrv.requestLogPath}`);
  console.log(`[stutter-diag] 页面: ${pageUrl}`);

  const meta = { userId: "u0", sessionId: SESSION_ID, method: "LocalDiag", scenario: "nearby", trial: 0 };
  const chromeArgs = [
    "--disable-dev-shm-usage",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--enable-unsafe-webgpu",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--autoplay-policy=no-user-gesture-required",
  ];
  if (opts.headless) chromeArgs.push("--headless=new");

  browser = await chromium.launch({
    headless: opts.headless,
    args: chromeArgs,
  });

  let netAuditor = null;
  let traceRec = null;
  let frameSnap = {};
  let gpuStatus = null;
  let phase = "init";
  const rtProbePath = path.join(projectRoot, "vrc-paper", "client_instrument", "resource_timing_probe.js");

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    if (existsSync(rtProbePath)) {
      await page.addInitScript({ path: rtProbePath });
    }
    const cdpNet = await context.newCDPSession(page);
    netAuditor = new CdpNetworkAuditor(cdpNet, meta);
    await netAuditor.start();
    traceRec = await attachLocalStutterTraceCollector(page, {
      userId: "u0",
      runDir,
      headless: opts.headless,
      chromeExecutable: chromium.executablePath?.() ?? "",
    });

    phase = "load";
    page.on("pageerror", (err) => console.error("[stutter-diag] pageerror:", err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") console.error("[stutter-diag] console:", msg.text());
    });

    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 180_000 });
    await page.waitForFunction(() => window.__slDiagCam != null && window.__stutterDiag != null, undefined, {
      timeout: 300_000,
    });
    gpuStatus = await collectGpuStatus(page, opts.headless);
    await fs.writeFile(path.join(summaryDir, "gpu_status.json"), `${JSON.stringify(gpuStatus, null, 2)}\n`, "utf8");

    phase = "warmup";
    console.log(`[stutter-diag] 预热 ${opts.warmupMs}ms…`);
    await new Promise((r) => setTimeout(r, opts.warmupMs));

    phase = "move";
    console.log(`[stutter-diag] 环绕相机 ${opts.phaseMs}ms（触发 LoD Range）…`);
    await orbitCamera(page, opts.phaseMs);

    frameSnap = await page.evaluate(() => {
      const d = window.__stutterDiag || {};
      return {
        frame_times: d.frame_times ? [...d.frame_times] : [],
        stall_events: d.stall_events ?? 0,
        long_frame_count: d.long_frame_count ?? 0,
        jank_frames_over_33ms: d.jank_frames_over_33ms ?? 0,
        jank_frames_over_50ms: d.jank_frames_over_50ms ?? 0,
        first_visible_ms: d.first_visible_ms ?? null,
        splat_mesh_ready: d.splat_mesh_ready ?? false,
      };
    });

    await netAuditor.stop();
    await page.waitForTimeout(3000);
    const traceSummary = await traceRec.stop({ flushMs: 0 });

    const cdpRows = netAuditor.getCsvRows();
    writeAuditCsv(cdpRows, path.join(runDir, "cdp_network_audit.csv"));
    const net = summarizeCdpNetworkAudit(cdpRows, "u0");
    const frame = summarizeFrameMetrics(frameSnap);

    const rtEntries = await page.evaluate(() => {
      if (typeof window.__vrcFlushResourceTimingAudit === "function") {
        window.__vrcFlushResourceTimingAudit();
      }
      return window.__vrcResourceTimingAudit || [];
    }).catch(() => []);
    const rtRows = resourceTimingRowsFromPageEntries(rtEntries, meta);
    writeResourceTimingAuditCsv(rtRows, path.join(runDir, "resource_timing_audit.csv"));
    const resourceTiming = summarizeResourceTiming(rtRows, "u0");

    const viewportLatencies = await page.evaluate(() => {
      return window.__stutterDiag?.first_visible_ms != null
        ? performance.now() - window.__stutterDiag.first_visible_ms
        : null;
    }).catch(() => null);

    const legacyAttribution = computeLatencyAttribution({
      net_total_p95_ms: net.net_total_p95_ms,
      p95_latency_ms: net.net_total_p95_ms,
      viewport_to_visible_latency_ms: viewportLatencies,
      trace_main_script_ms: traceSummary.trace_main_script_ms ?? 0,
      trace_long_task_count: traceSummary.trace_longtask_count ?? 0,
      trace_layout_paint_ms: traceSummary.trace_layout_paint_ms ?? 0,
      trace_composite_ms: traceSummary.trace_composite_ms ?? 0,
      trace_gpu_ms: traceSummary.trace_gpu_ms ?? 0,
      trace_raster_ms: traceSummary.trace_raster_ms ?? 0,
      fps: frame.fps_mean,
      resource_timing_ok: resourceTiming.resource_timing_ok,
      trace_ok: !!traceSummary.trace_ok,
      net_completed_request_count: net.net_completed_request_count,
      playwright_chunk_rows: 0,
      net_zero_encoded_length_count: net.net_zero_encoded_length_count,
    });

    let serverRows = assetSrv.srv.requestRows?.length ? assetSrv.srv.requestRows : [];
    if (assetSrv.srv.server) {
      serverRows = await assetSrv.srv.stop();
      assetSrv.srv.server = null;
    }
    const processRows = procMon ? await procMon.stop() : [];
    procMon = null;
    if (winMon) await winMon.stop();
    winMon = null;
    const windowsRows = parseSimpleCsv(path.join(runDir, "server_monitor", "windows_system_monitor.csv"));

    const monitorArtifacts = await writeServerMonitorArtifacts(runDir, summaryDir, {
      serverRows,
      processRows,
      windowsRows,
      cdpRows,
      sessionDurationMs: Date.now() - sessionT0,
      clientNetP95: net.net_total_p95_ms,
    });
    serverSummary = monitorArtifacts.summary;

    const customAttribution = deriveAttribution({
      frame,
      net,
      trace: traceSummary,
      resourceTiming,
      gpuStatus,
      serverSummary,
    });
    if (serverSummary?.bottleneck?.server_side_likely_bottleneck === false) {
      if (customAttribution.attribution === "RAD Range loading") {
        customAttribution.attribution = "main thread";
        customAttribution.reason += ";server_monitor_exonerates_local_io";
      }
    }

    if (!traceSummary.trace_ok) {
      await writeTraceFailureDiagnosis(summaryDir, {
        trace_error: traceSummary.trace_error,
        tracing_complete_received: traceSummary.trace_meta?.tracing_complete_received,
        stream_read_bytes: traceSummary.trace_meta?.stream_read_bytes,
        trace_file_size: traceSummary.trace_meta?.trace_file_size,
        parser_error: traceSummary.trace_meta?.parser_error,
        root_cause:
          "Tracing.end 未与 Tracing.tracingComplete 配对，或 stream/文件过小。上一轮同类问题见 2026-05-19T03-50-46/summary/trace_failure_diagnosis.md",
      });
    }

    const report = {
      generated_at: new Date().toISOString(),
      title: "单用户本机卡顿诊断 · Coit Tower",
      session_id: SESSION_ID,
      page_url: pageUrl,
      local_rad_path: LOCAL_RAD,
      local_rad_bytes: radStat.size,
      asset_base: assetSrv.base,
      chrome_headless: opts.headless,
      phases: { warmup_ms: opts.warmupMs, move_ms: opts.phaseMs },
      frame_metrics: frame,
      network_summary: net,
      resource_timing_summary: resourceTiming,
      trace_summary: traceSummary,
      gpu_status: gpuStatus,
      latency_attribution: legacyAttribution,
      attribution: customAttribution,
      trace_ok: !!traceSummary.trace_ok,
      trace_error: traceSummary.trace_error || "",
      server_monitor: serverSummary,
      asset_server: {
        implementation: assetSrv.implementation,
        pid: assetSrv.pid,
        port: assetSrv.port,
        request_log: assetSrv.requestLogPath,
      },
    };

    const jsonPath = path.join(summaryDir, "stutter_diag.json");
    await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    const mdPath = path.join(summaryDir, "stutter_diag.md");
    await fs.writeFile(
      mdPath,
      buildStutterDiagMd({
        report,
        attribution: customAttribution,
        frame,
        net,
        trace: traceSummary,
        resourceTiming,
        gpuStatus,
        serverSummary,
      }),
      "utf8",
    );
    const mdPathCn = path.join(summaryDir, "卡顿归因报告.md");
    await fs.writeFile(mdPathCn, buildChineseVerdict({
      attribution: legacyAttribution,
      frame,
      net,
      trace: traceSummary,
      reasons: [legacyAttribution.attribution_reason],
    }), "utf8");

    console.log("\n========== 单用户本机卡顿诊断 ==========");
    console.log(`trace_ok: ${traceSummary.trace_ok}`);
    if (!traceSummary.trace_ok) console.log(`trace_error: ${traceSummary.trace_error}`);
    console.log(`归因: ${customAttribution.attribution} (${customAttribution.attribution_confidence})`);
    console.log(`FPS≈${frame.fps_mean}  fps_low≈${frame.fps_low}  P95帧时≈${frame.frame_p95_ms}ms`);
    console.log(`网络: ${net.net_completed_request_count} 次 .rad, P95≈${Math.round(net.net_total_p95_ms)}ms (localhost)`);
    if (traceSummary.trace_ok) {
      console.log(
        `Trace: main=${traceSummary.trace_main_script_ms}ms gpu=${traceSummary.trace_gpu_ms}ms composite=${traceSummary.trace_composite_ms}ms long_tasks=${traceSummary.trace_longtask_count}`,
      );
      console.log(`trace size: ${((traceSummary.trace_file_size || 0) / 1e6).toFixed(2)} MB`);
    }
    if (serverSummary) {
      console.log(
        `Server: rad=${serverSummary.request_level.total_rad_requests} P95=${serverSummary.request_level.server_total_p95_ms.toFixed(1)}ms node_cpu_p95=${serverSummary.process_level.node_cpu_p95_percent.toFixed(1)}% bottleneck=${serverSummary.bottleneck.server_side_likely_bottleneck}`,
      );
    }
    console.log(`报告: ${mdPath}`);
    console.log("========================================\n");

    if (!traceSummary.trace_ok) {
      process.exitCode = 1;
    }

    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (procMon) await procMon.stop().catch(() => {});
    if (winMon) await winMon.stop().catch(() => {});
    if (assetSrv?.srv?.server) await assetSrv.srv.stop().catch(() => {});
    if (pageSrv?.server) await new Promise((res) => pageSrv.server.close(() => res()));
  }
}

main().catch((e) => {
  console.error(`[stutter-diag] 失败 (phase=${typeof phase !== "undefined" ? phase : "?"}):`, e);
  process.exitCode = 1;
});
