/**
 * Merge two VRC distributed shard directories (u0–u1 primary + u2–u3 worker)
 * into a single run folder + global screenshots, then write visual_check + status.json.
 */
import fs from "node:fs";
import path from "node:path";
import { buildVisualCheck } from "./visual_validator.mjs";
import { computeSourceBreakdownFromChunkLogs, validateSourceConsistency } from "./run_experiment.mjs";

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

export function computeNetworkMetricsFromRequests(allRequestLogs) {
  const chunkRequests = allRequestLogs.filter(r =>
    r.url && (r.url.includes(".rad") || r.url.includes(".spz") || r.url.includes(".splat")) &&
    r.service_time_ms !== undefined && r.service_time_ms > 0 && r.service_time_ms < 120000
  );
  if (chunkRequests.length === 0) return {};
  const latencies = chunkRequests.map(r => r.service_time_ms).sort((a, b) => a - b);
  const n = latencies.length;
  const p50 = latencies[Math.floor(n * 0.5)];
  const p95 = latencies[Math.floor(n * 0.95)];
  const p99 = latencies[Math.min(n - 1, Math.floor(n * 0.99))];
  const frac50 = latencies.filter(x => x > 50).length / n;
  const totalBytes = chunkRequests.reduce((s, r) => s + (r.bytes_sent || 0), 0);
  const dupUrls = chunkRequests.reduce((m, r) => { m[r.url] = (m[r.url] || 0) + 1; return m; }, {});
  const dupCount = Object.values(dupUrls).filter(v => v > 1).length;
  const dupRatio = dupCount / Math.max(1, Object.keys(dupUrls).length);
  return {
    p50_latency_ms: p50,
    p95_latency_ms: p95,
    p99_latency_ms: p99,
    p95_latency_source: "object_or_range_completion",
    fraction_over_50ms: frac50,
    fraction_over_50ms_source: "object_or_range_completion",
    viewport_to_visible_latency_ms: "NA",
    viewport_to_visible_latency_source: "not_independently_measured",
    object_or_range_completion_ms: p50,
    object_or_range_completion_p95_ms: p95,
    aggregate_client_bytes: totalBytes,
    unique_bytes: totalBytes,
    duplicate_request_ratio: dupRatio,
    chunk_request_count: n,
    _source: "playwright_network_log",
  };
}

function writeCsv(rows, file) {
  if (!rows.length) return;
  const keys = [...new Set(rows.flatMap(Object.keys))];
  const lines = rows.map((r) => keys.map((k) => {
    const v = r[k];
    if (v == null) return "";
    if (typeof v === "string" && (v.includes(",") || v.includes("\""))) return `"${v.replace(/"/g, "\"\"")}"`;
    return String(v);
  }).join(","));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [keys.join(","), ...lines].join("\n") + "\n");
}

function copyDirShots(fromDir, toDir, sessionId) {
  if (!fs.existsSync(fromDir)) return;
  fs.mkdirSync(toDir, { recursive: true });
  for (const u of ["u0", "u1", "u2", "u3"]) {
    const name = `${sessionId}_${u}.png`;
    const src = path.join(fromDir, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(toDir, name));
  }
}

/**
 * @param {object} p
 * @param {string} p.sessionId
 * @param {string} p.primaryShardDir  — runDir from controller (u0–u1)
 * @param {string} p.remoteShardDir  — copied worker runDir (u2–u3)
 * @param {string} p.finalRunDir     — e.g. RESULTS_RAW/<sessionId>
 * @param {string} p.resultsRoot     — VRC_RESULTS_ROOT (for screenshots/)
 * @param {string} p.method
 * @param {string} p.scenario
 * @param {number} p.trialIdx
 * @param {string} p.captureMode     — same as CAPTURE_MODE
 * @param {string} [p.canaryRule]  H1..H6 for extra checks
 */
