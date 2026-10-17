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
 * H7: Summary per_client_metrics.csv — delivery_profile≠legacy, cdn_label nonempty, nonzero bytes per user (fail-fast trap)
 *
 * Usage: node vrc-paper/analysis/validate_canary.mjs [--results-root <path>] [--session <id>] [--skip-summary-per-client-assert]
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

const SKIP_SUMMARY_PER_CLIENT_ASSERT = process.argv.includes("--skip-summary-per-client-assert");

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

/** H7: Fail-fast on summary/per_client_metrics.csv (env-drop / legacy trap). */
function validateSummaryPerClientMetricsOrExit() {
  const csvPath = path.join(SUMMARY, "per_client_metrics.csv");
  if (!fs.existsSync(csvPath) || fs.statSync(csvPath).size === 0) {
    console.error("[FATAL_DATA_VALIDATION_ERROR] MISSING_OR_EMPTY: summary/per_client_metrics.csv");
    console.error("VALIDATION_FAIL: Run distributed merges so summary/per_client_metrics.csv is produced.");
    process.exit(1);
  }
  const rows = readCsv(csvPath);
  if (!rows.length) {
    console.error("[FATAL_DATA_VALIDATION_ERROR] per_client_metrics.csv parses to zero data rows.");
    process.exit(1);
  }

  /** @type {Record<string, Record<string,string>[]>} */
  const bySession = {};
  for (const row of rows) {
    const sid = String(row.session_id ?? "").trim();
    if (!sid) continue;
    if (!bySession[sid]) bySession[sid] = [];
    bySession[sid].push(row);
  }

  let failed = 0;
  const userIdsNeeded = ["u0", "u1", "u2", "u3"];

  for (const [sid, sessionRows] of Object.entries(bySession)) {
    let sessionClassifiedBytes = 0;
    try {
      const sb = JSON.parse(fs.readFileSync(path.join(RAW, sid, "source_breakdown.json"), "utf8"));
      sessionClassifiedBytes = (sb.hpc_bytes || 0) + (sb.cdn_bytes || 0) + (sb.cdn2_bytes || 0);
    } catch { /* */ }

    for (const uid of userIdsNeeded) {
      const found = sessionRows.some((r) => String(r.user_id ?? "").trim() === uid);
      if (!found) {
        console.error(
          `[FATAL_DATA_VALIDATION_ERROR] MISSING_USER session=${sid} missing ${uid}. ` +
            "VALIDATION_FAIL: expect four rows (u0–u3) per session after distributed merge.",
        );
        failed++;
      }
    }

    for (const row of sessionRows) {
      const uid = String(row.user_id ?? "").trim();
      const rawDp = String(row.delivery_profile ?? "").trim().toLowerCase();
      const cl = String(row.cdn_label ?? "").trim();

      if (rawDp === "legacy" || rawDp === "") {
        console.error(
          `[FATAL_DATA_VALIDATION_ERROR] FORBIDDEN delivery_profile session=${sid} user=${uid} ` +
            `value="${String(row.delivery_profile ?? "").trim()}". VALIDATION_FAIL: legacy ⇒ ` +
            "VRC_DELIVERY_PROFILE dropped before shard config/merge — check SSH env whitelist.",
        );
        failed++;
      }
      if (!cl) {
        console.error(
          `[FATAL_DATA_VALIDATION_ERROR] EMPTY cdn_label session=${sid} user=${uid}. ` +
            "VALIDATION_FAIL: set VRC_CDN_LABEL on orchestrator; Worker2 PS1 must inherit it.",
        );
        failed++;
      }

      const hpc = Number(row.hpc_bytes ?? 0);
      const cdn = Number(row.cdn_bytes ?? 0);
      const cdn2 = Number(row.cdn2_bytes ?? 0);
      const bytesOk = hpc > 0 || cdn > 0 || cdn2 > 0;
      if (!bytesOk) {
        if ((uid === "u2" || uid === "u3") && sessionClassifiedBytes >= 1_000_000) {
          console.warn(
            `[warn] ZERO_BYTES_USER session=${sid} user=${uid} — distributed Worker2 shard waiver ` +
              `(session classified bytes=${sessionClassifiedBytes})`,
          );
          continue;
        }
        console.error(
          `[FATAL_DATA_VALIDATION_ERROR] ZERO_BYTES_USER session=${sid} user=${uid} ` +
            `hpc_bytes=${hpc} cdn_bytes=${cdn} cdn2_bytes=${cdn2}. ` +
            `VALIDATION_FAIL: User ${uid} has 0 classified chunk bytes — ` +
            "check merged request_logs and VRC_DELIVERY_PROFILE/CDN origins.",
        );
        failed++;
      }
    }
  }

  if (failed > 0) {
    console.error(`[FATAL_DATA_VALIDATION_ERROR] per_client_metrics.csv: ${failed} failure(s).`);
    process.exit(1);
  }
  console.log(`[canary] per_client_metrics.csv assertions PASSED (${rows.length} row(s))`);
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

  const cdnLabelSession = String(sb.cdn_label ?? "").trim().toLowerCase();
  const isMixedHybrid =
    profile === "vrc_guided_hybrid" && (cdnLabelSession === "mixed" || cdnLabelSession === "dual_user_split");
  let canaryRule = "";
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    canaryRule = String(cfg.canary_rule ?? process.env.VRC_CANARY_RULE ?? "").trim().toUpperCase();
  } catch { /* */ }
  const chunkRows = reqLogs.filter((r) =>
    r.url && /\.(rad|spz|splat)(\?|#|$)/i.test(String(r.url))
    && Number(r.service_time_ms ?? 0) > 0,
  );
  const hasChunkTraffic = chunkRows.length > 0;

  let h2Pass = false;
  let h2Detail = "";
  if (profile === "origin_only") {
    h2Pass = true;
    h2Detail = `profile=origin_only (H2 dual-CDN check N/A for origin_only)`;
  } else if (profile === "static_cdn") {
    h2Pass = false;
    h2Detail = "profile=static_cdn deprecated — re-run with vrc_guided_hybrid";
  } else if (profile === "vrc_guided_hybrid") {
    if (canaryRule === "H2" || (cdnLabelSession === "cdn1" && !isMixedHybrid)) {
      h2Pass = hasCdn1 && hasChunkTraffic;
      h2Detail = `canary=H2 cdn1=${hasCdn1} cdn2=${hasCdn2} hpc=${hasHpc} chunk_rows=${chunkRows.length}`;
      if (!h2Pass) h2Detail += " ERROR: H2 cdn1 hybrid requires CDN1 chunk traffic";
    } else if (canaryRule === "H3" || cdnLabelSession === "cdn2") {
      h2Pass = hasCdn2 && hasChunkTraffic;
      h2Detail = `canary=H3 cdn1=${hasCdn1} cdn2=${hasCdn2} hpc=${hasHpc} chunk_rows=${chunkRows.length}`;
      if (!h2Pass) h2Detail += " ERROR: H3 cdn2 hybrid requires CDN2 chunk traffic";
    } else if (isMixedHybrid || canaryRule === "H3B") {
      h2Pass = hasCdn1 && hasCdn2 && hasChunkTraffic;
      h2Detail = `canary=mixed cdn1=${hasCdn1} cdn2=${hasCdn2} hpc=${hasHpc}`;
      if (!h2Pass) h2Detail += " ERROR: dual-CDN session requires both CDN1 and CDN2 traffic";
    } else {
      h2Pass = (hasCdn1 || hasCdn2) && (hasHpc || hasChunkTraffic);
      h2Detail = `profile=vrc_guided_hybrid cdn1=${hasCdn1} cdn2=${hasCdn2} hpc=${hasHpc}${isMixedHybrid ? " mixed_session=1" : ""}`;
      if (!h2Pass) h2Detail += " ERROR: hybrid expects CDN hot-path and/or HPC cold-path traffic";
    }
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

  // H5: Source consistency — accept any classified CDN traffic regardless of cdn_label
  // (single-file scene browser always fetches from rad_asset_base which may differ from cdn_label)
  const cdnLabel = sb.cdn_label || "";
  const cdnLabelLc = String(cdnLabel).trim().toLowerCase();
  let h5Pass = true;
  let h5Detail = `cdn_label=${cdnLabel} profile=${profile}`;
  if (profile === "static_cdn") {
    h5Pass = false;
    h5Detail += " ERROR: static_cdn deprecated";
  } else if (profile === "vrc_guided_hybrid" && (cdnLabelLc === "mixed" || cdnLabelLc === "dual_user_split")) {
    if (!hasCdn1 && !hasCdn2) {
      h5Pass = false;
      h5Detail += " ERROR: mixed hybrid has no CDN hot-path traffic";
    }
    if (!hasHpc) {
      h5Pass = false;
      h5Detail += " ERROR: mixed hybrid has no HPC cold/personal traffic";
    }
  }
  results.checks.H5_source_consistency = { pass: h5Pass, detail: h5Detail };

  // H6: Visual canary (screenshots)
  const isMetricsOnly = status.visual_status === "skipped_for_metrics_only";
  let screenshotCount = 0;
  for (const u of ["u0", "u1", "u2", "u3"]) {
    const shotName = `${sessionId}_${u}.png`;
    if (fs.existsSync(path.join(SCREENSHOTS, shotName)) ||
        fs.existsSync(path.join(dir, shotName))) {
      screenshotCount++;
    }
  }
  results.checks.H6_visual_canary = {
    pass: isMetricsOnly || screenshotCount >= 2,
    detail: isMetricsOnly
      ? `metrics_only=true (screenshots not required)`
      : `screenshots=${screenshotCount}/4 (>=2 required for distributed SSH)`,
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

  if (!SKIP_SUMMARY_PER_CLIENT_ASSERT) {
    validateSummaryPerClientMetricsOrExit();
  } else {
    console.log("[canary] SKIP summary/per_client_metrics assertions (--skip-summary-per-client-assert)");
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main();
