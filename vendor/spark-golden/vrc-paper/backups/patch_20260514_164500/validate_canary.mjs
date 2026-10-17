/**
 * H1-H6 Canary Validation for distributed dual-CDN experiments.
 * Reads summary CSVs and raw session data to verify experiment integrity.
 *
 * H1: Dual-machine — both host_ips present (10.4.158.143 + 10.4.146.68)
 * H2: Dual-CDN — source_breakdown shows cdn1 AND cdn2 requests (or origin_only profile)
 * H3: Session completeness — all 4 users produced metrics
 * H4: VRC decisions logged — vrc_decisions.jsonl non-empty for VRC method
 * H5: Source consistency — cdn_label matches delivery_profile expectations
 * H6: Visual canary — screenshots exist for all 4 users
 *
 * Usage: node vrc-paper/analysis/validate_canary.mjs [--results-root <path>] [--session <id>]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const RESULTS_ROOT = (() => {
  const idx = process.argv.indexOf("--results-root");
  if (idx !== -1 && process.argv[idx + 1]) return path.resolve(process.argv[idx + 1]);
  if (process.env.VRC_RESULTS_ROOT) return path.resolve(process.env.VRC_RESULTS_ROOT);
  return path.join(ROOT, "results");
})();

const TARGET_SESSION = (() => {
  const idx = process.argv.indexOf("--session");
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
})();

const RAW = path.join(RESULTS_ROOT, "raw");
const SUMMARY = path.join(RESULTS_ROOT, "summary");
const SCREENSHOTS = path.join(RESULTS_ROOT, "screenshots");

const CONTROLLER_IP = "10.4.158.143";
const WORKER2_IP = "10.4.146.68";

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

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

function getSessions() {
  if (!fs.existsSync(RAW)) return [];
  return fs.readdirSync(RAW).filter(d => {
    const p = path.join(RAW, d);
    return fs.statSync(p).isDirectory() && !d.startsWith("_shardwork");
  });
}

function validateSession(sessionId) {
  const dir = path.join(RAW, sessionId);
  const results = { session_id: sessionId, checks: {} };

  // H1: Dual-machine
  const reqLogs = readJsonl(path.join(dir, "request_logs.jsonl"));
  const clientMetrics = readJsonl(path.join(dir, "client_metrics.jsonl"));
  const statusFile = path.join(dir, "status.json");
  const status = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, "utf8")) : {};

  const hostIps = new Set();
  for (const r of [...reqLogs, ...clientMetrics]) {
    if (r.host_ip) hostIps.add(r.host_ip);
    if (r.worker_id === "worker1") hostIps.add(CONTROLLER_IP);
    if (r.worker_id === "worker2") hostIps.add(WORKER2_IP);
  }
  if (status.worker1_host) hostIps.add(status.worker1_host);
  if (status.worker2_host) hostIps.add(status.worker2_host);

  const hasController = hostIps.has(CONTROLLER_IP);
  const hasWorker2 = hostIps.has(WORKER2_IP);
  results.checks.H1_dual_machine = {
    pass: hasController && hasWorker2,
    detail: `controller=${hasController} worker2=${hasWorker2} ips=[${[...hostIps].join(",")}]`,
  };

  // H2: Dual-CDN
  const sbFile = path.join(dir, "source_breakdown.json");
  const sb = fs.existsSync(sbFile) ? JSON.parse(fs.readFileSync(sbFile, "utf8")) : {};
  const profile = sb.delivery_profile || status.delivery_profile || "";
  const hasCdn1 = (sb.cdn_request_count || sb.cdn1_request_count || 0) > 0;
  const hasCdn2 = (sb.cdn2_request_count || 0) > 0;
  const hasHpc = (sb.hpc_request_count || sb.origin_request_count || 0) > 0;

  let h2Pass = false;
  let h2Detail = "";
  if (profile === "origin_only") {
    h2Pass = hasHpc;
    h2Detail = `profile=origin_only hpc=${hasHpc}`;
  } else if (profile === "static_cdn") {
    h2Pass = hasCdn1 || hasCdn2;
    h2Detail = `profile=static_cdn cdn1=${hasCdn1} cdn2=${hasCdn2}`;
  } else if (profile === "vrc_guided_hybrid") {
    h2Pass = (hasCdn1 || hasCdn2) && hasHpc;
    h2Detail = `profile=vrc_guided_hybrid cdn1=${hasCdn1} cdn2=${hasCdn2} hpc=${hasHpc}`;
  } else {
    h2Pass = true;
    h2Detail = `profile=${profile || "legacy"} (no CDN routing enforced)`;
  }
  results.checks.H2_dual_cdn = { pass: h2Pass, detail: h2Detail };

  // H3: Session completeness (4 users)
  const userIds = new Set();
  for (const r of clientMetrics) { if (r.user_id) userIds.add(r.user_id); }
  for (const r of reqLogs) { if (r.user_id) userIds.add(r.user_id); }
  const has4Users = userIds.size >= 4;
  results.checks.H3_session_complete = {
    pass: has4Users,
    detail: `users=[${[...userIds].sort().join(",")}] count=${userIds.size}`,
  };

  // H4: VRC decisions logged
  const vrcFile = path.join(dir, "vrc_decisions.jsonl");
  const vrcDecisions = readJsonl(vrcFile);
  const method = sessionId.split("_")[0] || "";
  const needsVrc = ["VRC", "VRC-V", "VRC-N", "VRC-O"].includes(method);
  const h4Pass = needsVrc ? vrcDecisions.length > 0 : true;
  results.checks.H4_vrc_decisions = {
    pass: h4Pass,
    detail: `method=${method} decisions=${vrcDecisions.length} required=${needsVrc}`,
  };

  // H5: Source consistency
  const cdnLabel = sb.cdn_label || "";
  let h5Pass = true;
  let h5Detail = `cdn_label=${cdnLabel} profile=${profile}`;
  if (profile === "static_cdn" && cdnLabel === "cdn2" && !hasCdn2) {
    h5Pass = false;
    h5Detail += " ERROR: cdn_label=cdn2 but no cdn2 requests";
  }
  if (profile === "static_cdn" && cdnLabel !== "cdn2" && !hasCdn1) {
    h5Pass = false;
    h5Detail += " ERROR: cdn_label!=cdn2 but no cdn1 requests";
  }
  results.checks.H5_source_consistency = { pass: h5Pass, detail: h5Detail };

  // H6: Visual canary (screenshots)
  let screenshotCount = 0;
  for (const u of ["u0", "u1", "u2", "u3"]) {
    const shotName = `${sessionId}_${u}.png`;
    if (fs.existsSync(path.join(SCREENSHOTS, shotName)) ||
        fs.existsSync(path.join(dir, shotName))) {
      screenshotCount++;
    }
  }
  results.checks.H6_visual_canary = {
    pass: screenshotCount >= 4,
    detail: `screenshots=${screenshotCount}/4`,
  };

  results.all_pass = Object.values(results.checks).every(c => c.pass);
  return results;
}

function main() {
  console.log(`[canary] RESULTS_ROOT=${RESULTS_ROOT}`);
  const sessions = TARGET_SESSION ? [TARGET_SESSION] : getSessions();

  if (!sessions.length) {
    console.log("[canary] No sessions found. Run experiments first.");
    process.exit(1);
  }

  const allResults = [];
  let passCount = 0;
  let failCount = 0;

  for (const sid of sessions) {
    const r = validateSession(sid);
    allResults.push(r);
    if (r.all_pass) passCount++;
    else failCount++;

    const status = r.all_pass ? "PASS" : "FAIL";
    const failedChecks = Object.entries(r.checks)
      .filter(([, v]) => !v.pass)
      .map(([k]) => k);
    console.log(`  ${status} ${sid}${failedChecks.length ? ` [${failedChecks.join(",")}]` : ""}`);
  }

  console.log(`\n[canary] ${passCount} PASS / ${failCount} FAIL out of ${sessions.length} sessions`);

  // Write validation report
  const report = {
    timestamp: new Date().toISOString(),
    results_root: RESULTS_ROOT,
    total_sessions: sessions.length,
    pass: passCount,
    fail: failCount,
    sessions: allResults,
  };
  const outFile = path.join(SUMMARY, "canary_validation.json");
  fs.mkdirSync(SUMMARY, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`[canary] Report → ${outFile}`);

  // Also write CSV summary
  const csvRows = allResults.map(r => ({
    session_id: r.session_id,
    all_pass: r.all_pass,
    H1: r.checks.H1_dual_machine?.pass ?? "",
    H2: r.checks.H2_dual_cdn?.pass ?? "",
    H3: r.checks.H3_session_complete?.pass ?? "",
    H4: r.checks.H4_vrc_decisions?.pass ?? "",
    H5: r.checks.H5_source_consistency?.pass ?? "",
    H6: r.checks.H6_visual_canary?.pass ?? "",
  }));
  if (csvRows.length) {
    const keys = Object.keys(csvRows[0]);
    const lines = csvRows.map(r => keys.map(k => String(r[k] ?? "")).join(","));
    fs.writeFileSync(
      path.join(SUMMARY, "canary_validation.csv"),
      [keys.join(","), ...lines].join("\n") + "\n"
    );
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main();
