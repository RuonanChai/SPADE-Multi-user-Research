/**
 * Render load scaling v2 — true splat budget.
 *
 *   node scripts/run-render-load-scaling-v2.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runRenderLoadScalingCell } from "./lib/render_load_scaling_cell.mjs";
import { writeRenderLoadScalingV2Report } from "./lib/render_load_scaling_v2_report.mjs";
import { cleanupStaleAblationProcesses } from "./lib/local_stutter_ablation_cell.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const MATRIX = [
  { id: "R01", percent: 1 },
  { id: "R05", percent: 5 },
  { id: "R10", percent: 10 },
  { id: "R25", percent: 25 },
  { id: "R50", percent: 50 },
  { id: "R100", percent: 100 },
];

async function main() {
  await cleanupStaleAblationProcesses();

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const batchDir = path.join(projectRoot, "260506_local_diag", "render_load_scaling_v2", ts);
  await fs.mkdir(batchDir, { recursive: true });

  const allRows = [];
  let port = 19700;

  for (const exp of MATRIX) {
    const runDir = path.join(batchDir, exp.id);
    console.log(`\n[scaling-v2] ${exp.id} render budget=${exp.percent}%`);
    try {
      const { row } = await runRenderLoadScalingCell({
        experimentId: exp.id,
        runDir,
        renderSplatBudgetPercent: exp.percent,
        measureMs: 30_000,
        preloadMaxMs: 120_000,
        assetPort: port++,
      });
      allRows.push(row);
      console.log(
        `[scaling-v2] ${exp.id} rendered=${Math.round(row.rendered_splat_count)} fps=${row.measure_fps_mean} pure_ok=${row.pure_ok} measure_rad=${row.measure_rad_requests}`,
      );
    } catch (e) {
      console.error(`[scaling-v2] ${exp.id} FAILED`, e);
      allRows.push({
        experiment_id: exp.id,
        render_splat_budget_percent: exp.percent,
        pure_ok: false,
        run_invalid: true,
        run_invalid_reason: String(e?.message || e),
      });
    }
  }

  const splatOf = (r) =>
    Number(r.rendered_splat_count) || Number(r.visible_splat_count) || Number(r.target_rendered_splats) || 0;

  for (const r of allRows) {
    r.rendered_splat_count = splatOf(r);
    if (!r.pure_ok) {
      r.run_invalid = true;
      r.run_invalid_reason = r.run_invalid_reason || `pure_ok=false measure_rad=${r.measure_rad_requests}`;
    }
  }

  const valid = allRows.filter((r) => r.pure_ok && !r.run_invalid);
  const r100 = valid.find((r) => r.experiment_id === "R100");
  const r10 = valid.find((r) => r.experiment_id === "R10");

  for (const r of allRows) {
    if (!r.pure_ok || r.run_invalid) continue;
    if (r100 && r.experiment_id !== "R100") {
      const ratio = splatOf(r) / splatOf(r100);
      const expected = Number(r.render_splat_budget_percent) / 100;
      if (ratio > expected * 1.5 + 0.08) {
        r.run_invalid = true;
        r.run_invalid_reason = `visible/rendered splats (${splatOf(r)}) too high vs R100 (${splatOf(r100)}) for budget ${r.render_splat_budget_percent}%`;
      }
    }
  }
  if (r10 && r100 && r10.pure_ok && !r10.run_invalid) {
    if (splatOf(r10) >= splatOf(r100) * 0.9) {
      r10.run_invalid = true;
      r10.run_invalid_reason = `R10 splats (${splatOf(r10)}) >= 90% of R100 (${splatOf(r100)})`;
    }
  }

  const keys = [...new Set(allRows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    if (v == null) return "";
    const s = String(v);
    return s.includes(",") ? `"${s.replace(/"/g, '""')}"` : s;
  };
  await fs.writeFile(
    path.join(batchDir, "render_load_scaling_v2_summary.csv"),
    [keys.join(","), ...allRows.map((r) => keys.map((k) => esc(r[k])).join(","))].join("\n"),
  );
  await fs.writeFile(
    path.join(batchDir, "render_load_scaling_v2_summary.json"),
    `${JSON.stringify(allRows, null, 2)}\n`,
  );
  await writeRenderLoadScalingV2Report(allRows, path.join(batchDir, "render_load_scaling_v2.md"));

  console.log(`\n[scaling-v2] complete → ${batchDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
