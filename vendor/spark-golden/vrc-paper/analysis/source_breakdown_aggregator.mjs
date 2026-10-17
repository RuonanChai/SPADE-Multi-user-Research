/**
 * Aggregates source_breakdown.json from each raw session into summary/source_breakdown.csv.
 * Validates CDN labels, delivery profiles, and dual-machine constraints.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RESULTS_ROOT = process.env.VRC_RESULTS_ROOT
  ? path.resolve(process.env.VRC_RESULTS_ROOT)
  : path.join(ROOT, "results");
const RAW = path.join(RESULTS_ROOT, "raw");
const SUMMARY = path.join(RESULTS_ROOT, "summary");
fs.mkdirSync(SUMMARY, { recursive: true });

function writeCsv(rows, file) {
  if (!rows.length) return;
  const keys = [...new Set(rows.flatMap(Object.keys))];
  const lines = rows.map(r => keys.map(k => {
    const v = r[k];
    if (v == null) return "";
    const s = String(v);
    return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(","));
  fs.writeFileSync(file, [keys.join(","), ...lines].join("\n") + "\n");
}

function main() {
  if (!fs.existsSync(RAW)) {
    console.log("[source_breakdown] No raw/ directory found.");
    process.exit(1);
  }

  const dirs = fs.readdirSync(RAW).filter(d => {
    return fs.statSync(path.join(RAW, d)).isDirectory() && !d.startsWith("_shardwork");
  });

  const rows = [];
  for (const d of dirs) {
    const sbFile = path.join(RAW, d, "source_breakdown.json");
    if (!fs.existsSync(sbFile)) continue;
    try {
      const sb = JSON.parse(fs.readFileSync(sbFile, "utf8"));
      const parts = d.split("_");
      rows.push({
        session_id: d,
        method: parts[0] || "",
        scenario: parts[1] || "",
        delivery_profile: sb.delivery_profile || "",
        cdn_label: sb.cdn_label || "",
        hpc_request_count: sb.hpc_request_count ?? sb.origin_request_count ?? 0,
        cdn_request_count: sb.cdn_request_count ?? sb.cdn1_request_count ?? 0,
        cdn2_request_count: sb.cdn2_request_count ?? 0,
        total_request_count: sb.total_request_count ?? 0,
        hpc_bytes: sb.hpc_bytes ?? sb.origin_bytes ?? 0,
        cdn_bytes: sb.cdn_bytes ?? sb.cdn1_bytes ?? 0,
        cdn2_bytes: sb.cdn2_bytes ?? 0,
        fallback_count: sb.fallback_count ?? 0,
        source_validation_ok: sb.source_validation_ok ?? "",
        worker1_users: sb.worker1_users ?? "",
        worker2_users: sb.worker2_users ?? "",
        host_ips: sb.host_ips ? (Array.isArray(sb.host_ips) ? sb.host_ips.join(";") : sb.host_ips) : "",
      });
    } catch {}
  }

  writeCsv(rows, path.join(SUMMARY, "source_breakdown.csv"));
  console.log(`[source_breakdown] Wrote ${rows.length} rows → summary/source_breakdown.csv`);
}

main();
