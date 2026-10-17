/**
 * Ablation v2 — small validation matrix (instrumentation fixes).
 *
 *   node scripts/run-local-stutter-ablation-v2.mjs [--warmupMs=20000] [--moveMs=40000]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runAblationCell,
  cleanupStaleAblationProcesses,
} from "./lib/local_stutter_ablation_cell.mjs";
import { writeSummaryCsv } from "./lib/local_stutter_ablation_metrics.mjs";
import { writeDiagnosisDecisionV2 } from "./lib/local_stutter_ablation_decision_v2.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const V2_EXPERIMENTS = [
  {
    id: "E2",
    headless: false,
    mode: "normal",
    pixelRatio: "auto",
    label: "headed normal",
    phasedMeasure: true,
  },
  {
    id: "E5b",
    headless: false,
    mode: "fetch_only_full",
    pixelRatio: "auto",
    label: "headed fetch_only_full",
    fullReplay: true,
  },
  {
    id: "E6b",
    headless: false,
    mode: "parse_only_full",
    pixelRatio: "auto",
    label: "headed parse_only_full",
    fullReplay: true,
  },
  {
    id: "E7b",
    headless: false,
    mode: "upload_only",
    pixelRatio: "auto",
    label: "headed upload_only_fixed",
    phasedMeasure: true,
  },
  {
    id: "E8b",
    headless: false,
    mode: "render_only_pure",
    pixelRatio: "auto",
    label: "headed render_only_pure",
    pureRenderPreload: true,
  },
  {
    id: "E9b",
    headless: false,
    mode: "static_camera_render_only_pure",
    pixelRatio: "auto",
    label: "headed static_camera_render_only_pure",
    pureRenderPreload: true,
  },
  {
    id: "E10b",
    headless: false,
    mode: "moving_camera_render_only_pure",
    pixelRatio: "auto",
    label: "headed moving_camera_render_only_pure",
    pureRenderPreload: true,
  },
  {
    id: "E4b",
    headless: false,
    mode: "normal",
    pixelRatio: "0.5",
    label: "headed pixelRatio=0.5 stable measure",
    phasedMeasure: true,
  },
];

function parseArgs(argv) {
  const o = { only: null, warmupMs: 20_000, moveMs: 40_000, basePort: 19300 };
  for (const arg of argv) {
    if (arg.startsWith("--only=")) o.only = new Set(arg.slice(7).split(",").map((s) => s.trim()));
    else if (arg.startsWith("--warmupMs=")) o.warmupMs = Number.parseInt(arg.slice(11), 10);
    else if (arg.startsWith("--moveMs=")) o.moveMs = Number.parseInt(arg.slice(9), 10);
    else if (arg.startsWith("--basePort=")) o.basePort = Number.parseInt(arg.slice(11), 10);
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await cleanupStaleAblationProcesses();

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const batchDir = path.join(projectRoot, "260506_local_diag", "single_user_ablation_v2", ts);
  await fs.mkdir(batchDir, { recursive: true });

  const summaryRows = [];
  let portOff = 0;

  const experiments = opts.only
    ? V2_EXPERIMENTS.filter((e) => opts.only.has(e.id))
    : V2_EXPERIMENTS;

  for (const exp of experiments) {
    const runDir = path.join(batchDir, `${exp.id}_${exp.mode}`);
    await fs.mkdir(runDir, { recursive: true });
    console.log(`\n[ablation-v2] ===== ${exp.id} ${exp.label} =====`);
    try {
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
        `[ablation-v2] ${exp.id} measure_fps=${row.measure_fps_mean} fetch_req=${row.total_fetch_requests} upload_calls=${row.upload_call_count} measure_rad=${row.measure_rad_requests} pure_ok=${row.pure_render_valid}`,
      );
    } catch (e) {
      console.error(`[ablation-v2] ${exp.id} FAILED:`, e);
      summaryRows.push({
        experiment_id: exp.id,
        diagnosis_label: exp.mode,
        run_dir: runDir,
        trace_ok: false,
        error: String(e?.message || e),
      });
    }
    portOff += 3;
  }

  await writeSummaryCsv(summaryRows, path.join(batchDir, "ablation_summary.csv"));
  await fs.writeFile(
    path.join(batchDir, "ablation_summary.json"),
    `${JSON.stringify(summaryRows, null, 2)}\n`,
  );
  await writeDiagnosisDecisionV2(summaryRows, path.join(batchDir, "diagnosis_decision_v2.md"));

  console.log(`\n[ablation-v2] complete → ${batchDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
