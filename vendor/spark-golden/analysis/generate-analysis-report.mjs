import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const out = {
    input: "analysis/metrics-by-window.json",
    outDir: "analysis/out",
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "input") out.input = v || out.input;
    else if (k === "out") out.outDir = v || out.outDir;
  }
  return out;
}

function makeLineSvg(points, width, height, color, maxY) {
  if (!points.length) return "";
  const xStep = points.length > 1 ? width / (points.length - 1) : width;
  const d = points
    .map((v, i) => {
      const x = i * xStep;
      const y = height - (maxY === 0 ? 0 : (v / maxY) * height);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" />`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = await fs.readFile(args.input, "utf8");
  const data = JSON.parse(raw);
  const windows = data.windows || [];
  const bClient = windows.map((w) => w.B_client_agg || 0);
  const bUnique = windows.map((w) => w.B_unique || 0);
  const bUpstream = windows.map((w) => w.B_upstream || 0);
  const maxY = Math.max(1, ...bClient, ...bUnique, ...bUpstream);
  const width = 900;
  const height = 320;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height + 60}">
  <rect width="100%" height="100%" fill="#111827"/>
  <text x="24" y="24" fill="#e5e7eb" font-size="14">Byte Comparison: B_client_agg vs B_unique vs B_upstream</text>
  <g transform="translate(20,40)">
    <rect x="0" y="0" width="${width - 40}" height="${height}" fill="#1f2937" stroke="#374151" />
    ${makeLineSvg(bClient, width - 40, height, "#60a5fa", maxY)}
    ${makeLineSvg(bUnique, width - 40, height, "#34d399", maxY)}
    ${makeLineSvg(bUpstream, width - 40, height, "#fbbf24", maxY)}
  </g>
  <text x="24" y="${height + 50}" fill="#93c5fd">Blue: B_client_agg</text>
  <text x="220" y="${height + 50}" fill="#6ee7b7">Green: B_unique</text>
  <text x="400" y="${height + 50}" fill="#fcd34d">Yellow: B_upstream</text>
</svg>`;

  const markdown = `# Experiment Analysis

## Latency (ms)
- Client P50/P95/P99: ${data.latency?.client_ms?.p50 ?? "-"} / ${data.latency?.client_ms?.p95 ?? "-"} / ${data.latency?.client_ms?.p99 ?? "-"}
- Upstream P50/P95/P99: ${data.latency?.upstream_ms?.p50 ?? "-"} / ${data.latency?.upstream_ms?.p95 ?? "-"} / ${data.latency?.upstream_ms?.p99 ?? "-"}

## Per-user QoE / Stall / Completion
${(data.per_user || []).map((u) => `- ${u.user_id}: qoe=${u.qoe_score}, stall=${u.stall_count}, completion=${u.completion_count}`).join("\n")}

## Fairness
- Jain fairness index: ${data.jain_fairness_index ?? "-"}
`;

  await fs.mkdir(args.outDir, { recursive: true });
  await fs.writeFile(path.join(args.outDir, "byte-comparison.svg"), svg, "utf8");
  await fs.writeFile(path.join(args.outDir, "report.md"), markdown, "utf8");
  console.log(`Wrote ${args.outDir}/byte-comparison.svg and report.md`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
