import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const out = { root: "", runIds: "", out: "" };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "root") out.root = v;
    else if (k === "runIds") out.runIds = v;
    else if (k === "out") out.out = v;
  }
  return out;
}

async function readJsonl(file) {
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function isDebugProbeUrl(u) {
  return typeof u === "string" && /\/debug-scene-probe\.rad(\?|$)/i.test(u);
}

function pearson(xs, ys) {
  if (!xs.length || xs.length !== ys.length) return null;
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

function rank(arr) {
  const idx = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const r = Array(arr.length).fill(0);
  for (let i = 0; i < idx.length; i += 1) r[idx[i].i] = i + 1;
  return r;
}

function spearman(xs, ys) {
  if (!xs.length || xs.length !== ys.length) return null;
  return pearson(rank(xs), rank(ys));
}

function bucketStats(points) {
  const bounds = [64 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024];
  const labels = ["<=64KB", "64-256KB", "256KB-1MB", "1-4MB", ">4MB"];
  const bins = labels.map((l) => ({ bucket: l, points: [] }));
  for (const p of points) {
    const b = Number(p.upstream_bytes || 0);
    let i = 4;
    if (b <= bounds[0]) i = 0;
    else if (b <= bounds[1]) i = 1;
    else if (b <= bounds[2]) i = 2;
    else if (b <= bounds[3]) i = 3;
    bins[i].points.push(p.upstream_service_delay);
  }
  return bins.map((b) => {
    const xs = b.points.filter((x) => Number.isFinite(x));
    if (!xs.length) return { bucket: b.bucket, n: 0, mean_service_delay: null, p95_service_delay: null };
    const ys = [...xs].sort((a, c) => a - c);
    const p95 = ys[Math.min(ys.length - 1, Math.max(0, Math.ceil(0.95 * ys.length) - 1))];
    return { bucket: b.bucket, n: ys.length, mean_service_delay: ys.reduce((a, c) => a + c, 0) / ys.length, p95_service_delay: p95 };
  });
}

function esc(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function writeScatterSvg(file, title, points) {
  const w = 900;
  const h = 540;
  const l = 70;
  const r = 30;
  const t = 40;
  const b = 70;
  const pw = w - l - r;
  const ph = h - t - b;
  const xs = points.map((p) => Number(p.upstream_bytes)).filter((x) => Number.isFinite(x));
  const ys = points.map((p) => Number(p.upstream_service_delay)).filter((x) => Number.isFinite(x));
  const xMin = 0;
  const xMax = xs.length ? Math.max(...xs) : 1;
  const yMin = 0;
  const yMax = ys.length ? Math.max(...ys) : 1;
  const sx = (x) => l + (x / Math.max(1, xMax)) * pw;
  const sy = (y) => h - b - (y / Math.max(1, yMax)) * ph;
  const circles = points
    .map((p) => `<circle cx="${sx(p.upstream_bytes).toFixed(2)}" cy="${sy(p.upstream_service_delay).toFixed(2)}" r="2.5" fill="#1f77b4" fill-opacity="0.55" />`)
    .join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <rect x="0" y="0" width="${w}" height="${h}" fill="white"/>
  <text x="${l}" y="24" font-family="Arial" font-size="16">${esc(title)}</text>
  <line x1="${l}" y1="${h - b}" x2="${w - r}" y2="${h - b}" stroke="#333"/>
  <line x1="${l}" y1="${h - b}" x2="${l}" y2="${t}" stroke="#333"/>
  <text x="${w - r - 140}" y="${h - 20}" font-family="Arial" font-size="12">upstream_bytes</text>
  <text x="8" y="${t + 10}" font-family="Arial" font-size="12">service_delay_ms</text>
  ${circles}
</svg>`;
  await fs.writeFile(file, svg, "utf8");
}

function buildPdfText(title, stats) {
  const lines = [`Service vs Bytes: ${title}`];
  lines.push(`n=${stats.n}, pearson=${stats.pearson}, spearman=${stats.spearman}`);
  for (const b of stats.bucket_summary) lines.push(`${b.bucket}: n=${b.n}, mean=${b.mean_service_delay}, p95=${b.p95_service_delay}`);
  return lines.join("\n");
}

function writeSimplePdf(file, text) {
  const content = `BT /F1 12 Tf 36 760 Td (${text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)").replaceAll("\n", ") Tj T* (")}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offs = [0];
  for (let i = 0; i < objs.length; i += 1) {
    offs.push(Buffer.byteLength(body, "utf8"));
    body += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, "utf8");
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i += 1) body += `${String(offs[i]).padStart(10, "0")} 00000 n \n`;
  body += `trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return fs.writeFile(file, body, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root || !args.runIds || !args.out) throw new Error("need --root --runIds --out");
  const root = path.resolve(args.root);
  const ids = args.runIds.split(",").map((x) => x.trim()).filter(Boolean);
  const runs = [];
  let all = [];
  for (const runId of ids) {
    const pRows = (await readJsonl(path.join(root, runId, "proxy", "proxy.jsonl"))).filter(
      (p) =>
        (!p.event || p.event === "request_complete") &&
        String(p.run_id || "") === String(runId) &&
        !isDebugProbeUrl(String(p.url || "")),
    );
    const pts = pRows
      .map((p) => ({
        upstream_bytes: Number(p.upstream_bytes || 0),
        upstream_service_delay: Number(p.upstream_end_ts || 0) - Number(p.upstream_start_ts || p.phase_timestamps?.upstream_fetch_started || 0),
      }))
      .filter((p) => Number.isFinite(p.upstream_bytes) && Number.isFinite(p.upstream_service_delay) && p.upstream_service_delay >= 0);
    const xs = pts.map((p) => p.upstream_bytes);
    const ys = pts.map((p) => p.upstream_service_delay);
    const stats = {
      run_id: runId,
      n: pts.length,
      pearson: pearson(xs, ys),
      spearman: spearman(xs, ys),
      bucket_summary: bucketStats(pts),
    };
    runs.push(stats);
    all = all.concat(pts);
    const outDir = path.dirname(path.resolve(args.out));
    await fs.mkdir(outDir, { recursive: true });
    await writeScatterSvg(path.join(outDir, `service-vs-bytes-${runId.includes("B-lockstep") ? "B" : runId.includes("C-nearcohort") ? "C" : runId.includes("D-divergent") ? "D" : runId}.svg`), runId, pts);
    await writeSimplePdf(
      path.join(outDir, `service-vs-bytes-${runId.includes("B-lockstep") ? "B" : runId.includes("C-nearcohort") ? "C" : runId.includes("D-divergent") ? "D" : runId}.pdf`),
      buildPdfText(runId, stats),
    );
  }
  const axs = all.map((p) => p.upstream_bytes);
  const ays = all.map((p) => p.upstream_service_delay);
  const allStats = {
    n: all.length,
    pearson: pearson(axs, ays),
    spearman: spearman(axs, ays),
    bucket_summary: bucketStats(all),
  };
  const outDir = path.dirname(path.resolve(args.out));
  await writeScatterSvg(path.join(outDir, "service-vs-bytes-all.svg"), "all-runs", all);
  await writeSimplePdf(path.join(outDir, "service-vs-bytes-all.pdf"), buildPdfText("all-runs", allStats));
  const out = {
    generated_at: new Date().toISOString(),
    runs,
    all_runs: allStats,
    service_delay_strongly_size_correlated: Math.abs(Number(allStats.pearson || 0)) >= 0.6 || Math.abs(Number(allStats.spearman || 0)) >= 0.6,
  };
  const outPath = path.resolve(args.out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

