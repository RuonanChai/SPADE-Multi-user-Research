/**
 * RTX 4070 optimization + diagnostic batch.
 *
 *   node scripts/run-local-stutter-ablation-optimization-rtx4070.mjs
 */
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { runAblationCell, cleanupStaleAblationProcesses } from "./lib/local_stutter_ablation_cell.mjs";
import { writeSummaryCsv } from "./lib/local_stutter_ablation_metrics.mjs";
import {
  buildOptimizationTrialRow,
  aggregateOptimizationByArm,
} from "./lib/local_stutter_optimization_row.mjs";
import { writeOptimizationReport } from "./lib/local_stutter_optimization_report.mjs";
import { writeOptimizationFigures } from "./lib/local_stutter_optimization_figures.mjs";
import { NVIDIA_CHROME_ARGS, NVIDIA_CHROMIUM_LAUNCH } from "./lib/local_stutter_nvidia_chrome.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const ARMS = [
  {
    id: "E3_normal_baseline",
    name: "E3 headed normal DPR=1 baseline",
    group: "baseline",
    trials: 3,
    cell: { experimentId: "E3_baseline", mode: "normal", pixelRatio: "1", phasedMeasure: true },
  },
  {
    id: "E4_dpr05_baseline",
    name: "E4 headed normal DPR=0.5 baseline",
    group: "baseline",
    trials: 3,
    cell: { experimentId: "E4_baseline", mode: "normal", pixelRatio: "0.5", phasedMeasure: true },
  },
  {
    id: "E8_pure_baseline",
    name: "E8 render_only_pure baseline",
    group: "baseline",
    trials: 3,
    cell: {
      experimentId: "E8_baseline",
      mode: "render_only_pure",
      pixelRatio: "auto",
      pureRenderPreload: true,
    },
  },
  {
    id: "E9_static_pure_baseline",
    name: "E9 static pure baseline",
    group: "baseline",
    trials: 3,
    cell: {
      experimentId: "E9_baseline",
      mode: "static_camera_render_only_pure",
      pixelRatio: "auto",
      pureRenderPreload: true,
    },
  },
  {
    id: "E10_moving_pure_baseline",
    name: "E10 moving pure baseline",
    group: "baseline",
    trials: 3,
    cell: {
      experimentId: "E10_baseline",
      mode: "moving_camera_render_only_pure",
      pixelRatio: "auto",
      pureRenderPreload: true,
    },
  },
  {
    id: "O1_E3_adaptive_dpr_only",
    name: "E3 + adaptive DPR",
    group: "optimized",
    trials: 3,
    vrcOpt: { adaptiveDpr: true },
    cell: { experimentId: "O1", mode: "normal", pixelRatio: "1", phasedMeasure: true },
  },
  {
    id: "O2_E3_splat_budget_only",
    name: "E3 + splat budget",
    group: "optimized",
    trials: 3,
    vrcOpt: { splatBudget: true },
    cell: { experimentId: "O2", mode: "normal", pixelRatio: "1", phasedMeasure: true },
  },
  {
    id: "O3_E3_lod_throttle_only",
    name: "E3 + LoD throttle",
    group: "optimized",
    trials: 3,
    vrcOpt: { lodThrottle: true },
    cell: { experimentId: "O3", mode: "normal", pixelRatio: "1", phasedMeasure: true },
  },
  {
    id: "O4_E3_adaptive_dpr_plus_splat_budget",
    name: "E3 + adaptive DPR + splat budget",
    group: "optimized",
    trials: 3,
    vrcOpt: { adaptiveDpr: true, splatBudget: true },
    cell: { experimentId: "O4", mode: "normal", pixelRatio: "1", phasedMeasure: true },
  },
  {
    id: "O5_E3_all_optimizations",
    name: "E3 + all optimizations",
    group: "optimized",
    trials: 3,
    vrcOpt: { adaptiveDpr: true, splatBudget: true, lodThrottle: true },
    cell: { experimentId: "O5", mode: "normal", pixelRatio: "1", phasedMeasure: true },
  },
  {
    id: "D1_render_plus_camera_only",
    name: "render + camera, no dynamic LoD",
    group: "diagnostic",
    trials: 1,
    cell: {
      experimentId: "D1",
      mode: "render_plus_camera_only",
      pixelRatio: "auto",
      pureRenderPreload: true,
    },
  },
  {
    id: "D2_render_plus_visibility_only",
    name: "render + visibility (approx)",
    group: "diagnostic",
    trials: 1,
    cell: {
      experimentId: "D2",
      mode: "render_plus_visibility_only",
      pixelRatio: "auto",
      pureRenderPreload: true,
    },
  },
  {
    id: "D3_render_plus_lod_update_only",
    name: "render + LoD update only",
    group: "diagnostic",
    trials: 1,
    cell: {
      experimentId: "D3",
      mode: "render_plus_lod_update_only",
      pixelRatio: "auto",
      pureRenderPreload: true,
    },
  },
  {
    id: "D4_normal_fixed_lod",
    name: "normal fixed LoD during measure",
    group: "diagnostic",
    trials: 1,
    cell: { experimentId: "D4", mode: "normal_fixed_lod", pixelRatio: "1", phasedMeasure: true },
  },
];

