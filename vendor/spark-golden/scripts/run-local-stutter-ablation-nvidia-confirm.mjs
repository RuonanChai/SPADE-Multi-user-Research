/**
 * NVIDIA confirm batch — no FPS cap validation (RTX 4070).
 *
 *   node scripts/run-local-stutter-ablation-nvidia-confirm.mjs
 */
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { runAblationCell, cleanupStaleAblationProcesses } from "./lib/local_stutter_ablation_cell.mjs";
import { writeSummaryCsv } from "./lib/local_stutter_ablation_metrics.mjs";
import { buildConfirmTrialRow, aggregateByArm } from "./lib/local_stutter_confirm_row.mjs";
import { writeConfirmReport } from "./lib/local_stutter_confirm_report.mjs";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

import { NVIDIA_CHROME_ARGS, NVIDIA_CHROMIUM_LAUNCH } from "./lib/local_stutter_nvidia_chrome.mjs";

export const CONFIRM_CHROME_ARGS = NVIDIA_CHROME_ARGS;

const ARMS = [
  {
    id: "E3_normal",
    name: "headed normal DPR=1",
    trials: 3,
    cell: { experimentId: "E3", mode: "normal", pixelRatio: "1", phasedMeasure: true },
  },
  {
    id: "E4_normal_dpr05",
    name: "headed normal DPR=0.5",
    trials: 3,
    cell: { experimentId: "E4", mode: "normal", pixelRatio: "0.5", phasedMeasure: true },
  },
  {
    id: "E8_render_only_pure",
    name: "render_only_pure",
    trials: 3,
    cell: { experimentId: "E8", mode: "render_only_pure", pixelRatio: "auto", pureRenderPreload: true },
  },
  {
    id: "E9_static_pure_render",
    name: "static_camera pure render",
    trials: 3,
    cell: {
      experimentId: "E9",
      mode: "static_camera_render_only_pure",
      pixelRatio: "auto",
      pureRenderPreload: true,
    },
  },
  {
    id: "E10_moving_pure_render",
    name: "moving_camera pure render",
    trials: 3,
    cell: {
      experimentId: "E10",
      mode: "moving_camera_render_only_pure",
      pixelRatio: "auto",
      pureRenderPreload: true,
    },
  },
  {
    id: "E5_fetch_only_full",
    name: "fetch_only_full sanity",
    trials: 1,
    cell: { experimentId: "E5", mode: "fetch_only_full", pixelRatio: "auto", fullReplay: true },
  },
  {
    id: "E7_upload_only",
    name: "upload_only sanity",
    trials: 1,
    cell: { experimentId: "E7", mode: "upload_only", pixelRatio: "auto", phasedMeasure: true },
  },
];

const CHROMIUM_LAUNCH = NVIDIA_CHROMIUM_LAUNCH;