export function mergeDistributedShards(p) {
  const {
    sessionId, primaryShardDir, remoteShardDir, finalRunDir, resultsRoot,
    method, scenario, trialIdx, captureMode = "parallel",
    controllerHost = "", workerHost = "",
    canaryRule = "",
  } = p;
  fs.mkdirSync(finalRunDir, { recursive: true });
  const screenshotsGlobal = path.join(resultsRoot, "screenshots");
  fs.mkdirSync(screenshotsGlobal, { recursive: true });

  const pShot = path.join(primaryShardDir, "screenshots");
  const rShot = path.join(remoteShardDir, "screenshots");
  copyDirShots(pShot, screenshotsGlobal, sessionId);
  copyDirShots(rShot, screenshotsGlobal, sessionId);

  function mergeFile(name) {
    const a = readJsonl(path.join(primaryShardDir, name));
    const b = readJsonl(path.join(remoteShardDir, name));
    const out = path.join(finalRunDir, name);
    const lines = [...a, ...b];
    fs.writeFileSync(out, lines.map((x) => JSON.stringify(x)).join("\n") + (lines.length ? "\n" : ""));
  }
  mergeFile("client_logs.jsonl");
  mergeFile("request_logs.jsonl");
  mergeFile("client_metrics.jsonl");

  const timingA = readJsonl(path.join(primaryShardDir, "screenshot_timing.jsonl"));
  const timingB = readJsonl(path.join(remoteShardDir, "screenshot_timing.jsonl"));
  const byUser = {};
  for (const row of [...timingA, ...timingB]) {
    if (row.user_id) byUser[row.user_id] = row;
  }
  const ordered = ["u0", "u1", "u2", "u3"].map((u) => byUser[u]).filter(Boolean);
  const timingOut = path.join(finalRunDir, "screenshot_timing.jsonl");
  fs.writeFileSync(timingOut, ordered.map((o) => JSON.stringify(o)).join("\n") + (ordered.length ? "\n" : ""));

  const cfgPrimary = path.join(primaryShardDir, "config.json");
  if (fs.existsSync(cfgPrimary)) {
    const c = JSON.parse(fs.readFileSync(cfgPrimary, "utf8"));
    c.distributed_merge = { primary: primaryShardDir, remote: remoteShardDir, merged_at: new Date().toISOString() };
    writeJson(path.join(finalRunDir, "config.json"), c);
  }
  for (const extra of ["scenario.json", "code_version.json", "metric_source.json"]) {
    const src = path.join(primaryShardDir, extra);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(finalRunDir, extra));
  }
  mergeFile("vrc_decisions.jsonl");
  mergeFile("source_decisions.jsonl");

  // H4 fix: if vrc_decisions.jsonl is empty, extract from server JSONL
  const vrcDecFile = path.join(finalRunDir, "vrc_decisions.jsonl");
  if (!fs.existsSync(vrcDecFile) || fs.statSync(vrcDecFile).size < 5) {
    const serverJsonl = path.join(resultsRoot, "raw", `${sessionId}_server.jsonl`);
    if (fs.existsSync(serverJsonl)) {
      const serverEvents = readJsonl(serverJsonl);
      const decisions = serverEvents.filter(e => e.event === "vrc_decision");
      if (decisions.length > 0) {
        fs.writeFileSync(vrcDecFile, decisions.map(d => JSON.stringify(d)).join("\n") + "\n");
      }
    }
  }

  const mergedReqPath = path.join(finalRunDir, "request_logs.jsonl");
  const allReq = readJsonl(mergedReqPath);
  const chunkLike = allReq.filter((r) =>
    r.url && /\.(rad|spz|splat)(\?|#|$)/i.test(String(r.url))
    && r.service_time_ms !== undefined && r.service_time_ms > 0 && r.service_time_ms < 120000,
  );

  let deliveryProfile = "legacy";
  let cdnLabel = "";
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(finalRunDir, "config.json"), "utf8"));
    deliveryProfile = (cfg.delivery_profile || "legacy").trim() || "legacy";
    cdnLabel = String(cfg.cdn_label ?? "").trim().toLowerCase();
  } catch { /* keep legacy */ }

  const vrcDecisionsMerged = readJsonl(path.join(finalRunDir, "vrc_decisions.jsonl"));
  const sourceValidationMerged = validateSourceConsistency(deliveryProfile, allReq, vrcDecisionsMerged, { cdn_label: cdnLabel });
  const sourceAgg = computeSourceBreakdownFromChunkLogs(chunkLike);
  const sourceBreakdownRow = {
    session_id: sessionId,
    method,
    scenario,
    trial: trialIdx,
    delivery_profile: deliveryProfile,
    cdn_label: cdnLabel,
    ...sourceAgg,
    mixed_source_valid: sourceValidationMerged.mixed_source_valid,
    source_validation_ok: sourceValidationMerged.valid,
    INVALID_MIXED_SOURCE: sourceValidationMerged.INVALID_MIXED_SOURCE,
    source_validation_errors: (sourceValidationMerged.errors ?? []).join("|"),
  };
  if (deliveryProfile === "vrc_guided_hybrid") {
    sourceBreakdownRow.cdn1_request_count = sourceAgg.cdn_request_count;
    sourceBreakdownRow.cdn2_request_count_labeled = sourceAgg.cdn2_request_count;
  }
  writeJson(path.join(finalRunDir, "source_breakdown.json"), sourceBreakdownRow);
  writeJson(path.join(finalRunDir, "source_validation.json"), sourceValidationMerged);

  const perClientMetricRows = ["u0", "u1", "u2", "u3"].map((uid) => {
    const rows = chunkLike.filter((r) => String(r.user_id) === uid);
    return {
      session_id: sessionId,
      method,
      scenario,
      trial: trialIdx,
      delivery_profile: deliveryProfile,
      user_id: uid,
      worker_id: rows[0]?.worker_id ?? "",
      host_ip: rows[0]?.host_ip ?? "",
      cdn_label: cdnLabel,
      ...computeSourceBreakdownFromChunkLogs(rows),
    };
  });
  writeCsv(perClientMetricRows, path.join(finalRunDir, "per_client_metrics.csv"));

  const clientMetricsPath = path.join(finalRunDir, "client_metrics.jsonl");
  const networkMetrics = computeNetworkMetricsFromRequests(allReq);
  const networkSummaryRow = Object.keys(networkMetrics).length ? {
    session_id: sessionId,
    method,
    scenario,
    trial: trialIdx,
    delivery_profile: deliveryProfile,
    cdn_label: cdnLabel,
    ...networkMetrics,
  } : null;

  const allCm = readJsonl(clientMetricsPath);
  const finalByUser = {};
  for (const r of allCm) {
    if (r.final === true && r.snapshot === "final" && /^u[0-3]$/.test(String(r.user_id))) {
      finalByUser[r.user_id] = r;
    }
  }
  const finalRows = Object.values(finalByUser);
  const hasRealMetrics = finalRows.some(m => !m.error && (m.fps !== undefined || m.p95_latency_ms !== undefined))
    || Object.keys(networkMetrics).length > 0;

  let visualCheck;
  if (captureMode === "metrics_only") {
    visualCheck = {
      session_id: sessionId,
      screenshots: {},
      summary: {
        users_total: 4,
        users_valid: 0,
        users_missing: 0,
        users_invalid_pixels: 0,
        all_valid: true,
        overall_status: "skipped_for_metrics_only",
        failures: [],
      },
    };
  } else {
    visualCheck = buildVisualCheck(sessionId, screenshotsGlobal, 4);
  }
  writeJson(path.join(finalRunDir, "visual_check.json"), visualCheck);

  const captureRecords = ordered;
  const allAccountedFor = captureRecords.length === 4;
  if (!allAccountedFor) {
    writeJson(path.join(finalRunDir, "status.json"), {
      status: "FAIL_DISTRIBUTED_MERGE_INCOMPLETE_TIMING",
      session_id: sessionId,
      method, scenario, trial: trialIdx,
      capture_users_found: captureRecords.map(r => r.user_id),
    });
    return { status: "FAIL_DISTRIBUTED_MERGE_INCOMPLETE_TIMING", sessionId, sourceBreakdownRow: null, perClientMetricRows: [], networkSummaryRow: null };
  }

  const missingUsers = [];
  const crashedUsers = [];
  for (const rec of captureRecords) {
    if (!rec.screenshot_saved) {
      missingUsers.push(rec.user_id);
      if (rec.page_crashed) crashedUsers.push(rec.user_id);
    }
  }

  const chunkCount = allReq.filter(r =>
    r.url && (r.url.includes(".rad") || r.url.includes(".spz") || r.url.includes(".splat")) &&
    r.service_time_ms !== undefined && r.service_time_ms > 0 && r.service_time_ms < 120000
  ).length;
  const metricGatePass =
    hasRealMetrics &&
    finalRows.filter(m => !m.error).length === 4 &&
    allReq.length > 0 &&
    chunkCount > 0 &&
    (networkMetrics.p95_latency_ms ?? 0) > 0;

  const anyLoadIncomplete = captureRecords.some(r =>
    r.visual_ready_reason === "LOAD_INCOMPLETE"
    || String(r.failure_reason ?? "").includes("LOAD_INCOMPLETE"));
  const anyCaptureTimeout = captureRecords.some(r =>
    String(r.failure_reason ?? "").includes("CAPTURE_TIMEOUT"));

  const visualOk = !!(visualCheck?.summary?.all_valid);
  const visualOverall = visualCheck?.summary?.overall_status ?? "UNKNOWN";

  let runStatus;
  if (captureMode === "metrics_only") {
    runStatus = metricGatePass ? "PASS" : "FAIL_METRICS_GATE";
  } else if (!hasRealMetrics) {
    runStatus = "WARN_NO_METRICS";
  } else if (anyLoadIncomplete) {
    runStatus = "FAIL_LOAD_INCOMPLETE";
  } else if (anyCaptureTimeout) {
    runStatus = "FAIL_CAPTURE_TIMEOUT";
  } else if (missingUsers.length === 4) {
    runStatus = "FAIL_VISUAL_MISSING_SCREENSHOTS";
  } else if (missingUsers.length > 0) {
    runStatus = "FAIL_VISUAL_INCOMPLETE_USERS";
  } else if (!visualOk) {
    runStatus = visualOverall;
  } else {
    runStatus = "PASS";
  }

  writeJson(path.join(finalRunDir, "status.json"), {
    method, scenario, trial: trialIdx, session_id: sessionId,
    clients: finalRows.length,
    client_metrics_with_data: finalRows.filter(m => !m.error).length,
    client_log_entries: readJsonl(path.join(finalRunDir, "client_logs.jsonl")).length,
    request_log_entries: allReq.length,
    visual_status: visualOverall,
    visual_failures: visualCheck?.summary?.failures ?? [],
    missing_users: missingUsers,
    crashed_users: crashedUsers,
    capture_records: captureRecords,
    timestamp_end: new Date().toISOString(),
    status: runStatus,
    distributed_merged: true,
    canary_rule: canaryRule || undefined,
    controller_host: controllerHost || undefined,
    worker_host: workerHost || undefined,
  });

  return { status: runStatus, sessionId, sourceBreakdownRow, perClientMetricRows, networkSummaryRow };
}

