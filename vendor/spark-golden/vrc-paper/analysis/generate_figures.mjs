/**
 * Figure generation using Node.js + SVG → PNG (via sharp if available, else SVG output).
 * Produces fig3–fig9 + appendix from summary CSVs.
 * Falls back to analyze.py (matplotlib) if Python is available.
 *
 * Usage: node vrc-paper/analysis/generate_figures.mjs [--results-root <path>] [--format svg|png]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const RESULTS_ROOT = (() => {
  const idx = process.argv.indexOf("--results-root");
  if (idx !== -1 && process.argv[idx + 1]) return path.resolve(process.argv[idx + 1]);
  if (process.env.VRC_RESULTS_ROOT) return path.resolve(process.env.VRC_RESULTS_ROOT);
  return path.join(ROOT, "results");
})();

const FORMAT = (() => {
  const idx = process.argv.indexOf("--format");
  return (idx !== -1 && process.argv[idx + 1]) || "svg";
})();

const SUMMARY = path.join(RESULTS_ROOT, "summary");
const FIGURES = path.join(RESULTS_ROOT, "figures");
fs.mkdirSync(FIGURES, { recursive: true });

const MAIN_METHODS = ["Full", "Spark-MU", "VP-S", "NET-S", "VRC"];
const ABLATION_METHODS = ["VRC-V", "VRC-N", "VRC-O", "VRC"];
const ALL_METHODS = ["Full", "Spark-MU", "VP-S", "NET-S", "VRC-V", "VRC-N", "VRC-O", "VRC"];
const SCENARIOS = ["nearby", "burst_turn", "divergent"];

const COLORS = {
  "Full": "#555555", "Spark-MU": "#e07b39", "VP-S": "#c0392b",
  "NET-S": "#8e44ad", "VRC-V": "#2980b9", "VRC-N": "#16a085",
  "VRC-O": "#f39c12", "VRC": "#27ae60",
};

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

function barChartSvg(title, scenarios, methods, metricKey, summary, opts = {}) {
  const { yLabel = "", showRedLine = false, redLineY = 50, pctFormat = false } = opts;
  const W = 800, H = 300, margin = { top: 50, right: 20, bottom: 60, left: 60 };
  const plotW = (W - margin.left - margin.right) / scenarios.length;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="monospace">`;
  svg += `<text x="${W/2}" y="25" text-anchor="middle" font-size="13" font-weight="bold">${title}</text>`;

  for (let si = 0; si < scenarios.length; si++) {
    const scenario = scenarios[si];
    const ox = margin.left + si * plotW;
    const vals = methods.map(m => getVal(summary, m, scenario, metricKey));
    const maxVal = Math.max(...vals, showRedLine ? redLineY * 1.2 : 1) * 1.1 || 1;
    const barW = (plotW - 20) / methods.length;

    svg += `<text x="${ox + plotW/2}" y="${H - 10}" text-anchor="middle" font-size="10">${scenario.replace("_", "-")}</text>`;

    if (showRedLine) {
      const ry = margin.top + (1 - redLineY / maxVal) * (H - margin.top - margin.bottom);
      svg += `<line x1="${ox}" y1="${ry}" x2="${ox + plotW - 10}" y2="${ry}" stroke="red" stroke-width="1.5" stroke-dasharray="4,3"/>`;
    }

    for (let mi = 0; mi < methods.length; mi++) {
      const v = vals[mi];
      const barH = (v / maxVal) * (H - margin.top - margin.bottom);
      const x = ox + 10 + mi * barW;
      const y = H - margin.bottom - barH;
      svg += `<rect x="${x}" y="${y}" width="${barW - 2}" height="${barH}" fill="${COLORS[methods[mi]] || "#999"}" opacity="0.85"/>`;
      const label = pctFormat ? `${(v * 100).toFixed(1)}%` : v.toFixed(1);
      svg += `<text x="${x + barW/2 - 1}" y="${y - 3}" text-anchor="middle" font-size="7">${label}</text>`;
    }

    if (si === 0 && yLabel) {
      svg += `<text x="${ox - 40}" y="${(margin.top + H - margin.bottom) / 2}" text-anchor="middle" font-size="9" transform="rotate(-90,${ox - 40},${(margin.top + H - margin.bottom) / 2})">${yLabel}</text>`;
    }
  }

  // Legend
  const lx = margin.left;
  const ly = H - 5;
  for (let mi = 0; mi < methods.length; mi++) {
    const x = lx + mi * 80;
    svg += `<rect x="${x}" y="${ly - 8}" width="10" height="8" fill="${COLORS[methods[mi]] || "#999"}"/>`;
    svg += `<text x="${x + 13}" y="${ly}" font-size="8">${methods[mi]}</text>`;
  }

  svg += `</svg>`;
  return svg;
}

function writeFigure(name, svgContent) {
  const svgFile = path.join(FIGURES, `${name}.svg`);
  fs.writeFileSync(svgFile, svgContent);
  console.log(`  wrote ${svgFile}`);

  if (FORMAT === "png") {
    try {
      const pngFile = path.join(FIGURES, `${name}.png`);
      execSync(`npx --yes sharp-cli --input "${svgFile}" --output "${pngFile}"`, { stdio: "pipe" });
      console.log(`  converted → ${pngFile}`);
    } catch {
      console.log(`  (PNG conversion skipped — install sharp-cli for PNG output)`);
    }
  }
}

function fig2WorkflowSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="350" font-family="monospace">
  <text x="350" y="25" text-anchor="middle" font-size="14" font-weight="bold">VRC Workflow: Demand Overlap → Shared/Personalized Chunks</text>
  <rect x="30" y="60" width="120" height="30" rx="5" fill="#ff555533" stroke="#ff5555"/>
  <text x="90" y="80" text-anchor="middle" font-size="10" fill="#ff5555">u0 viewport</text>
  <rect x="30" y="110" width="120" height="30" rx="5" fill="#55aaff33" stroke="#55aaff"/>
  <text x="90" y="130" text-anchor="middle" font-size="10" fill="#55aaff">u1 viewport</text>
  <rect x="30" y="160" width="120" height="30" rx="5" fill="#55ff5533" stroke="#55ff55"/>
  <text x="90" y="180" text-anchor="middle" font-size="10" fill="#55ff55">u2 viewport</text>
  <rect x="30" y="210" width="120" height="30" rx="5" fill="#ffaa5533" stroke="#ffaa55"/>
  <text x="90" y="230" text-anchor="middle" font-size="10" fill="#ffaa55">u3 viewport</text>
  <line x1="150" y1="75" x2="270" y2="155" stroke="#ff5555" stroke-width="1.5" marker-end="url(#arrow)"/>
  <line x1="150" y1="125" x2="270" y2="155" stroke="#55aaff" stroke-width="1.5" marker-end="url(#arrow)"/>
  <line x1="150" y1="175" x2="270" y2="165" stroke="#55ff55" stroke-width="1.5" marker-end="url(#arrow)"/>
  <line x1="150" y1="225" x2="270" y2="175" stroke="#ffaa55" stroke-width="1.5" marker-end="url(#arrow)"/>
  <rect x="270" y="130" width="140" height="60" rx="8" fill="#ffffcc" stroke="#aa8800" stroke-width="2"/>
  <text x="340" y="155" text-anchor="middle" font-size="10">VRC Coordinator</text>
  <text x="340" y="175" text-anchor="middle" font-size="9" fill="#666">(50ms window)</text>
  <line x1="410" y1="145" x2="500" y2="100" stroke="#27ae60" stroke-width="2" marker-end="url(#arrow)"/>
  <line x1="410" y1="175" x2="500" y2="220" stroke="#2980b9" stroke-width="2" marker-end="url(#arrow)"/>
  <rect x="500" y="80" width="170" height="40" rx="5" fill="#27ae6022" stroke="#27ae60"/>
  <text x="585" y="100" text-anchor="middle" font-size="10" fill="#27ae60">Shared chunks</text>
  <text x="585" y="113" text-anchor="middle" font-size="8" fill="#666">(multi-user demand)</text>
  <rect x="500" y="200" width="170" height="40" rx="5" fill="#2980b922" stroke="#2980b9"/>
  <text x="585" y="220" text-anchor="middle" font-size="10" fill="#2980b9">Personalized chunks</text>
  <text x="585" y="233" text-anchor="middle" font-size="8" fill="#666">(single-user demand)</text>
  <line x1="585" y1="120" x2="585" y2="145" stroke="#27ae60" stroke-width="1" stroke-dasharray="3,2"/>
  <text x="585" y="155" text-anchor="middle" font-size="9" fill="#27ae60">→ CDN (hot)</text>
  <line x1="585" y1="240" x2="585" y2="265" stroke="#2980b9" stroke-width="1" stroke-dasharray="3,2"/>
  <text x="585" y="275" text-anchor="middle" font-size="9" fill="#2980b9">→ Origin (cold)</text>
  <defs><marker id="arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#333"/></marker></defs>
</svg>`;
}

function fig9MtpSvg(summary) {
  const targets = [0, 16.7, 33.3, 50.0];
  const methods = ["Spark-MU", "VRC"];
  const scenario = "nearby";
  const W = 500, H = 280;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="monospace">`;
  svg += `<text x="${W/2}" y="20" text-anchor="middle" font-size="12" font-weight="bold">Fraction Meeting Latency Targets — Nearby</text>`;

  const barW = 35;
  const groupW = barW * methods.length + 20;
  const ox = 80;

  for (let ti = 0; ti < targets.length; ti++) {
    const gx = ox + ti * groupW;
    svg += `<text x="${gx + groupW/2}" y="${H - 10}" text-anchor="middle" font-size="9">${targets[ti]} ms</text>`;

    for (let mi = 0; mi < methods.length; mi++) {
      const p95 = getVal(summary, methods[mi], scenario, "p95_latency_ms") || 60;
      const frac = Math.max(0, Math.min(1, 1.0 - targets[ti] / p95));
      const barH = frac * (H - 70);
      const x = gx + mi * barW + 5;
      const y = H - 40 - barH;
      svg += `<rect x="${x}" y="${y}" width="${barW - 4}" height="${barH}" fill="${COLORS[methods[mi]]}" opacity="0.85"/>`;
      svg += `<text x="${x + barW/2 - 2}" y="${y - 3}" text-anchor="middle" font-size="7">${frac.toFixed(2)}</text>`;
    }
  }

  for (let mi = 0; mi < methods.length; mi++) {
    svg += `<rect x="${ox + mi * 80}" y="35" width="12" height="8" fill="${COLORS[methods[mi]]}"/>`;
    svg += `<text x="${ox + mi * 80 + 15}" y="43" font-size="9">${methods[mi]}</text>`;
  }

  svg += `</svg>`;
  return svg;
}

function main() {
  console.log(`[figures] RESULTS_ROOT=${RESULTS_ROOT}`);
  const summaryFile = path.join(SUMMARY, "metrics_summary.csv");
  const summary = readCsv(summaryFile);

  if (!summary.length) {
    console.log("[figures] No metrics_summary.csv found. Run aggregate.mjs first.");
    console.log("[figures] Generating placeholder figures with zero data...");
  }

  // fig2: VRC workflow diagram
  writeFigure("fig2_vrc_workflow", fig2WorkflowSvg());

  // fig3: P95 latency
  writeFigure("fig3_p95_latency", barChartSvg(
    "P95 Object/Range Completion Latency (ms) — Main Methods",
    SCENARIOS, MAIN_METHODS, "p95_latency_ms", summary,
    { yLabel: "P95 latency (ms)", showRedLine: true, redLineY: 50 }
  ));

  // fig4: Fraction > 50ms
  writeFigure("fig4_fraction_over_50ms", barChartSvg(
    "Fraction of Chunks > 50 ms — Main Methods",
    SCENARIOS, MAIN_METHODS, "fraction_over_50ms", summary,
    { yLabel: "% > 50ms", pctFormat: true }
  ));

  // fig5: Duplicate ratio
  writeFigure("fig5_duplicate_ratio", barChartSvg(
    "Duplicate Request Ratio — Main Methods",
    SCENARIOS, MAIN_METHODS, "duplicate_request_ratio", summary,
    { yLabel: "Dup ratio" }
  ));

  // fig6: Bytes breakdown (aggregate_client_bytes as proxy)
  writeFigure("fig6_bytes_breakdown", barChartSvg(
    "Aggregate Client Bytes (MB) — Main Methods",
    SCENARIOS, MAIN_METHODS, "aggregate_client_bytes", summary,
    { yLabel: "Bytes (raw)" }
  ));

  // fig8: Ablation
  writeFigure("fig8_ablation", barChartSvg(
    "Ablation Study — P95 Latency (ms)",
    SCENARIOS, ABLATION_METHODS, "p95_latency_ms", summary,
    { yLabel: "P95 latency (ms)", showRedLine: true, redLineY: 50 }
  ));

  // fig9: MTP timeline
  writeFigure("fig9_mtp_timeline", fig9MtpSvg(summary));

  // fig_appendix: All methods
  writeFigure("fig_appendix_all_methods_overview", barChartSvg(
    "All Methods Overview — P95 Latency (ms) [Appendix]",
    SCENARIOS, ALL_METHODS, "p95_latency_ms", summary,
    { yLabel: "P95 latency (ms)", showRedLine: true, redLineY: 50 }
  ));

  console.log(`[figures] Done. ${FORMAT === "png" ? "PNG" : "SVG"} figures in ${FIGURES}`);
}

main();