function attachLogger(rawDir) {
  const logPath = path.join(rawDir, "batch_run.log");
  const stream = createWriteStream(logPath, { flags: "a" });
  const stamp = () => new Date().toISOString();
  const write = (level, args) => {
    stream.write(`[${stamp()}] [${level}] ${args.map(String).join(" ")}\n`);
  };
  const orig = { log: console.log, error: console.error, warn: console.warn };
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

async function main() {
  const opts = { warmupMs: 20_000, moveMs: 40_000, basePort: 19600 };
  await cleanupStaleAblationProcesses();

  const startedAt = new Date().toISOString();
  const ts = startedAt.replace(/[:.]/g, "-").slice(0, 19);
  const batchDir = path.join(
    projectRoot,
    "260506_local_diag",
    "single_user_ablation_nvidia_confirm_no_fps_cap",
    ts,
  );
  const rawDir = path.join(batchDir, "raw_logs");
  const perTrialDir = path.join(batchDir, "per_trial_json");
  await fs.mkdir(rawDir, { recursive: true });
  await fs.mkdir(perTrialDir, { recursive: true });
  const logger = attachLogger(rawDir);

  console.log(`[confirm] batch_dir=${batchDir}`);
  console.log(`[confirm] chrome_args=${CONFIRM_CHROME_ARGS.join(" ")}`);
  console.log(`[confirm] playwright=${chromium.executablePath()}`);

  const allTrials = [];
  let portOff = 0;

  for (const arm of ARMS) {
    for (let t = 1; t <= arm.trials; t += 1) {
      const runId = `${arm.id}_trial${t}`;
      const runDir = path.join(batchDir, arm.id, `trial_${t}`);
      await fs.mkdir(runDir, { recursive: true });
      console.log(`\n[confirm] ===== ${runId} =====`);
      const t0 = Date.now();
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
          fullReplay: arm.cell.fullReplay,
          chromeArgs: CONFIRM_CHROME_ARGS,
          chromiumLaunchOptions: CHROMIUM_LAUNCH,
        });

        let probeExtras = {};
        try {
          probeExtras = JSON.parse(
            await fs.readFile(path.join(runDir, "summary", "probe_frame_times.json"), "utf8"),
          );
        } catch { /* */ }

        const confirmRow = buildConfirmTrialRow({
          runId,
          timestamp: new Date().toISOString(),
          arm,
          trialId: t,
          row,
          gpuBackend,
          probeExtras,
          chromeExecutable: chromium.executablePath(),
          chromeArgs: CONFIRM_CHROME_ARGS,
        });

        await fs.writeFile(path.join(perTrialDir, `${runId}.json`), `${JSON.stringify(confirmRow, null, 2)}\n`);
        allTrials.push(confirmRow);

        if (!confirmRow.trial_valid) {
          console.error(`[confirm] INVALID ${runId}: ${confirmRow.invalid_reason}`);
        } else {
          console.log(
            `[confirm] OK ${runId} measure_fps=${confirmRow.measure_fps} frame_p95=${confirmRow.frame_p95_ms} measure_rad=${confirmRow.measure_rad_requests} gpu=${String(confirmRow.gpu_renderer).slice(0, 56)} elapsed_s=${Math.round((Date.now() - t0) / 1000)}`,
          );
        }
      } catch (e) {
        console.error(`[confirm] FAILED ${runId}:`, e);
        allTrials.push({
          run_id: runId,
          timestamp: new Date().toISOString(),
          arm_id: arm.id,
          arm_name: arm.name,
          trial_id: t,
          trial_valid: false,
          invalid_reason: String(e?.message || e),
        });
      }
      portOff += 3;
    }
  }

  const finishedAt = new Date().toISOString();
  await writeSummaryCsv(allTrials, path.join(batchDir, "confirm_summary.csv"));
  const byArm = aggregateByArm(allTrials);
  await writeSummaryCsv(byArm, path.join(batchDir, "confirm_summary_by_arm.csv"));

  const priorBatch = path.join(
    projectRoot,
    "260506_local_diag/single_user_ablation_nvidia_e0_e10/2026-05-19T10-11-51",
  );
  const intelBatch = path.join(
    projectRoot,
    "260506_local_diag/single_user_ablation/2026-05-19T05-40-58",
  );
  const ev = await writeConfirmReport({
    batchDir,
    trials: allTrials,
    byArm,
    priorBatch,
    intelBatch,
    startedAt,
    finishedAt,
  });

  try {
    execSync(`python "${path.join(__dirname, "lib/local_stutter_confirm_figures.py")}" "${batchDir}"`, {
      stdio: "inherit",
    });
  } catch (e) {
    console.warn("[confirm] figures skipped:", e?.message || e);
  }

  logger.close();

  console.log("\n========== CONFIRM BATCH SUMMARY ==========");
  console.log(`path: ${batchDir}`);
  console.log("| arm | measure_fps | frame_p95 | >33ms | >100ms |");
  for (const r of byArm) {
    console.log(
      `| ${r.arm_id} | ${r.measure_fps_mean?.toFixed?.(1) ?? "—"} | ${r.frame_p95_mean?.toFixed?.(1) ?? "—"} | ${r.frames_over_33ms_mean?.toFixed?.(0) ?? "—"} | ${r.frames_over_100ms_mean?.toFixed?.(0) ?? "—"} |`,
    );
  }
  const focus = ["E3_normal", "E4_normal_dpr05", "E8_render_only_pure", "E9_static_pure_render", "E10_moving_pure_render"];
  for (const id of focus) {
    const r = byArm.find((x) => x.arm_id === id);
    if (r) {
      console.log(
        `${id}: measure_fps=${fmt(r.measure_fps_mean)} frame_p95=${fmt(r.frame_p95_mean)} >33ms=${fmt(r.frames_over_33ms_mean, 0)} >100ms=${fmt(r.frames_over_100ms_mean, 0)}`,
      );
    }
  }
  console.log(`VERDICT: ${ev.verdict}`);
  if (ev.reasons?.length) console.log(`reasons: ${ev.reasons.join("; ")}`);
}

function fmt(n, d = 1) {
  if (n == null || !Number.isFinite(n)) return "—";
  return Number(n).toFixed(d);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
