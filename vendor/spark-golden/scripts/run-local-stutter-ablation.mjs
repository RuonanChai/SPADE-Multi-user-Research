/**
 * Single-user stutter ablation matrix E1–E10.
 *
 *   node scripts/run-local-stutter-ablation.mjs [--only=E1,E2] [--warmupMs=20000] [--moveMs=40000]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runAblationCell,
  cleanupStaleAblationProcesses,
} from "./lib/local_stutter_ablation_cell.mjs";
import {
  writeSummaryCsv,
} from "./lib/local_stutter_ablation_metrics.mjs";
import { writeDiagnosisDecision } from "./lib/local_stutter_ablation_decision.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const EXPERIMENTS = [
  { id: "E1", headless: true, mode: "normal", pixelRatio: "auto", label: "headless normal" },
  { id: "E2", headless: false, mode: "normal", pixelRatio: "auto", label: "headed normal" },
  { id: "E3", headless: false, mode: "normal", pixelRatio: "1", label: "headed normal pixelRatio=1" },
  { id: "E4", headless: false, mode: "normal", pixelRatio: "0.5", label: "headed normal pixelRatio=0.5" },
  { id: "E5", headless: false, mode: "fetch_only", pixelRatio: "auto", label: "headed fetch_only" },
  { id: "E6", headless: false, mode: "parse_only", pixelRatio: "auto", label: "headed parse_only" },
  { id: "E7", headless: false, mode: "upload_only", pixelRatio: "auto", label: "headed upload_only" },
  { id: "E8", headless: false, mode: "render_only", pixelRatio: "auto", label: "headed render_only" },
  {
    id: "E9",
    headless: false,
    mode: "static_camera_render_only",
    pixelRatio: "auto",
    label: "headed static_camera_render_only",
  },
  {
    id: "E10",
    headless: false,
    mode: "moving_camera_render_only",
    pixelRatio: "auto",
    label: "headed moving_camera_render_only",
  },
];

function parseArgs(argv) {
  const o = { only: null, warmupMs: 20_000, moveMs: 40_000, basePort: 19200 };
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
  const batchDir = path.join(projectRoot, "260506_local_diag", "single_user_ablation", ts);
  await fs.mkdir(batchDir, { recursive: true });

  const experiments = opts.only
    ? EXPERIMENTS.filter((e) => opts.only.has(e.id))
    : EXPERIMENTS;

  const summaryRows = [];
  let portOff = 0;

  for (const exp of experiments) {
    const runDir = path.join(batchDir, `${exp.id}_${exp.mode}`);
    await fs.mkdir(runDir, { recursive: true });
    console.log(`\n[ablation] ===== ${exp.id} ${exp.label} =====`);
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
      });
      summaryRows.push(row);
      console.log(
        `[ablation] ${exp.id} done fps=${row.fps_mean} server_p95=${row.server_total_p95_ms} net_p95=${row.client_network_total_p95_ms} trace_ok=${row.trace_ok}`,
      );
    } catch (e) {
      console.error(`[ablation] ${exp.id} FAILED:`, e);
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

  const csvPath = path.join(batchDir, "ablation_summary.csv");
  await writeSummaryCsv(summaryRows, csvPath);
  await fs.writeFile(
    path.join(batchDir, "ablation_summary.json"),
    `${JSON.stringify(summaryRows, null, 2)}\n`,
  );
  const summaryDir = path.join(batchDir, "summary");
  await fs.mkdir(summaryDir, { recursive: true });
  await writeDiagnosisDecision(summaryRows, path.join(batchDir, "diagnosis_decision.md"));
  await writeDiagnosisDecision(summaryRows, path.join(summaryDir, "diagnosis_decision.md"));

  console.log(`\n[ablation] batch complete → ${batchDir}`);
  console.log(`[ablation] ${csvPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
