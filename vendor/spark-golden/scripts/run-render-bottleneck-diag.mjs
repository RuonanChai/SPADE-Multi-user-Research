/**
 * GPU / render bottleneck diagnosis — small matrix only.
 *
 *   node scripts/run-render-bottleneck-diag.mjs
 *   node scripts/run-render-bottleneck-diag.mjs --matrix=B,C
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runRenderBottleneckCell,
  buildChromeArgs,
} from "./lib/render_bottleneck_cell.mjs";
import { writeFinalRenderBottleneckReport } from "./lib/render_bottleneck_report.mjs";
import { cleanupStaleAblationProcesses } from "./lib/local_stutter_ablation_cell.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const ANGLE_MATRIX = [
  { id: "B_default", profile: "default" },
  { id: "B_angle_d3d11", profile: "angle_d3d11" },
  { id: "B_angle_d3d11on12", profile: "angle_d3d11on12" },
  { id: "B_angle_gl", profile: "angle_gl" },
  { id: "B_gpu_raster", profile: "gpu_raster" },
  { id: "B_disable_gpu", profile: "disable_gpu" },
];

const LOAD_MATRIX = [10, 25, 50, 75, 100].map((p) => ({
  id: `R${p}`,
  loadPercent: p,
}));

const RESOLUTION_MATRIX = [
  { id: "D_640x360", width: 640, height: 360 },
  { id: "D_960x540", width: 960, height: 540 },
  { id: "D_1280x720", width: 1280, height: 720 },
  { id: "D_1920x1080", width: 1920, height: 1080 },
  { id: "D_default", width: 1280, height: 720, label: "default" },
];

function parseArgs(argv) {
  const o = { matrices: new Set(["B", "C", "D"]), measureMs: 30_000, preloadMaxMs: 120_000 };
  for (const arg of argv) {
    if (arg.startsWith("--matrix=")) {
      o.matrices = new Set(arg.slice(9).split(",").map((s) => s.trim().toUpperCase()));
    } else if (arg.startsWith("--measureMs=")) o.measureMs = Number.parseInt(arg.slice(12), 10);
    else if (arg.startsWith("--preloadMaxMs=")) o.preloadMaxMs = Number.parseInt(arg.slice(15), 10);
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await cleanupStaleAblationProcesses();

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const batchDir = path.join(projectRoot, "260506_local_diag", "render_bottleneck", ts);
  await fs.mkdir(batchDir, { recursive: true });

  const summaryRows = [];
  let port = 19500;

  if (opts.matrices.has("B")) {
    for (const exp of ANGLE_MATRIX) {
      const runDir = path.join(batchDir, exp.id);
      console.log(`\n[render-diag] B ${exp.id} (${exp.profile})`);
      try {
        const { row } = await runRenderBottleneckCell({
          experimentId: exp.id,
          runDir,
          chromeProfile: exp.profile,
          chromeArgs: buildChromeArgs(exp.profile),
          measureMs: 40_000,
          preloadMaxMs: opts.preloadMaxMs,
          loadPercent: 100,
          assetPort: port++,
        });
        summaryRows.push(row);
        console.log(
          `[render-diag] ${exp.id} fps=${row.measure_fps_mean} frame_p95=${row.measure_frame_p95_ms} gpu=${row.trace_gpu_ms}`,
        );
      } catch (e) {
        console.error(`[render-diag] ${exp.id} FAILED`, e);
        summaryRows.push({ experiment_id: exp.id, error: String(e?.message || e) });
      }
    }
  }

  if (opts.matrices.has("C")) {
    for (const exp of LOAD_MATRIX) {
      const runDir = path.join(batchDir, exp.id);
      console.log(`\n[render-diag] C ${exp.id} load=${exp.loadPercent}%`);
      try {
        const { row } = await runRenderBottleneckCell({
          experimentId: exp.id,
          runDir,
          chromeProfile: "default",
          measureMs: opts.measureMs,
          preloadMaxMs: opts.preloadMaxMs,
          loadPercent: exp.loadPercent,
          assetPort: port++,
        });
        summaryRows.push(row);
        console.log(
          `[render-diag] ${exp.id} chunks=${row.loaded_chunk_count} fps=${row.measure_fps_mean} pure_ok=${row.pure_render_valid}`,
        );
      } catch (e) {
        console.error(`[render-diag] ${exp.id} FAILED`, e);
        summaryRows.push({ experiment_id: exp.id, error: String(e?.message || e) });
      }
    }
  }

  if (opts.matrices.has("D")) {
    for (const exp of RESOLUTION_MATRIX) {
      const runDir = path.join(batchDir, exp.id);
      console.log(`\n[render-diag] D ${exp.id} ${exp.width}x${exp.height}`);
      try {
        const { row } = await runRenderBottleneckCell({
          experimentId: exp.id,
          runDir,
          chromeProfile: "default",
          viewport: { width: exp.width, height: exp.height },
          measureMs: 40_000,
          preloadMaxMs: opts.preloadMaxMs,
          loadPercent: 100,
          assetPort: port++,
        });
        summaryRows.push(row);
        console.log(`[render-diag] ${exp.id} fps=${row.measure_fps_mean} buffer=${row.drawing_buffer_size}`);
      } catch (e) {
        console.error(`[render-diag] ${exp.id} FAILED`, e);
        summaryRows.push({ experiment_id: exp.id, error: String(e?.message || e) });
      }
    }
  }

  const keys = [...new Set(summaryRows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    if (v == null) return "";
    const s = String(v);
    return s.includes(",") ? `"${s.replace(/"/g, '""')}"` : s;
  };
  await fs.writeFile(
    path.join(batchDir, "render_bottleneck_summary.csv"),
    [keys.join(","), ...summaryRows.map((r) => keys.map((k) => esc(r[k])).join(","))].join("\n"),
  );
  await fs.writeFile(
    path.join(batchDir, "render_bottleneck_summary.json"),
    `${JSON.stringify(summaryRows, null, 2)}\n`,
  );
  await writeFinalRenderBottleneckReport(
    summaryRows,
    path.join(batchDir, "final_render_bottleneck_report.md"),
  );

  console.log(`\n[render-diag] complete → ${batchDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
