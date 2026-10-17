/**
 * Final report generator — reads summary CSVs and produces final_report.md.
 * Usage: node vrc-paper/analysis/generate_report.mjs [--results-root <path>]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const RESULTS_ROOT = (() => {
  const idx = process.argv.indexOf("--results-root");
  if (idx !== -1 && process.argv[idx + 1]) return path.resolve(process.argv[idx + 1]);
  if (process.env.VRC_RESULTS_ROOT) return path.resolve(process.env.VRC_RESULTS_ROOT);
  return path.join(ROOT, "results");
})();

const SUMMARY = path.join(RESULTS_ROOT, "summary");
const FIGURES = path.join(RESULTS_ROOT, "figures");
const SCREENSHOTS = path.join(RESULTS_ROOT, "screenshots");

function readCsv(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map(h => h.replace(/^"|"$/g, ""));
  return lines.slice(1).map(line => {
    const cols = line.split(",").map(c => c.replace(/^"|"$/g, ""));
    const obj = {};
    header.forEach((k, i) => { obj[k] = cols[i] ?? ""; });
    return obj;
  });
}

function getVal(summary, method, scenario, metric) {
  const row = summary.find(r => r.method === method && r.scenario === scenario);
  if (!row) return 0;
  return parseFloat(row[`${metric}_mean`] || row[`${metric}_p50`] || row[metric] || "0") || 0;
}

function figExists(name) {
  return fs.existsSync(path.join(FIGURES, `${name}.png`)) ||
         fs.existsSync(path.join(FIGURES, `${name}.svg`));
}

function main() {
  const summary = readCsv(path.join(SUMMARY, "metrics_summary.csv"));
  const passFail = readCsv(path.join(SUMMARY, "run_pass_fail.csv"));
  const canary = fs.existsSync(path.join(SUMMARY, "canary_validation.json"))
    ? JSON.parse(fs.readFileSync(path.join(SUMMARY, "canary_validation.json"), "utf8"))
    : null;
  const overlap = readCsv(path.join(SUMMARY, "viewport_overlap_per_session.csv"));
  const preflight = fs.existsSync(path.join(SUMMARY, "preflight_report.json"))
    ? JSON.parse(fs.readFileSync(path.join(SUMMARY, "preflight_report.json"), "utf8"))
    : null;

  const ALL_METHODS = ["Full", "Spark-MU", "VP-S", "NET-S", "VRC-V", "VRC-N", "VRC-O", "VRC"];
  const SCENARIOS = ["nearby", "burst_turn", "divergent"];

  const totalRuns = passFail.length;
  const passCount = passFail.filter(r => r.status === "PASS").length;
  const failCount = passFail.filter(r => r.status && r.status !== "PASS").length;

  const nearbyVrcP95 = getVal(summary, "VRC", "nearby", "p95_latency_ms");
  const nearbyMuP95 = getVal(summary, "Spark-MU", "nearby", "p95_latency_ms");
  const nearbyVrcDup = getVal(summary, "VRC", "nearby", "duplicate_request_ratio");
  const nearbyMuDup = getVal(summary, "Spark-MU", "nearby", "duplicate_request_ratio");

  const canaryPass = canary ? canary.pass : "N/A";
  const canaryFail = canary ? canary.fail : "N/A";

  // Overlap summary
  const overlapNearby = overlap.filter(r => r.scenario === "nearby");
  const avgJaccard = overlapNearby.length
    ? (overlapNearby.reduce((s, r) => s + parseFloat(r.global_jaccard_mean || 0), 0) / overlapNearby.length).toFixed(3)
    : "N/A";

  // Method × scenario table
  let methodTable = "";
  for (const m of ALL_METHODS) {
    for (const s of SCENARIOS) {
      const p95 = getVal(summary, m, s, "p95_latency_ms");
      const frac = getVal(summary, m, s, "fraction_over_50ms");
      const dup = getVal(summary, m, s, "duplicate_request_ratio");
      methodTable += `| ${m.padEnd(10)} | ${s.padEnd(12)} | ${p95.toFixed(1).padStart(8)} | ${(frac * 100).toFixed(1).padStart(8)}% | ${dup.toFixed(3).padStart(7)} |\n`;
    }
  }

  const report = `# VRC Experiment: Final Report

**Project**: VRC — Viewport-aware Range Coordination for Multi-user Web 3DGS
**Scene**: Spark 2.0 streaming-lod (Coit Tower, SF — 40M splats)
**Generated**: ${new Date().toISOString()}
**Results Root**: \`${RESULTS_ROOT}\`

---

## Experiment Status

| Metric | Value |
|--------|-------|
| Total runs | ${totalRuns} |
| PASS | ${passCount} |
| FAIL | ${failCount} |
| Canary H1-H6 pass | ${canaryPass} |
| Canary H1-H6 fail | ${canaryFail} |
| Preflight | ${preflight?.ok ? "OK" : "MISSING/FAIL"} |

---

## Core Claim

> Without multi-user viewport/range reuse, independent viewport delivery creates duplicate demand
> and can push tail viewport-to-visible-content latency beyond 50 ms under overlapping multi-user demand.
> VRC reduces duplicate transfer, object/range completion time, and P95/P99 latency.

---

## Key Results (Nearby Scenario)

| Method   | P95 Latency (ms) | Dup Ratio |
|----------|-----------------|-----------|
| Spark-MU | ${nearbyMuP95.toFixed(1)} | ${nearbyMuDup.toFixed(3)} |
| VRC      | ${nearbyVrcP95.toFixed(1)} | ${nearbyVrcDup.toFixed(3)} |
| **Reduction** | **${nearbyMuP95 > 0 ? ((nearbyMuP95 - nearbyVrcP95) / nearbyMuP95 * 100).toFixed(1) : 0}%** | **${nearbyMuDup > 0 ? ((nearbyMuDup - nearbyVrcDup) / nearbyMuDup * 100).toFixed(1) : 0}%** |

## Viewport Overlap (Nearby)

| Metric | Value |
|--------|-------|
| Avg Jaccard (global) | ${avgJaccard} |
| Sessions measured | ${overlapNearby.length} |

---

## All Methods × Scenarios

| Method     | Scenario     | P95 (ms) | Frac>50ms | Dup Ratio |
|------------|--------------|----------|-----------|-----------|
${methodTable}

---

## Figures

| Figure | Status |
|--------|--------|
| fig1_demo_screenshot | ${figExists("fig1_demo_screenshot") ? "OK" : "MISSING"} |
| fig2_vrc_workflow | ${figExists("fig2_vrc_workflow") ? "OK" : "MISSING"} |
| fig3_p95_latency | ${figExists("fig3_p95_latency") ? "OK" : "MISSING"} |
| fig4_fraction_over_50ms | ${figExists("fig4_fraction_over_50ms") ? "OK" : "MISSING"} |
| fig5_duplicate_ratio | ${figExists("fig5_duplicate_ratio") ? "OK" : "MISSING"} |
| fig6_bytes_breakdown | ${figExists("fig6_bytes_breakdown") ? "OK" : "MISSING"} |
| fig7_completion_cdf | ${figExists("fig7_completion_cdf") ? "OK" : "MISSING"} |
| fig8_ablation | ${figExists("fig8_ablation") ? "OK" : "MISSING"} |
| fig9_mtp_timeline | ${figExists("fig9_mtp_timeline") ? "OK" : "MISSING"} |
| fig_appendix_all_methods_overview | ${figExists("fig_appendix_all_methods_overview") ? "OK" : "MISSING"} |

---

## QoE Formula

\`\`\`
qoe = visible_quality - 0.4 * latency_norm - 0.2 * stall_ratio
\`\`\`

---

## Reproducibility

\`\`\`bash
# Full pipeline (Windows):
powershell -ExecutionPolicy Bypass -File vrc-paper\\run_all.ps1

# Analysis only:
node vrc-paper/analysis/aggregate.mjs
node vrc-paper/analysis/generate_figures.mjs
node vrc-paper/analysis/generate_report.mjs

# Canary validation:
node vrc-paper/analysis/validate_canary.mjs
\`\`\`

---

## Paper-Readiness

${passCount > 0 && nearbyVrcP95 > 0 ? "Potentially paper-ready (real data collected)." : "NOT paper-ready — run experiments first."}

Conditions:
- Real runs with PASS: ${passCount}/${totalRuns}
- VRC P95 collected: ${nearbyVrcP95 > 0 ? "YES" : "NO"}
- Canary validation: ${canaryPass}/${(canary?.total_sessions || 0)} pass
`;

  const outFile = path.join(RESULTS_ROOT, "final_report.md");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, report);
  console.log(`[report] Wrote ${outFile}`);
}

main();
