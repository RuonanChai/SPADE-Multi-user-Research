/**
 * Generate motivation figures as SVG for the VRC paper.
 * node vrc-paper/paper/figures/gen_motivation_figures.mjs
 */
import fs from "node:fs";
import path from "node:path";

const outDir = "vrc-paper/paper/figures";
fs.mkdirSync(outDir, { recursive: true });

// ============================================================
// Figure 1: Three-tier chunk completion (SVG bar chart)
// ============================================================
const data = {
  tiers: ["Local baseline", "Origin server", "Remote server"],
  scenarios: ["Normal streaming", "Fetch-only", "Pure render"],
  chunks: [[230, 140, 0], [295, 66, 0], [17, 5, 0]],
  fps: [[86.9, 129.2, 115.5], [90.2, 164.8, 97.2], [156.3, 165.0, 164.9]],
  p95: [30, 459, 15872],
  colors: ["#4477AA", "#228833", "#EE6677"],
};

const W = 520, H = 320, ML = 60, MR = 70, MT = 30, MB = 60;
const plotW = W - ML - MR, plotH = H - MT - MB;
const maxChunks = 340;
const barGroupW = plotW / 3;
const barW = barGroupW / 4;

let svg1 = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Helvetica, Arial, sans-serif" font-size="9">`;
svg1 += `<rect width="${W}" height="${H}" fill="white"/>`;

// Y-axis (chunks)
for (let v = 0; v <= 300; v += 100) {
  const y = MT + plotH - (v / maxChunks) * plotH;
  svg1 += `<line x1="${ML}" y1="${y}" x2="${ML + plotW}" y2="${y}" stroke="#eee" stroke-width="0.5"/>`;
  svg1 += `<text x="${ML - 5}" y="${y + 3}" text-anchor="end" font-size="7.5">${v}</text>`;
}
svg1 += `<text x="${15}" y="${MT + plotH / 2}" text-anchor="middle" font-size="8" transform="rotate(-90,15,${MT + plotH / 2})">Chunks completed (40 s)</text>`;

// Bars
for (let s = 0; s < 3; s++) {
  const gx = ML + s * barGroupW + barGroupW / 2;
  svg1 += `<text x="${gx}" y="${H - MB + 30}" text-anchor="middle" font-size="7.5">${data.scenarios[s]}</text>`;
  for (let t = 0; t < 3; t++) {
    const val = data.chunks[t][s];
    const bx = ML + s * barGroupW + (t + 0.5) * barW;
    const bh = (val / maxChunks) * plotH;
    const by = MT + plotH - bh;
    svg1 += `<rect x="${bx}" y="${by}" width="${barW * 0.8}" height="${bh}" fill="${data.colors[t]}" opacity="0.85"/>`;
    if (val > 0) svg1 += `<text x="${bx + barW * 0.4}" y="${by - 3}" text-anchor="middle" font-size="6.5">${val}</text>`;
  }
}

// P95 line (log scale on right axis, normal streaming only)
const logMin = Math.log10(10), logMax = Math.log10(50000);
const logY = (v) => MT + plotH - ((Math.log10(v) - logMin) / (logMax - logMin)) * plotH;
svg1 += `<text x="${W - 10}" y="${MT + plotH / 2}" text-anchor="middle" font-size="8" transform="rotate(90,${W - 10},${MT + plotH / 2})">Chunk p95 (ms, log)</text>`;
for (const v of [10, 100, 1000, 10000]) {
  const y = logY(v);
  svg1 += `<text x="${ML + plotW + 5}" y="${y + 3}" font-size="6.5" fill="#555">${v >= 1000 ? (v/1000)+"k" : v}</text>`;
}
const pts = data.p95.map((v, i) => `${ML + i * barGroupW + barGroupW / 2},${logY(v)}`).join(" ");
svg1 += `<polyline points="${pts}" fill="none" stroke="#333" stroke-width="1.2" stroke-dasharray="4,2"/>`;
data.p95.forEach((v, i) => {
  const cx = ML + i * barGroupW + barGroupW / 2, cy = logY(v);
  svg1 += `<rect x="${cx - 3}" y="${cy - 3}" width="6" height="6" fill="#333"/>`;
  svg1 += `<text x="${cx}" y="${cy - 7}" text-anchor="middle" font-size="6" fill="#333">${v >= 1000 ? Math.round(v/1000)+"k" : v} ms</text>`;
});

// Legend
const lx = ML + 5, ly = MT + 10;
data.tiers.forEach((t, i) => {
  svg1 += `<rect x="${lx}" y="${ly + i * 14}" width="10" height="10" fill="${data.colors[i]}" opacity="0.85"/>`;
  svg1 += `<text x="${lx + 14}" y="${ly + i * 14 + 9}" font-size="7">${t}</text>`;
});

// "fast but empty" annotation
svg1 += `<text x="${ML + 2.2 * barGroupW}" y="${MT + plotH - 30}" font-size="7" fill="${data.colors[2]}" font-style="italic">"fast but empty"</text>`;
svg1 += `<line x1="${ML + 2.15 * barGroupW}" y1="${MT + plotH - 25}" x2="${ML + 2 * barGroupW + barW * 0.9}" y2="${MT + plotH - 5}" stroke="${data.colors[2]}" stroke-width="0.7" marker-end="url(#arrow)"/>`;
svg1 += `<defs><marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="${data.colors[2]}"/></marker></defs>`;

svg1 += `<text x="${W/2}" y="${H - 5}" text-anchor="middle" font-size="7.5" font-weight="bold">Figure 1: Chunk delivery across three tiers (single-user, 40 s measurement)</text>`;
svg1 += `</svg>`;