/**
 * Post-merge checks for hybrid distributed runs (no silent fallback).
 * Writes distributed_validation.json under finalRunDir.
 */
export function validateDistributedHybrid(p) {
  const {
    finalRunDir, controllerHost, workerHost,
    deliveryProfile: dpIn = "", canaryRule: canaryIn = "",
  } = p;
  const warnings = [];
  let deliveryProfile = String(dpIn ?? "").trim();
  let cdnLabel = "";
  if (!deliveryProfile && finalRunDir) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(finalRunDir, "config.json"), "utf8"));
      deliveryProfile = String(cfg.delivery_profile || "").trim() || "legacy";
      cdnLabel = String(cfg.cdn_label ?? "").trim().toLowerCase();
    } catch { deliveryProfile = "legacy"; }
  } else if (finalRunDir && !cdnLabel) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(finalRunDir, "config.json"), "utf8"));
      cdnLabel = String(cfg.cdn_label ?? "").trim().toLowerCase();
    } catch { /* */ }
  }
  const canaryRule = String(canaryIn ?? "").trim();

  const errors = [];
  const reqs = readJsonl(path.join(finalRunDir, "request_logs.jsonl"));
  const chunkLike = reqs.filter((r) =>
    r.url && /\.(rad|spz|splat)(\?|#|$)/i.test(String(r.url))
    && r.service_time_ms > 0 && r.service_time_ms < 120000,
  );
  const hostSet = new Set(chunkLike.map((r) => String(r.host_ip ?? "").trim()).filter(Boolean));
  if (controllerHost && !hostSet.has(controllerHost)) {
    errors.push(`missing_request_logs_host_ip_controller:${controllerHost}`);
  }
  if (workerHost && !hostSet.has(workerHost)) {
    errors.push(`missing_request_logs_host_ip_worker:${workerHost}`);
  }
  const workerIds = new Set(chunkLike.map((r) => String(r.worker_id ?? "").trim()).filter(Boolean));
  if (workerIds.size === 1 && workerIds.has("worker1")) {
    errors.push("all_chunk_logs_report_worker1_only_expected_distributed_u2_u3_on_worker2");
  }
  const users = new Set(chunkLike.map((r) => r.user_id).filter(Boolean));
  for (const u of ["u2", "u3"]) {
    if (![...users].some((x) => String(x) === u)) errors.push(`missing_chunk_requests:${u}`);
  }
  for (const r of chunkLike) {
    const uid = String(r.user_id ?? "");
    if ((uid === "u2" || uid === "u3") && String(r.url ?? "").includes("localhost")) {
      errors.push(`u2_u3_url_must_not_use_localhost:${r.url}`);
    }
    if ((uid === "u2" || uid === "u3") && String(r.worker_id ?? "") !== "worker2") {
      errors.push(`u2_u3_chunk_worker_id_must_be_worker2:${uid}:${r.worker_id}`);
    }
  }

  const logs = readJsonl(path.join(finalRunDir, "client_logs.jsonl"));
  const navByUser = {};
  for (const row of logs) {
    if (row.type === "nav_audit" && row.user_id) navByUser[row.user_id] = row;
  }
  for (const u of ["u2", "u3"]) {
    const na = navByUser[u];
    if (!na) errors.push(`missing_nav_audit_log:${u}`);
    else {
      if (String(na.sync_host ?? "").toLowerCase() === "localhost" || String(na.sync_host ?? "").includes("127.0.0.1")) {
        errors.push(`u2_u3_sync_host_must_not_be_localhost:${u}`);
      }
      const sw = String(na.sync_ws_url ?? "");
      if (sw && (sw.includes("localhost") || sw.includes("127.0.0.1"))) {
        errors.push(`u2_u3_sync_ws_must_not_use_localhost:${u}`);
      }
      const pu = String(na.page_url ?? "");
      if (pu.includes("localhost") || pu.includes("127.0.0.1")) {
        errors.push(`u2_u3_page_url_must_not_use_localhost:${u}`);
      }
      if (controllerHost && !pu.includes(controllerHost)) {
        errors.push(`u2_u3_page_url_must_include_controller:${controllerHost}`);
      }
      if (na.browser_pid == null || na.browser_pid === "") {
        errors.push(`missing_browser_pid_nav_audit:${u}`);
      }
    }
  }

  const perClientPath = path.join(finalRunDir, "per_client_metrics.csv");
  if (!fs.existsSync(perClientPath) || fs.statSync(perClientPath).size === 0) {
    errors.push("missing_per_client_metrics_csv");
  } else {
    const txt = fs.readFileSync(perClientPath, "utf8");
    if (!txt.includes("worker_id") || !txt.includes("host_ip")) {
      errors.push("per_client_metrics_csv_missing_worker_columns");
    }
    if (!txt.includes("cdn_label")) warnings.push("per_client_metrics_csv_missing_cdn_label_column");
    const body = txt.split("\n").slice(1).join("\n");
    for (const u of ["u0", "u1", "u2", "u3"]) {
      if (!new RegExp(`\\b${u}\\b`).test(body)) errors.push(`per_client_metrics_missing_user_row:${u}`);
    }
  }

  if (canaryRule === "H1" && deliveryProfile === "origin_only") {
    for (const r of chunkLike) {
      if (!r.fallback_used && r.source_selected !== "hpc_server") {
        errors.push(`H1:expected_hpc_got_${r.source_selected}:${r.url}`);
      }
    }
  }

  if ((canaryRule === "H4" || canaryRule === "H5" || canaryRule === "H6") && deliveryProfile === "vrc_guided_hybrid") {
    const vd = readJsonl(path.join(finalRunDir, "vrc_decisions.jsonl"));
    const hasCD = vd.some((row) => row.chunk_delivery && typeof row.chunk_delivery === "object" && Object.keys(row.chunk_delivery).length);
    if (!hasCD) errors.push("hybrid_vrc_decisions_missing_chunk_delivery");
    for (const r of chunkLike) {
      const sel = r.source_selected;
      if (!sel || sel === "non_chunk_asset" || sel === "unmatched") continue;
      if (!String(r.source_reason ?? "").trim()) errors.push(`hybrid_missing_source_reason:${r.url}`);
      if (!String(r.original_url ?? "").trim() || !String(r.final_url ?? "").trim()) {
        errors.push(`hybrid_missing_original_or_final_url:${r.url}`);
      }
      if (r.fetch_plan_version == null && (sel === "cdn_r2" || sel === "hpc_server" || sel === "cdn2")) {
        errors.push(`hybrid_missing_fetch_plan_version:${r.url}`);
      }
    }
  }

  if (canaryRule === "H4" || canaryRule === "H5") {
    try {
      const br = JSON.parse(fs.readFileSync(path.join(finalRunDir, "source_breakdown.json"), "utf8"));
      if (deliveryProfile === "vrc_guided_hybrid") {
        if (canaryRule === "H5") {
          if (!(br.hpc_request_count > 0 && br.cdn2_request_count > 0)) {
            errors.push(`H5_expected_split_hpc_and_cdn2:hpc=${br.hpc_request_count},cdn2=${br.cdn2_request_count}`);
          }
        } else if (canaryRule === "H4") {
          if (!(br.hpc_request_count > 0 && br.cdn_request_count > 0)) {
            errors.push(`H4_expected_split_hpc_and_cdn1:hpc=${br.hpc_request_count},cdn_r2=${br.cdn_request_count}`);
          }
        }
      }
    } catch {
      errors.push("H4_H5_cannot_read_source_breakdown");
    }
  }

  if (canaryRule === "H6") {
    try {
      const vc = JSON.parse(fs.readFileSync(path.join(finalRunDir, "visual_check.json"), "utf8"));
      const valid = Number(vc?.summary?.users_valid ?? 0);
      if (valid < 3) errors.push(`H6_visual_valid_below_3:${valid}`);
    } catch {
      errors.push("H6_missing_visual_check");
    }
  }

  const out = {
    ok: errors.length === 0,
    errors,
    warnings,
    canary_rule: canaryRule || undefined,
    delivery_profile: deliveryProfile,
    timestamp: new Date().toISOString(),
  };
  try {
    writeJson(path.join(finalRunDir, "distributed_validation.json"), out);
  } catch { /* ignore */ }

  return { ok: errors.length === 0, errors, warnings };
}