function attachLogger(rawDir) {
  const logPath = path.join(rawDir, "batch_run.log");
  const stream = createWriteStream(logPath, { flags: "a" });
  const stamp = () => new Date().toISOString();
  const write = (level, args) => {
    stream.write(`[${stamp()}] [${level}] ${args.map(String).join(" ")}\n`);
  };
  const orig = { log: console.log, error: console.error };
  console.log = (...a) => {
    orig.log(...a);
    write("INFO", a);
  };
  console.error = (...a) => {
    orig.error(...a);
    write("ERROR", a);
  };
  return { close: () => stream.end() };
}

function fmt(n, d = 1) {
  if (n == null || !Number.isFinite(n)) return "—";
  return Number(n).toFixed(d);
}

async function main() {
  const opts = { warmupMs: 20_000, moveMs: 40_000, basePort: 19700 };
  await cleanupStaleAblationProcesses();

  const startedAt = new Date().toISOString();
  const ts = startedAt.replace(/[:.]/g, "-").slice(0, 19);
  const batchDir = path.join(projectRoot, "260506_local_diag", "single_user_optimization_rtx4070", ts);
  const rawDir = path.join(batchDir, "raw_logs");
  const perTrialDir = path.join(batchDir, "per_trial_json");
  await fs.mkdir(rawDir, { recursive: true });
  await fs.mkdir(perTrialDir, { recursive: true });
  const logger = attachLogger(rawDir);

  console.log(`[opt] batch_dir=${batchDir}`);
  const allTrials = [];
  let portOff = 0;

  for (const arm of ARMS) {
    for (let t = 1; t <= arm.trials; t += 1) {
      const runId = `${arm.id}_trial${t}`;
      const runDir = path.join(batchDir, arm.id, `trial_${t}`);
      await fs.mkdir(runDir, { recursive: true });
      console.log(`\n[opt] ===== ${runId} =====`);
      try {
        const { row, gpuBackend } = await runAblationCell({
          experimentId: arm.cell.experimentId,
          runDir,
          ablationMode: arm.cell.mode,
          headless: false,
          pixelRatio: arm.cell.pixelRatio,
          warmupMs: opts.warmupMs,
          moveMs: opts.moveMs,
          traceChrome: process.env.VRC_TRACE_CHROME !== "0",
          assetPort: opts.basePort + portOff,
          phasedMeasure: arm.cell.phasedMeasure,
          pureRenderPreload: arm.cell.pureRenderPreload,
          chromeArgs: NVIDIA_CHROME_ARGS,
          chromiumLaunchOptions: NVIDIA_CHROMIUM_LAUNCH,
          vrcOpt: arm.vrcOpt ?? {},
        });

        let probeExtras = {};
        try {
          probeExtras = JSON.parse(
            await fs.readFile(path.join(runDir, "summary", "probe_frame_times.json"), "utf8"),
          );
        } catch { /* */ }

        const trialRow = buildOptimizationTrialRow({
          runId,
          timestamp: new Date().toISOString(),
          arm,
          trialId: t,
          row,
          gpuBackend,
          probeExtras,
          chromeExecutable: chromium.executablePath(),
          chromeArgs: NVIDIA_CHROME_ARGS,
        });
        await fs.writeFile(path.join(perTrialDir, `${runId}.json`), `${JSON.stringify(trialRow, null, 2)}\n`);
        allTrials.push(trialRow);
        console.log(
          `[opt] OK ${runId} fps=${trialRow.measure_fps} p95=${fmt(trialRow.frame_p95_ms)} >33=${trialRow.frames_over_33ms}`,
        );
      } catch (e) {
        console.error(`[opt] FAILED ${runId}:`, e);
        allTrials.push({
          run_id: runId,
          arm_id: arm.id,
          arm_name: arm.name,
          arm_group: arm.group,
          trial_id: t,
          trial_valid: false,
          invalid_reason: String(e?.message || e),
        });
      }
      portOff += 3;
    }
  }

  const finishedAt = new Date().toISOString();
  await writeSummaryCsv(allTrials, path.join(batchDir, "optimization_summary.csv"));
  const byArm = aggregateOptimizationByArm(allTrials);
  await writeSummaryCsv(byArm, path.join(batchDir, "optimization_summary_by_arm.csv"));

  const ev = await writeOptimizationReport({
    batchDir,
    trials: allTrials,
    byArm,
    startedAt,
    finishedAt,
  });

  try {
    await writeOptimizationFigures(batchDir);
  } catch (e) {
    console.warn("[opt] figures:", e?.message);
  }

  logger.close();

  console.log("\n========== OPTIMIZATION BATCH ==========");
  console.log(`path: ${batchDir}`);
  console.log("| arm | measure_fps | frame_p95 | >33ms | >100ms | render_scale | budget_scale |");
  for (const r of byArm) {
    console.log(
      `| ${r.arm_id} | ${fmt(r.measure_fps_mean)} | ${fmt(r.frame_p95_mean)} | ${fmt(r.frames_over_33ms_mean, 0)} | ${fmt(r.frames_over_100ms_mean, 0)} | ${fmt(r.render_scale_mean, 2)} | ${fmt(r.budget_scale_mean, 2)} |`,
    );
  }

  const focus = [
    "E3_normal_baseline",
    "O1_E3_adaptive_dpr_only",
    "O2_E3_splat_budget_only",
    "O3_E3_lod_throttle_only",
    "O4_E3_adaptive_dpr_plus_splat_budget",
    "O5_E3_all_optimizations",
  ];
  console.log("\n--- E3 baseline vs optimizations ---");
  for (const id of focus) {
    const r = byArm.find((x) => x.arm_id === id);
    if (r) {
      console.log(
        `${id}: fps=${fmt(r.measure_fps_mean)} p95=${fmt(r.frame_p95_mean)} >33=${fmt(r.frames_over_33ms_mean, 0)} >100=${fmt(r.frames_over_100ms_mean, 0)} render_scale=${fmt(r.render_scale_mean, 2)} budget=${fmt(r.budget_scale_mean, 2)}`,
      );
    }
  }

  let rec = "O5_E3_all_optimizations（全量叠加）";
  if (ev.bestSingle?.id) rec = `${ev.bestSingle.label}（单项收益最大）`;
  console.log(`\nVERDICT: ${ev.verdict}`);
  console.log(`RECOMMEND: ${rec}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
