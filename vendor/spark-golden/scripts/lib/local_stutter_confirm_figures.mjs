/**
 * SVG bar charts (no matplotlib dependency).
 */
import fs from "node:fs/promises";
import path from "node:path";

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",");
  return lines.slice(1).filter(Boolean).map((line) => {
    const cols = [];
    let cur = "";
    let inQ = false;
    for (const c of line) {
      if (c === '"') inQ = !inQ;
      else if (c === "," && !inQ) {
        cols.push(cur);
        cur = "";
      } else cur += c;
    }
    cols.push(cur);
    const o = {};
    header.forEach((h, i) => {
      const v = cols[i] ?? "";
      const n = Number(v);
      o[h] = v !== "" && Number.isFinite(n) ? n : v;
    });
    return o;
  });
}

function barSvg({ title, labels, values, ylabel, width = 800, height = 420 }) {
  const max = Math.max(...values, 1);
  const pad = { l: 60, r: 20, t: 40, b: 80 };
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const bw = plotW / values.length - 16;
  const bars = values
    .map((v, i) => {
      const h = (v / max) * plotH;
      const x = pad.l + i * (plotW / values.length) + 8;
      const y = pad.t + plotH - h;
      return `<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="#2563eb"/>`;
    })
    .join("");
  const texts = labels
    .map((lb, i) => {
      const x = pad.l + i * (plotW / values.length) + 8 + bw / 2;
     return `<text x="${x}" y="${height - 20}" font-size="10" text-anchor="middle" transform="rotate(-20 ${x} ${height - 20})">${lb}</text>`;
    })
    .join("");
  return `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <text x="${width / 2}" y="24" font-size="16" text-anchor="middle" font-weight="bold">${title}</text>
  <text x="16" y="${pad.t + plotH / 2}" font-size="12" transform="rotate(-90 16 ${pad.t + plotH / 2})">${ylabel}</text>
  ${bars}${texts}
  </svg>`;
}

function chartHtml({ title, labels, values, ylabel, color = "#2563eb" }) {
  const max = Math.max(...values, 1);
  const data = JSON.stringify({ title, labels, values, ylabel, max, color });
  return `<!DOCTYPE html><html><body style="margin:0;background:#fff">
<canvas id="c" width="800" height="420"></canvas>
<script>
const d=${data};
const c=document.getElementById('c'),x=c.getContext('2d');
const pad={l:60,r:20,t:40,b:90},W=c.width,H=c.height,pw=W-pad.l-pad.r,ph=H-pad.t-pad.b;
x.font='bold 16px sans-serif';x.textAlign='center';x.fillText(d.title,W/2,26);
x.font='12px sans-serif';x.save();x.translate(16,H/2);x.rotate(-Math.PI/2);x.fillText(d.ylabel,0,0);x.restore();
const bw=pw/d.values.length-16;
d.values.forEach((v,i)=>{const h=v/d.max*ph,px=pad.l+i*(pw/d.values.length)+8,py=pad.t+ph-h;
x.fillStyle=d.color;x.fillRect(px,py,bw,h);
x.save();x.translate(px+bw/2,H-12);x.rotate(-0.35);x.font='10px sans-serif';x.textAlign='center';x.fillText(d.labels[i],0,0);x.restore();});
</script></body></html>`;
}

async function pngFromHtml(html, outPath) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 420 } });
    await page.setContent(html, { waitUntil: "load" });
    await page.screenshot({ path: outPath, type: "png" });
  } finally {
    await browser.close();
  }
}

export async function writeConfirmFigures(batchDir) {
  const rows = parseCsv(await fs.readFile(path.join(batchDir, "confirm_summary_by_arm.csv"), "utf8"));
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

  const focus = ["E3_normal", "E4_normal_dpr05", "E8_render_only_pure", "E9_static_pure_render", "E10_moving_pure_render"];
  const fr = rows.filter((r) => focus.includes(r.arm_id));
  charts.push([
    "e3_vs_e4_vs_e8_vs_e9_vs_e10.png",
    {
      title: "E3 vs E4 vs E8 vs E9 vs E10",
      labels: fr.map((r) => r.arm_id),
      values: fr.map((r) => Number(r.measure_fps_mean)),
      ylabel: "FPS",
      color: "#16a34a",
    },
  ]);

  for (const [fname, spec] of charts) {
    await pngFromHtml(chartHtml(spec), path.join(figDir, fname));
  }
  return figDir;
}
