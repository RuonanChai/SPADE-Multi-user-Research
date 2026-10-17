/**
 * Introduction Figure 1: Remote-to-visible readiness gap (Spark2.0).
 * Outputs: remote_readiness_gap.svg | .png | .pdf
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { PDFDocument } from "pdf-lib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../..");
const BATCH = path.join(
  REPO,
  "paper_materials/ready_single_user_v1/runs/delivery_path_sanity_2026-05-28T00-19-46",
);
const OUT_BASE = path.join(__dirname, "remote_readiness_gap");

const PATHS = [
  ["local_disk", "Local"],
  ["edge_server", "Edge"],
  ["remote_gcs", "GCS"],
];
const TRIALS = ["t0", "t1", "t2", "t3"];

const C = {
  local: "#0072B2",
  edge: "#E69F00",
  gcs: "#D55E00",
  q5: "#56B4E9",
  q10: "#009E73",
  fetch: "#0072B2",
  parse: "#CC79A7",
  dot: "#333333",
  grid: "#E6E6E6",
  annot: "#555555",
};

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function loadTrial(deliveryKey, trial) {
  const stem = `${deliveryKey}__spark_od__phase_delivery_path_sanity__${trial}`;
  const trialJson = JSON.parse(
    fs.readFileSync(path.join(BATCH, "per_trial_json", `${stem}.json`), "utf8"),
  );
  const summary = JSON.parse(
    fs.readFileSync(
      path.join(BATCH, "per_trial_runs", stem, "summary", "experiment_summary.json"),
      "utf8",
    ),
  );
  return { ...trialJson, ...summary };
}

function collect() {
  const data = {};
  for (const [dk, label] of PATHS) {
    const rows = TRIALS.map((t) => loadTrial(dk, t));
    data[label] = {
      fv_s: rows.map((r) => r.first_visible_splat_ms / 1000),
      q5_m: rows.map((r) => r.quality_at_5s / 1e6),
      q10_m: rows.map((r) => r.quality_at_10s / 1e6),
      t1m_s: rows.map((r) => r.time_to_1M_visible_splats_ms / 1000),
      fetch_p95: rows.map((r) => r.measure_fetch_p95_ms),
      parse_p95: rows.map((r) => r.measure_parse_p95_ms),
    };
  }
  return data;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function yScale(yMin, yMax, h, padTop, padBottom) {
  const plotH = h - padTop - padBottom;
  return (v) => padTop + plotH * (1 - (v - yMin) / (yMax - yMin || 1));
}

function panelFrame(x, y, w, h, title, yLabel) {
  return `
  <g transform="translate(${x},${y})">
    <rect x="0" y="0" width="${w}" height="${h}" fill="#fff" stroke="#ccc" stroke-width="0.5"/>
    <text x="8" y="14" font-family="DejaVu Sans, Arial, sans-serif" font-size="9" font-weight="600">${esc(title)}</text>
    <text x="${w / 2}" y="${h - 6}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="8" fill="#333"></text>
    <text transform="translate(12,${h / 2}) rotate(-90)" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="8" fill="#333">${esc(yLabel)}</text>
  </g>`;
}

function gridLines(x0, y0, w, h, padL, padT, padB, yMin, yMax, n = 4) {
  let s = "";
  const plotW = w - padL - 12;
  const plotH = h - padT - padB;
  for (let i = 0; i <= n; i++) {
    const yy = y0 + padT + (plotH * i) / n;
    s += `<line x1="${x0 + padL}" y1="${yy}" x2="${x0 + padL + plotW}" y2="${yy}" stroke="${C.grid}" stroke-width="0.5"/>`;
    const val = yMax - ((yMax - yMin) * i) / n;
    s += `<text x="${x0 + padL - 4}" y="${yy + 3}" text-anchor="end" font-size="7" fill="#666">${val < 10 ? val.toFixed(1) : Math.round(val)}</text>`;
  }
  return s;
}

function bar(x, y, bw, bh, fill, stroke = "#222") {
  return `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="${fill}" stroke="${stroke}" stroke-width="0.4"/>`;
}

function buildSvg(data) {
  const W = 680;
  const H = 520;
  const pw = 310;
  const ph = 210;
  const labels = PATHS.map((p) => p[1]);
  const colors = [C.local, C.edge, C.gcs];
  const padL = 42;
  const padT = 28;
  const padB = 28;
  const barW = 36;
  const groupW = 90;

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="100%" height="100%" fill="#fff"/>
  <text x="${W / 2}" y="22" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="11" font-weight="700">Remote-to-visible readiness gap in Spark2.0 Web 3DGS streaming</text>
  <text x="${W / 2}" y="${H - 8}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="7.5" fill="#444">Spark2.0 only · n=4 (t0–t3) · phase_delivery_path_sanity · Remote R2 excluded</text>
`;

  // (a) First visible
  {
    const ox = 20;
    const oy = 36;
    const fvMeans = labels.map((l) => mean(data[l].fv_s));
    const fvMeds = labels.map((l) => median(data[l].fv_s));
    const yMax = Math.max(...labels.flatMap((l) => data[l].fv_s)) * 1.12;
    const yMin = 0;
    const ys = yScale(yMin, yMax, ph, padT, padB);
    svg += panelFrame(ox, oy, pw, ph, "(a) First visible latency", "First visible (s)");
    svg += `<g>${gridLines(ox, oy, pw, ph, padL, padT, padB, yMin, yMax)}</g>`;
    labels.forEach((lab, i) => {
      const cx = ox + padL + groupW * i + groupW / 2;
      const m = fvMeans[i];
      const bh = ys(yMin) - ys(m);
      svg += bar(cx - barW / 2, ys(m), barW, bh, colors[i]);
      data[lab].fv_s.forEach((v, j) => {
        const jx = cx + (j - 1.5) * 7;
        svg += `<circle cx="${jx}" cy="${ys(v)}" r="3" fill="#fff" stroke="${C.dot}" stroke-width="0.8"/>`;
        svg += `<text x="${jx}" y="${ys(v) - 6}" text-anchor="middle" font-size="5.5" fill="#555">${TRIALS[j]}</text>`;
      });
      const medY = ys(fvMeds[i]);
      svg += `<line x1="${cx - barW / 2 + 4}" y1="${medY}" x2="${cx + barW / 2 - 4}" y2="${medY}" stroke="#000" stroke-width="1.5"/>`;
      svg += `<text x="${cx}" y="${oy + ph - 10}" text-anchor="middle" font-size="8">${lab}</text>`;
    });
  }

  // (b) Early visible quality
  {
    const ox = 350;
    const oy = 36;
    const q5 = labels.map((l) => mean(data[l].q5_m));
    const q10 = labels.map((l) => mean(data[l].q10_m));
    const yMax = Math.max(...q10) * 1.15;
    const yMin = 0;
    const ys = yScale(yMin, yMax, ph, padT, padB);
    const w = 14;
    svg += panelFrame(ox, oy, pw, ph, "(b) Early visible quality", "Visible splats (M)");
    svg += `<g>${gridLines(ox, oy, pw, ph, padL, padT, padB, yMin, yMax)}</g>`;
    labels.forEach((lab, i) => {
      const cx = ox + padL + groupW * i + groupW / 2;
      svg += bar(cx - w - 1, ys(q5[i]), w, ys(yMin) - ys(q5[i]), C.q5);
      svg += bar(cx + 1, ys(q10[i]), w, ys(yMin) - ys(q10[i]), C.q10);
      svg += `<text x="${cx}" y="${oy + ph - 10}" text-anchor="middle" font-size="8">${lab}</text>`;
    });
    svg += `<rect x="${ox + pw - 95}" y="${oy + 34}" width="8" height="8" fill="${C.q5}"/><text x="${ox + pw - 84}" y="${oy + 42}" font-size="7">quality@5s</text>`;
    svg += `<rect x="${ox + pw - 95}" y="${oy + 46}" width="8" height="8" fill="${C.q10}"/><text x="${ox + pw - 84}" y="${oy + 54}" font-size="7">quality@10s</text>`;
    const gcsI = 2;
    svg += `<text x="${ox + padL + groupW * gcsI + 8}" y="${oy + 58}" font-size="7" fill="${C.annot}">GCS q5/q10 drop</text>`;
    svg += `<line x1="${ox + padL + groupW * gcsI + 20}" y1="${oy + 62}" x2="${ox + padL + groupW * gcsI + 8}" y2="${ys(q5[gcsI]) - 4}" stroke="#888" stroke-width="0.6"/>`;
  }

  // (c) Time to 1M
  {
    const ox = 20;
    const oy = 268;
    const means = labels.map((l) => mean(data[l].t1m_s));
    const yMax = Math.max(...means) * 1.12;
    const yMin = 0;
    const ys = yScale(yMin, yMax, ph, padT, padB);
    svg += panelFrame(ox, oy, pw, ph, "(c) Time to 1M visible splats", "Time (s)");
    svg += `<g>${gridLines(ox, oy, pw, ph, padL, padT, padB, yMin, yMax)}</g>`;
    svg += `<line x1="${ox + padL}" y1="${ys(means[0])}" x2="${ox + padL + groupW * 3}" y2="${ys(means[0])}" stroke="#bbb" stroke-dasharray="3,3" stroke-width="0.7"/>`;
    labels.forEach((lab, i) => {
      const cx = ox + padL + groupW * i + groupW / 2;
      const m = means[i];
      svg += bar(cx - barW / 2, ys(m), barW, ys(yMin) - ys(m), colors[i]);
      data[lab].t1m_s.forEach((v) => {
        svg += `<circle cx="${cx}" cy="${ys(v)}" r="2.5" fill="#fff" stroke="${C.dot}" stroke-width="0.7"/>`;
      });
      svg += `<text x="${cx}" y="${oy + ph - 10}" text-anchor="middle" font-size="8">${lab}</text>`;
    });
    svg += `<text x="${ox + padL + groupW * 2 + 12}" y="${oy + 50}" font-size="7" fill="${C.annot}">GCS t1M ↑</text>`;
    svg += `<path d="M ${ox + padL + groupW * 2 + 8} ${oy + 54} L ${ox + padL + groupW * 2 + 4} ${ys(means[2]) - 6}" stroke="#888" stroke-width="0.6" fill="none" marker-end="url(#arr)"/>`;
  }

  // (d) Pipeline tail
  {
    const ox = 350;
    const oy = 268;
    const fetch = labels.map((l) => mean(data[l].fetch_p95));
    const parse = labels.map((l) => mean(data[l].parse_p95));
    const yMax = Math.max(...parse) * 1.1;
    const yMin = 0;
    const ys = yScale(yMin, yMax, ph, padT, padB);
    const w = 14;
    svg += panelFrame(ox, oy, pw, ph, "(d) Pipeline tail latency", "p95 latency (ms)");
    svg += `<g>${gridLines(ox, oy, pw, ph, padL, padT, padB, yMin, yMax)}</g>`;
    labels.forEach((lab, i) => {
      const cx = ox + padL + groupW * i + groupW / 2;
      svg += bar(cx - w - 1, ys(fetch[i]), w, ys(yMin) - ys(fetch[i]), C.fetch);
      svg += bar(cx + 1, ys(parse[i]), w, ys(yMin) - ys(parse[i]), C.parse);
      svg += `<text x="${cx}" y="${oy + ph - 10}" text-anchor="middle" font-size="8">${lab}</text>`;
    });
    svg += `<rect x="${ox + padL + 4}" y="${oy + 34}" width="8" height="8" fill="${C.fetch}"/><text x="${ox + padL + 16}" y="${oy + 42}" font-size="7">fetch p95</text>`;
    svg += `<rect x="${ox + padL + 4}" y="${oy + 46}" width="8" height="8" fill="${C.parse}"/><text x="${ox + padL + 16}" y="${oy + 54}" font-size="7">parse p95</text>`;
  }

  svg += `<defs><marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#888"/></marker></defs>`;
  svg += `</svg>`;
  return svg;
}

async function svgToPng(svg) {
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 2040 } });
  return resvg.render().asPng();
}

async function pngToPdf(pngBuf) {
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(pngBuf);
  const page = doc.addPage([img.width * 0.75, img.height * 0.75]);
  page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  return Buffer.from(await doc.save());
}

async function main() {
  const data = collect();
  const svg = buildSvg(data);
  fs.writeFileSync(`${OUT_BASE}.svg`, svg);

  const png = await svgToPng(svg);
  fs.writeFileSync(`${OUT_BASE}.png`, png);

  const pdf = await pngToPdf(png);
  fs.writeFileSync(`${OUT_BASE}.pdf`, pdf);

  console.log(`Wrote ${OUT_BASE}.svg`);
  console.log(`Wrote ${OUT_BASE}.png`);
  console.log(`Wrote ${OUT_BASE}.pdf`);
  for (const [, lab] of PATHS) {
    const d = data[lab];
    console.log(
      `  ${lab}: FV=${mean(d.fv_s).toFixed(2)}s, q5=${mean(d.q5_m).toFixed(2)}M, q10=${mean(d.q10_m).toFixed(2)}M, t1M=${mean(d.t1m_s).toFixed(2)}s`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
