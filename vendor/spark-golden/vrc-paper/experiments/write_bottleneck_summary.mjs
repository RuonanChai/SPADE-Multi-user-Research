/**
 * Write single_user_bottleneck_summary.md after local perf probe.
 */
import fs from "node:fs";
import path from "node:path";

export function writeBottleneckSummary(runDir, { sessionId, perClientRows, auditPaths }) {
  const lines = [
    "# Single-user bottleneck summary",
    "",
    `session_id: \`${sessionId}\``,
    `generated: ${new Date().toISOString()}`,
    "",
    "## Audit artifacts",
    "",
  ];
  for (const [k, v] of Object.entries(auditPaths || {})) {
    lines.push(`- **${k}**: \`${v}\``);
  }
  lines.push("", "## Per-user attribution", "", "| user | attribution | confidence | net_p95_ms | p95_http_ms | fps | trace_ok | resource_timing_ok | reason |", "|------|-------------|------------|------------|-------------|-----|----------|---------------------|--------|");
  for (const r of perClientRows || []) {
    lines.push(`| ${r.user_id} | ${r.latency_attribution ?? ""} | ${r.latency_attribution_confidence ?? ""} | ${r.net_total_p95_ms ?? ""} | ${r.p95_latency_ms ?? ""} | ${r.fps ?? ""} | ${r.trace_ok ?? ""} | ${r.resource_timing_ok ?? ""} | ${String(r.attribution_reason ?? "").slice(0, 80)} |`);
  }
  lines.push(
    "",
    "## How to read",
    "",
    "- **network**: CDP Network `network_total_ms` / `ttfb_ms` on `.rad` requests (authoritative for HTTP).",
    "- **browser_main_thread**: Chrome trace `trace_main_script_ms` / long tasks.",
    "- **rendering_gpu**: trace composite/GPU/raster + low fps (not HTTP p50).",
    "- **metrics_collection_bug**: Playwright log vs CDP mismatch, zero `encodedDataLength`, or missing audits.",
    "",
    "Playwright `p50_latency_ms` uses response header timing (Content-Length, no body read) — compare to `net_total_p95_ms` in `cdp_network_audit.csv`.",
    "Many **206** responses with `bytes_sent=0` in Playwright often mean **header-only timing**, not zero network bytes — see CDP `encodedDataLength`.",
    "",
  );
  const out = path.join(runDir, "single_user_bottleneck_summary.md");
  fs.writeFileSync(out, lines.join("\n"), "utf8");
  const summaryCopy = path.join(path.dirname(runDir), "..", "summary", "single_user_bottleneck_summary.md");
  try {
    fs.mkdirSync(path.dirname(summaryCopy), { recursive: true });
    fs.writeFileSync(summaryCopy, lines.join("\n"), "utf8");
  } catch { /* */ }
  return out;
}
