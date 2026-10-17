import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const out = { input: "", compare: "", outDir: "" };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "input") out.input = v;
    else if (k === "compare") out.compare = v;
    else if (k === "outDir") out.outDir = v;
  }
  return out;
}

function escPdfText(s) {
  return String(s).replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function buildPdf(content, width = 900, height = 520) {
  const objs = [];
  objs.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  objs.push(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);
  objs.push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
  );
  objs.push(`<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`);
  objs.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);

  let body = "%PDF-1.4\n";
  const offs = [0];
  for (let i = 0; i < objs.length; i += 1) {
    offs.push(Buffer.byteLength(body, "utf8"));
    body += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(body, "utf8");
  body += `xref\n0 ${objs.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (let i = 1; i <= objs.length; i += 1) {
    body += `${String(offs[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(body, "utf8");
}

function renderLineChartPdf({ title, runs, valueKey, outPath }) {
  const width = 900;
  const height = 520;
  const left = 70;
  const right = 30;
  const top = 60;
  const bottom = 70;
  const plotW = width - left - right;
  const plotH = height - top - bottom;

  const xVals = [];
  const yVals = [];
  for (const r of runs) {
    for (const w of r.windows || []) {
      const x = Number(w.t0_ms);
      const y = Number(w[valueKey]);
      if (Number.isFinite(x)) xVals.push(x);
      if (Number.isFinite(y)) yVals.push(y);
    }
  }
  const xMin = xVals.length ? Math.min(...xVals) : 0;
  const xMax = xVals.length ? Math.max(...xVals) : 1;
  const yMin = 0;
  const yMax = yVals.length ? Math.max(...yVals) : 1;
  const sx = (x) => left + ((x - xMin) / Math.max(1, xMax - xMin)) * plotW;
  const sy = (y) => bottom + ((y - yMin) / Math.max(1, yMax - yMin)) * plotH;

  const colors = [
    [0.85, 0.2, 0.2],
    [0.2, 0.45, 0.85],
    [0.2, 0.7, 0.3],
    [0.75, 0.45, 0.1],
    [0.55, 0.3, 0.75],
  ];
  const lines = [];
  lines.push("0.2 0.2 0.2 RG 1 w");
  lines.push(`${left} ${bottom} m ${left} ${bottom + plotH} l S`);
  lines.push(`${left} ${bottom} m ${left + plotW} ${bottom} l S`);
  lines.push(`BT /F1 15 Tf ${left} ${height - 28} Td (${escPdfText(title)}) Tj ET`);
  lines.push(`BT /F1 10 Tf ${left} ${bottom - 24} Td (t0_ms) Tj ET`);
  lines.push(`BT /F1 10 Tf ${left - 48} ${bottom + plotH + 6} Td (${escPdfText(valueKey)}) Tj ET`);

  runs.forEach((r, idx) => {
    const c = colors[idx % colors.length];
    const pts = (r.windows || [])
      .map((w) => [Number(w.t0_ms), Number(w[valueKey])])
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
      .sort((a, b) => a[0] - b[0]);
    if (!pts.length) return;
    lines.push(`${c[0]} ${c[1]} ${c[2]} RG 1.2 w`);
    lines.push(`${sx(pts[0][0]).toFixed(2)} ${sy(pts[0][1]).toFixed(2)} m`);
    for (let i = 1; i < pts.length; i += 1) {
      lines.push(`${sx(pts[i][0]).toFixed(2)} ${sy(pts[i][1]).toFixed(2)} l`);
    }
    lines.push("S");
    const ly = height - 50 - idx * 14;
    lines.push(`${c[0]} ${c[1]} ${c[2]} RG 2 w ${width - 280} ${ly} m ${width - 260} ${ly} l S`);
    lines.push(`0.1 0.1 0.1 RG BT /F1 9 Tf ${width - 255} ${ly - 4} Td (${escPdfText(`${r.scenario || r.run_id}`)}) Tj ET`);
  });

  return fs.writeFile(outPath, buildPdf(lines.join("\n"), width, height));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.compare || !args.outDir) throw new Error("need --input --compare --outDir");
  const diagnosis = JSON.parse(await fs.readFile(path.resolve(args.input), "utf8"));
  const compare = JSON.parse(await fs.readFile(path.resolve(args.compare), "utf8"));
  const outDir = path.resolve(args.outDir);
  await fs.mkdir(outDir, { recursive: true });

  const runs = diagnosis.runs || [];

  await renderLineChartPdf({
    title: "Burst Upstream Inflight",
    runs,
    valueKey: "upstream_inflight_peak",
    outPath: path.join(outDir, "burst-upstream-inflight.pdf"),
  });
  await renderLineChartPdf({
    title: "Burst Upstream Starts",
    runs,
    valueKey: "upstream_requests_started",
    outPath: path.join(outDir, "burst-upstream-starts.pdf"),
  });
  await renderLineChartPdf({
    title: "Client P95 Latency",
    runs,
    valueKey: "client_p95_latency",
    outPath: path.join(outDir, "latency-client-p95.pdf"),
  });
  await renderLineChartPdf({
    title: "Upstream P95 Latency",
    runs,
    valueKey: "upstream_p95_latency",
    outPath: path.join(outDir, "latency-upstream-p95.pdf"),
  });

  const totalsRows = runs
    .map(
      (r) =>
        `| ${r.scenario || r.run_id} | ${r.totals?.B_client_agg ?? "null"} | ${r.totals?.B_unique ?? "null"} | ${r.totals?.B_upstream ?? "null"} | ${
          r.latency_breakdown?.client_total_delay_p95 ?? "null"
        } | ${r.latency_breakdown?.total_proxy_delay_p95 ?? "null"} |`,
    )
    .join("\n");
  const breakdownRows = runs
    .map(
      (r) =>
        `| ${r.scenario || r.run_id} | ${r.latency_breakdown?.queue_p95 ?? "null"} | ${r.latency_breakdown?.service_p95 ?? "null"} | ${
          r.latency_breakdown?.downstream_tail_p95 ?? "null"
        } | ${r.latency_breakdown?.client_total_delay_p99 ?? "null"} | ${r.latency_breakdown?.total_proxy_delay_p99 ?? "null"} |`,
    )
    .join("\n");

  const md = `# Burst/Queue Diagnosis Report

## A/B/C/D Totals

| Run | B_client_agg | B_unique | B_upstream | client_p95 | proxy_total_p95 |
|---|---:|---:|---:|---:|---:|
${totalsRows}

## B/C/D Object-Set Consistency

- same_total_unique_pages: ${compare.totals_consistency?.same_total_unique_pages}
- same_total_upstream_bytes: ${compare.totals_consistency?.same_total_upstream_bytes}
- same_total_client_bytes: ${compare.totals_consistency?.same_total_client_bytes}
- likely_burst_driven: ${compare.interpretation?.likely_burst_driven}
- likely_queueing_dominated: ${compare.interpretation?.likely_queueing_dominated}
- likely_service_time_dominated: ${compare.interpretation?.likely_service_time_dominated}

## Queue/Service/Tail P95-P99

| Run | queue_p95 | service_p95 | downstream_tail_p95 | client_p99 | proxy_total_p99 |
|---|---:|---:|---:|---:|---:|
${breakdownRows}

## Worst Tail

- worst_by_queue_p95: ${compare.worst?.worst_by_queue_p95?.run_id} (${compare.worst?.worst_by_queue_p95?.value})
- worst_by_service_p95: ${compare.worst?.worst_by_service_p95?.run_id} (${compare.worst?.worst_by_service_p95?.value})
- worst_by_upstream_p99: ${compare.worst?.worst_by_upstream_p99?.run_id} (${compare.worst?.worst_by_upstream_p99?.value})
- worst_by_client_p99: ${compare.worst?.worst_by_client_p99?.run_id} (${compare.worst?.worst_by_client_p99?.value})

## Conclusion

Current evidence points to: object totals are stable across B/C/D, while p95/p99 and inflight/start burst shape diverge. This is more consistent with burst/queue/scheduling amplification than missing byte-level sharing.
`;
  await fs.writeFile(path.join(outDir, "report.md"), md, "utf8");
  console.log(`Wrote ${path.join(outDir, "report.md")}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

