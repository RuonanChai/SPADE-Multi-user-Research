/**
 * Full single-user ablation E0–E10 on NVIDIA (RTX 4070).
 *
 *   node scripts/run-local-stutter-ablation-e0-e10.mjs
 *   node scripts/run-local-stutter-ablation-e0-e10.mjs --only=E0,E2,E8
 */
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  runAblationCell,
  cleanupStaleAblationProcesses,
  startPageStaticServer,
  startMonitoredAssetServer,
} from "./lib/local_stutter_ablation_cell.mjs";
import { buildAblationHtml } from "./lib/local_stutter_ablation_html.mjs";
import { collectGpuBackend } from "./lib/local_stutter_ablation_gpu_backend.mjs";
import { writeSummaryCsv } from "./lib/local_stutter_ablation_metrics.mjs";
import { writeDiagnosisDecisionE0E10 } from "./lib/local_stutter_ablation_decision_e0_e10.mjs";
import { writeFinalReport } from "./lib/local_stutter_ablation_final_report.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const CHROME_ARGS = [
  "--disable-dev-shm-usage",
  "--enable-gpu",
  "--ignore-gpu-blocklist",
  "--force-high-performance-gpu",
  "--use-angle=d3d11",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
];

/** E0 = GPU 环境基线；E1–E10 = 完整消融（v2 instrumentation where applicable） */
const EXPERIMENTS = [
  { id: "E0", kind: "gpu_baseline", label: "GPU / Playwright 环境基线" },
  { id: "E1", kind: "cell", headless: true, mode: "normal", pixelRatio: "auto", label: "headless normal" },
  { id: "E2", kind: "cell", headless: false, mode: "normal", pixelRatio: "auto", label: "headed normal", phasedMeasure: true },
  { id: "E3", kind: "cell", headless: false, mode: "normal", pixelRatio: "1", label: "headed pixelRatio=1", phasedMeasure: true },
  { id: "E4", kind: "cell", headless: false, mode: "normal", pixelRatio: "0.5", label: "headed pixelRatio=0.5", phasedMeasure: true },
  { id: "E5", kind: "cell", headless: false, mode: "fetch_only_full", pixelRatio: "auto", label: "headed fetch_only_full", fullReplay: true },
  { id: "E6", kind: "cell", headless: false, mode: "parse_only_full", pixelRatio: "auto", label: "headed parse_only_full", fullReplay: true },
  { id: "E7", kind: "cell", headless: false, mode: "upload_only", pixelRatio: "auto", label: "headed upload_only", phasedMeasure: true },
  { id: "E8", kind: "cell", headless: false, mode: "render_only_pure", pixelRatio: "auto", label: "headed render_only_pure", pureRenderPreload: true },
  { id: "E9", kind: "cell", headless: false, mode: "static_camera_render_only_pure", pixelRatio: "auto", label: "headed static_camera pure", pureRenderPreload: true },
  { id: "E10", kind: "cell", headless: false, mode: "moving_camera_render_only_pure", pixelRatio: "auto", label: "headed moving_camera pure", pureRenderPreload: true },
];

function parseArgs(argv) {
  const o = { only: null, warmupMs: 20_000, moveMs: 40_000, basePort: 19400 };
  for (const arg of argv) {
    if (arg.startsWith("--only=")) o.only = new Set(arg.slice(7).split(",").map((s) => s.trim()));
    else if (arg.startsWith("--warmupMs=")) o.warmupMs = Number.parseInt(arg.slice(11), 10);
    else if (arg.startsWith("--moveMs=")) o.moveMs = Number.parseInt(arg.slice(9), 10);
    else if (arg.startsWith("--basePort=")) o.basePort = Number.parseInt(arg.slice(11), 10);
  }
  return o;
}

