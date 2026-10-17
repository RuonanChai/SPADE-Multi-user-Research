/**
 * PNG figures for optimization batch (Playwright canvas).
 */
import fs from "node:fs/promises";
import path from "node:path";

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",");
  return lines.slice(1).filter(Boolean).map((line) => {
    const cols = line.split(",");
    const o = {};
    header.forEach((h, i) => {
      const v = cols[i] ?? "";
      const n = Number(v);
      o[h] = v !== "" && Number.isFinite(n) ? n : v;
    });
    return o;
  });
}

function chartHtml({ title, labels, values, ylabel, color = "#2563eb" }) {
  const max = Math.max(...values, 1);
  const data = JSON.stringify({ title, labels, values, ylabel, max, color });
  return `<!DOCTYPE html><html><body style="margin:0;background:#fff">
<canvas id="c" width="900" height="460"></canvas>
<script>
const d=${data};
const c=document.getElementById('c'),x=c.getContext('2d');
const pad={l:60,r:20,t:40,b:100},W=c.width,H=c.height,pw=W-pad.l-pad.r,ph=H-pad.t-pad.b;
x.font='bold 16px sans-serif';x.textAlign='center';x.fillText(d.title,W/2,26);
x.font='12px sans-serif';x.save();x.translate(16,H/2);x.rotate(-Math.PI/2);x.fillText(d.ylabel,0,0);x.restore();
const bw=pw/d.values.length-12;
d.values.forEach((v,i)=>{const h=v/d.max*ph,px=pad.l+i*(pw/d.values.length)+6,py=pad.t+ph-h;
x.fillStyle=d.color;x.fillRect(px,py,bw,h);
x.save();x.translate(px+bw/2,H-14);x.rotate(-0.4);x.font='9px sans-serif';x.textAlign='center';x.fillText(d.labels[i],0,0);x.restore();});
</script></body></html>`;
}

async function pngFromHtml(html, outPath) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 460 } });
    await page.setContent(html, { waitUntil: "load" });
    await page.screenshot({ path: outPath, type: "png" });
  } finally {
    await browser.close();
  }
}

export async function writeOptimizationFigures(batchDir) {
  const rows = parseCsv(
    await fs.readFile(path.join(batchDir, "optimization_summary_by_arm.csv"), "utf8"),
  );
  const figDir = path.join(batchDir, "figures");
  await fs.mkdir(figDir, { recursive: true });
  const arms = rows.map((r) => r.arm_id);
  const fps = rows.map((r) => Number(r.measure_fps_mean));
  const p95 = rows.map((r) => Number(r.frame_p95_mean));
  const f33 = rows.map((r) => Number(r.frames_over_33ms_mean));

  const charts = [
    ["fps_by_arm.png", { title: "Measure FPS by arm", labels: arms, values: fps, ylabel: "FPS" }],
    ["frame_p95_by_arm.png", { title: "Frame p95 by arm", labels: arms, values: p95, ylabel: "ms" }],
    ["long_frames_by_arm.png", { title: ">33ms frames (mean)", labels: arms, values: f33, ylabel: "count" }],
  ];

  const base = rows.filter((r) => String(r.arm_group) === "baseline");
  const opt = rows.filter((r) => String(r.arm_group) === "optimized");
  charts.push([
    "baseline_vs_optimized.png",
    {
      title: "Baseline vs Optimized (E3 family)",
      labels: [...base, ...opt].map((r) => r.arm_id.replace(/_E3_|_normal_baseline/g, "")),
      values: [...base, ...opt].map((r) => Number(r.measure_fps_mean)),
      ylabel: "FPS",
      color: "#16a34a",
    },
  ]);

  const abl = ["E3_normal_baseline", "O1_E3_adaptive_dpr_only", "O2_E3_splat_budget_only", "O3_E3_lod_throttle_only", "O4_E3_adaptive_dpr_plus_splat_budget", "O5_E3_all_optimizations"];
  const fr = rows.filter((r) => abl.includes(r.arm_id));
  charts.push([
    "optimization_ablation.png",
    {
      title: "E3 optimization ablation",
      labels: fr.map((r) => r.arm_id.replace("E3_", "").replace("_only", "")),
      values: fr.map((r) => Number(r.measure_fps_mean)),
      ylabel: "FPS",
      color: "#7c3aed",
    },
  ]);

  for (const [fname, spec] of charts) {
    await pngFromHtml(chartHtml(spec), path.join(figDir, fname));
  }
  return figDir;
}