fs.writeFileSync(path.join(outDir, "motivation_bottleneck.svg"), svg1);
console.log("Figure 1 saved: motivation_bottleneck.svg");

// ============================================================
// Figure 2: Cold-start + Multi-user (two panels)
// ============================================================
const W2 = 700, H2 = 220;
let svg2 = `<svg xmlns="http://www.w3.org/2000/svg" width="${W2}" height="${H2}" font-family="Helvetica, Arial, sans-serif" font-size="9">`;
svg2 += `<rect width="${W2}" height="${H2}" fill="white"/>`;

// Panel A: Cold-start horizontal bars
const panelAx = 30, panelAw = 300, panelAy = 25;
const coldData = [
  { label: "Local baseline", val: 1440, color: "#4477AA" },
  { label: "Origin server", val: 1122, color: "#228833" },
  { label: "Remote server", val: 6703, color: "#EE6677" },
];
const maxCold = 8000;
svg2 += `<text x="${panelAx}" y="${panelAy - 8}" font-size="8.5" font-weight="bold">(a) Cold-start: time to first visible splat</text>`;
coldData.forEach((d, i) => {
  const by = panelAy + i * 50 + 10;
  const bw = (d.val / maxCold) * panelAw;
  svg2 += `<text x="${panelAx}" y="${by + 12}" font-size="7.5">${d.label}</text>`;
  svg2 += `<rect x="${panelAx + 95}" y="${by}" width="${bw}" height="22" fill="${d.color}" opacity="0.8" rx="2"/>`;
  svg2 += `<text x="${panelAx + 95 + bw + 5}" y="${by + 14}" font-size="7">${d.val.toLocaleString()} ms</text>`;
});
// 2s reference line
const ref2s = (2000 / maxCold) * panelAw + panelAx + 95;
svg2 += `<line x1="${ref2s}" y1="${panelAy + 5}" x2="${ref2s}" y2="${panelAy + 160}" stroke="gray" stroke-dasharray="3,2" stroke-width="0.7"/>`;
svg2 += `<text x="${ref2s + 3}" y="${panelAy + 165}" font-size="6" fill="gray">2 s</text>`;
// 6x annotation
svg2 += `<text x="${panelAx + 300}" y="${panelAy + 135}" font-size="7" fill="${coldData[2].color}" font-style="italic">6× slower</text>`;

// Panel B: Multi-user paired bars
const panelBx = 400, panelBw = 260, panelBy = 25;
svg2 += `<text x="${panelBx}" y="${panelBy - 8}" font-size="8.5" font-weight="bold">(b) 4-user trace-based sequential</text>`;

const multiData = [
  { label: "Local", chunks: 288, p95: 80, color: "#4477AA" },
  { label: "Remote", chunks: 12, p95: 21141, color: "#EE6677" },
];
const maxMChunks = 340, maxMP95 = 25000;
const mbw = 40;

multiData.forEach((d, i) => {
  const bx = panelBx + 50 + i * 120;
  // Chunk bar
  const ch = (d.chunks / maxMChunks) * 130;
  svg2 += `<rect x="${bx}" y="${panelBy + 140 - ch}" width="${mbw}" height="${ch}" fill="${d.color}" opacity="0.85" rx="2"/>`;
  svg2 += `<text x="${bx + mbw/2}" y="${panelBy + 140 - ch - 4}" text-anchor="middle" font-size="7">${d.chunks}</text>`;
  // P95 bar (hatched)
  const ph = (d.p95 / maxMP95) * 130;
  svg2 += `<rect x="${bx + mbw + 5}" y="${panelBy + 140 - ph}" width="${mbw}" height="${ph}" fill="${d.color}" opacity="0.3" rx="2" stroke="${d.color}" stroke-width="0.5"/>`;
  svg2 += `<text x="${bx + mbw + 5 + mbw/2}" y="${panelBy + 140 - ph - 4}" text-anchor="middle" font-size="6.5">${d.p95 >= 1000 ? Math.round(d.p95/1000)+"k" : d.p95} ms</text>`;
  // Label
  svg2 += `<text x="${bx + mbw}" y="${panelBy + 158}" text-anchor="middle" font-size="7">${d.label}</text>`;
});
// Legend
svg2 += `<rect x="${panelBx + 50}" y="${panelBy + 170}" width="8" height="8" fill="#888" opacity="0.85"/>`;
svg2 += `<text x="${panelBx + 62}" y="${panelBy + 178}" font-size="6.5">Chunks/client</text>`;
svg2 += `<rect x="${panelBx + 140}" y="${panelBy + 170}" width="8" height="8" fill="#888" opacity="0.3" stroke="#888"/>`;
svg2 += `<text x="${panelBx + 152}" y="${panelBy + 178}" font-size="6.5">Chunk p95 (ms)</text>`;
// Amplification
svg2 += `<text x="${panelBx + 170}" y="${panelBy + 50}" font-size="7" fill="${multiData[1].color}" font-style="italic">24× fewer chunks</text>`;
svg2 += `<text x="${panelBx + 170}" y="${panelBy + 62}" font-size="7" fill="${multiData[1].color}" font-style="italic">265× higher latency</text>`;

svg2 += `</svg>`;

fs.writeFileSync(path.join(outDir, "motivation_coldstart_multiuser.svg"), svg2);
console.log("Figure 2 saved: motivation_coldstart_multiuser.svg");

console.log("All figures generated as SVG.");