function attachBatchLogger(batchDir) {
  const logPath = path.join(batchDir, "batch_run.log");
  const stream = createWriteStream(logPath, { flags: "a" });
  const stamp = () => new Date().toISOString();
  const write = (level, args) => {
    const line = `[${stamp()}] [${level}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
    stream.write(line);
  };
  const orig = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console),
  };
  console.log = (...a) => {
    orig.log(...a);
    write("INFO", a);
  };
  console.error = (...a) => {
    orig.error(...a);
    write("ERROR", a);
  };
  console.warn = (...a) => {
    orig.warn(...a);
    write("WARN", a);
  };
  return { logPath, close: () => stream.end() };
}

async function runE0GpuBaseline({ runDir, assetPort }) {
  const summaryDir = path.join(runDir, "summary");
  await fs.mkdir(summaryDir, { recursive: true });

  const assetSrv = await startMonitoredAssetServer(runDir, "E0", assetPort);
  const pathOverrides = new Map();
  const { outFile: patchedHtml } = await buildAblationHtml({
    assetBase: assetSrv.base,
    ablationMode: "normal",
    pixelRatio: "auto",
    label: "E0",
  });
  pathOverrides.set("/examples/streaming-lod/index.html", patchedHtml);
  const pageSrv = await startPageStaticServer(0, pathOverrides);
  const pageUrl = new URL(`${pageSrv.base}/examples/streaming-lod/index.html`);
  pageUrl.searchParams.set("world", "Coit Tower, SF");
  pageUrl.searchParams.set("ablation_mode", "normal");

  const browser = await chromium.launch({ headless: false, args: CHROME_ARGS });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(pageUrl.toString(), { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForFunction(() => window.__slDiagCam != null, undefined, { timeout: 120_000 });
    await page.waitForTimeout(2000);
    const gpuBackend = await collectGpuBackend(page, { headless: false });
    const playwrightChrome = chromium.executablePath();
    await fs.writeFile(path.join(runDir, "gpu_backend.json"), `${JSON.stringify({ ...gpuBackend, playwright_chrome: playwrightChrome }, null, 2)}\n`);

    const row = {
      experiment_id: "E0",
      diagnosis_label: "gpu_baseline",
      ablation_mode: "gpu_baseline",
      run_dir: runDir,
      headed: true,
      pixel_ratio: "auto",
      trace_ok: false,
      measure_fps_mean: null,
      fps_mean: null,
      playwright_chrome: playwrightChrome,
      ...gpuBackend,
      nvidia_active: /nvidia|geforce|rtx/i.test(gpuBackend.webgl_renderer || ""),
    };
    await fs.writeFile(path.join(summaryDir, "experiment_summary.json"), `${JSON.stringify(row, null, 2)}\n`);
    await assetSrv.srv.stop();
    return { row };
  } finally {
    await browser.close();
    if (pageSrv?.server) await new Promise((r) => pageSrv.server.close(() => r()));
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await cleanupStaleAblationProcesses();

  const startedAt = new Date().toISOString();
  const ts = startedAt.replace(/[:.]/g, "-").slice(0, 19);
  const batchDir = path.join(projectRoot, "260506_local_diag", "single_user_ablation_nvidia_e0_e10", ts);
  await fs.mkdir(batchDir, { recursive: true });

  const logger = attachBatchLogger(batchDir);
  console.log(`[e0-e10] batch_dir=${batchDir}`);
  console.log(`[e0-e10] chrome_args=${CHROME_ARGS.join(" ")}`);

  const experiments = opts.only ? EXPERIMENTS.filter((e) => opts.only.has(e.id)) : EXPERIMENTS;
  const summaryRows = [];
  let portOff = 0;

  for (const exp of experiments) {
    const runDir = path.join(batchDir, `${exp.id}_${exp.kind === "gpu_baseline" ? "gpu_baseline" : exp.mode}`);
    await fs.mkdir(runDir, { recursive: true });
    console.log(`\n[e0-e10] ===== ${exp.id} ${exp.label} =====`);
    const t0 = Date.now();
    try {
      if (exp.kind === "gpu_baseline") {
        const { row } = await runE0GpuBaseline({ runDir, assetPort: opts.basePort + portOff });
        summaryRows.push(row);
        console.log(`[e0-e10] ${exp.id} renderer=${row.webgl_renderer} nvidia=${row.nvidia_active}`);
      } else {
        const { row } = await runAblationCell({
          experimentId: exp.id,
          runDir,
          ablationMode: exp.mode,
          headless: exp.headless,
          pixelRatio: exp.pixelRatio,
          warmupMs: opts.warmupMs,
          moveMs: opts.moveMs,
          traceChrome: process.env.VRC_TRACE_CHROME !== "0" && process.env.VRC_TRACE_CHROME !== "false",
          assetPort: opts.basePort + portOff,
          phasedMeasure: exp.phasedMeasure,
          pureRenderPreload: exp.pureRenderPreload,
          fullReplay: exp.fullReplay,
        });
        summaryRows.push(row);
        console.log(
          `[e0-e10] ${exp.id} done measure_fps=${row.measure_fps_mean ?? row.fps_mean} preload_fps=${row.preload_fps_mean ?? "—"} server_p95=${row.server_total_p95_ms} gpu=${String(row.webgl_renderer || "").slice(0, 48)} pure_ok=${row.pure_render_valid ?? "—"} elapsed_s=${Math.round((Date.now() - t0) / 1000)}`,
        );
      }
    } catch (e) {
      console.error(`[e0-e10] ${exp.id} FAILED:`, e);
      summaryRows.push({
        experiment_id: exp.id,
        diagnosis_label: exp.mode || exp.kind,
        run_dir: runDir,
        trace_ok: false,
        error: String(e?.message || e),
      });
    }
    portOff += 3;
  }

  const finishedAt = new Date().toISOString();
  await writeSummaryCsv(summaryRows, path.join(batchDir, "ablation_summary.csv"));
  await fs.writeFile(path.join(batchDir, "ablation_summary.json"), `${JSON.stringify(summaryRows, null, 2)}\n`);
  await writeDiagnosisDecisionE0E10(summaryRows, path.join(batchDir, "diagnosis_decision_e0_e10.md"));
  await writeFinalReport({ rows: summaryRows, batchDir, startedAt, finishedAt }, path.join(batchDir, "final_report.md"));

  console.log(`\n[e0-e10] ===== BATCH COMPLETE =====`);
  console.log(`[e0-e10] ${batchDir}`);
  console.log(`[e0-e10] final_report.md`);
  console.log(`[e0-e10] batch_run.log`);
  logger.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
