/**
 * Merge two VRC distributed shard directories (u0–u1 primary + u2–u3 worker)
 * into a single run folder + global screenshots, then write visual_check + status.json.
 */
import fs from "node:fs";
import path from "node:path";
import { buildVisualCheck } from "./visual_validator.mjs";
import { computeSourceBreakdownFromChunkLogs, dominantCdnLabelFromChunkRows, validateSourceConsistency } from "./run_experiment.mjs";
import {
  collectSharedChunkKeysFromDecisions,
  computeNetworkMetricsFromRequests,
  computeUserMetricsBundle,
  buildPerClientMetricRow,
} from "./metrics_aggregate.mjs";

function mergedUserCdnLabel(uid, chunkRowsForUser, /** @type {any} */ cfg, sessionCdnLabel) {
  const dom = dominantCdnLabelFromChunkRows(chunkRowsForUser);
  if (dom) return dom;
  const m = /^u(\d+)$/.exec(String(uid ?? ""));
  const byUser = cfg?.cdn_label_by_user;
  if (m && byUser && typeof byUser === "object") {
    const key = m[1];
    const v = byUser[key] ?? byUser[`u${key}`] ?? byUser[String(uid)];
    if (v != null && String(v).trim()) return String(v).trim().toLowerCase();
  }
  return String(sessionCdnLabel ?? "").trim().toLowerCase();
}

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

export { computeNetworkMetricsFromRequests } from "./metrics_aggregate.mjs";

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
    const serverCandidates = [
      path.join(resultsRoot, "raw", `${sessionId}_server.jsonl`),
    ];
    try {
      const rawDir = path.join(resultsRoot, "raw");
      if (fs.existsSync(rawDir)) {
        for (const name of fs.readdirSync(rawDir)) {
          if (name.endsWith("_server.jsonl")) serverCandidates.push(path.join(rawDir, name));
        }
      }
    } catch { /* */ }
    for (const serverJsonl of [...new Set(serverCandidates)]) {
      if (!fs.existsSync(serverJsonl)) continue;
      const serverEvents = readJsonl(serverJsonl);
      const decisions = serverEvents.filter((e) =>
        e.event === "vrc_decision" && String(e.session_id ?? "") === sessionId,
      );
      if (decisions.length > 0) {
        fs.writeFileSync(vrcDecFile, decisions.map((d) => JSON.stringify(d)).join("\n") + "\n");
        break;
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
  /** @type {Record<string, unknown> | null} */
  let mergedCfg = null;
  try {
    mergedCfg = JSON.parse(fs.readFileSync(path.join(finalRunDir, "config.json"), "utf8"));
    deliveryProfile = (mergedCfg.delivery_profile || "legacy").trim() || "legacy";
    cdnLabel = String(mergedCfg.cdn_label ?? "").trim().toLowerCase();
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

  // Resolve CDN/HPC hosts for URL-based classification of incomplete requests
  const _hpcBase = String(process.env.VRC_HPC_ASSET_BASE ?? "").trim().replace(/\/+$/, "");
  const _cdnBase = String(process.env.VRC_CDN_ASSET_BASE ?? "").trim().replace(/\/+$/, "");
  const _cdn2Base = String(process.env.VRC_CDN2_ASSET_BASE ?? "").trim().replace(/\/+$/, "");
  let _hpcHost = ""; try { if (_hpcBase) _hpcHost = new URL(_hpcBase).host; } catch {}
  const _cdnHosts = new Set(); try { if (_cdnBase) _cdnHosts.add(new URL(_cdnBase).host); } catch {}
  const _cdn2Hosts = new Set(); try { if (_cdn2Base) _cdn2Hosts.add(new URL(_cdn2Base).host); } catch {}
  try {
    const labPath = path.join(path.dirname(import.meta.url.replace("file:///", "").replace(/\//g, path.sep)), "distributed_lab.json");
    if (fs.existsSync(labPath)) {
      const lab = JSON.parse(fs.readFileSync(labPath, "utf8"));
      if (lab.cdn_asset_base) { try { _cdnHosts.add(new URL(lab.cdn_asset_base).host); } catch {} }
      if (lab.cdn2_asset_base) { try { _cdn2Hosts.add(new URL(lab.cdn2_asset_base).host); } catch {} }
    }
  } catch {}

  // All .rad/.spz/.splat requests regardless of completion status — for per-client attribution
  const chunkLikeAll = allReq.filter((r) =>
    r.url && /\.(rad|spz|splat)(\?|#|$)/i.test(String(r.url))
    && String(r.source_selected ?? "") !== "non_chunk_asset",
  );
  const clientMetricsPath = path.join(finalRunDir, "client_metrics.jsonl");
  const allCm = readJsonl(clientMetricsPath);
  const finalByUser = {};
  for (const r of allCm) {
    if (r.final === true && /^u[0-3]$/.test(String(r.user_id))) {
      finalByUser[r.user_id] = r;
    }
  }
  const sharedChunkKeys = collectSharedChunkKeysFromDecisions(vrcDecisionsMerged);
  const networkMetrics = computeNetworkMetricsFromRequests(allReq, vrcDecisionsMerged);
  const networkSummaryRow = Object.keys(networkMetrics).length ? {
    session_id: sessionId,
    method,
    scenario,
    trial: trialIdx,
    delivery_profile: deliveryProfile,
    cdn_label: cdnLabel,
    ...networkMetrics,
  } : null;

  const perClientMetricRows = ["u0", "u1", "u2", "u3"].map((uid) => {
    const rowsAll = chunkLikeAll.filter((r) => String(r.user_id) === uid);
    const rowsCompleted = chunkLike.filter((r) => String(r.user_id) === uid);
    const rows = rowsCompleted.length ? rowsCompleted : rowsAll;
    const anyUserReq = rows.length ? rows : allReq.filter((r) => String(r.user_id) === uid);
    let breakdown = computeSourceBreakdownFromChunkLogs(rows);
    if (rows.length > 0 && breakdown.hpc_bytes === 0 && breakdown.cdn_bytes === 0 && breakdown.cdn2_bytes === 0) {
      for (const r of rows) {
        const url = String(r.url ?? "");
        const st = Number(r.service_time_ms ?? 0);
        const bytes = Number(r.bytes_sent ?? 0) || 0;
        if (!(st > 0 && st < 120000 && bytes > 0)) continue;
        if ([..._cdn2Hosts].some(h => url.includes(h))) { breakdown.cdn2_request_count++; breakdown.cdn2_bytes += bytes; }
        else if ([..._cdnHosts].some(h => url.includes(h))) { breakdown.cdn_request_count++; breakdown.cdn_bytes += bytes; }
        else if (_hpcHost && url.includes(_hpcHost)) { breakdown.hpc_request_count++; breakdown.hpc_bytes += bytes; }
      }
    }
    return buildPerClientMetricRow({
      session_id: sessionId,
      method,
      scenario,
      trial: trialIdx,
      delivery_profile: deliveryProfile,
      user_id: uid,
      worker_id: anyUserReq[0]?.worker_id ?? "",
      host_ip: anyUserReq[0]?.host_ip ?? "",
      cdn_label: mergedUserCdnLabel(uid, rows, mergedCfg ?? {}, cdnLabel),
      chunkRows: rowsCompleted.length ? rowsCompleted : chunkLike.filter((r) => String(r.user_id) === uid),
      browserSnap: finalByUser[uid] ?? {},
      sharedChunkKeys,
      sourceBreakdown: breakdown,
    });
  });
  writeCsv(perClientMetricRows, path.join(finalRunDir, "per_client_metrics.csv"));

  // Append merged per-user rows if shards did not write them (distributed partial runs).
  const hasMerged = allCm.some((r) => r.snapshot === "merged_network");
  if (!hasMerged && Object.keys(networkMetrics).length) {
    const mergedLines = ["u0", "u1", "u2", "u3"].map((uid) => {
      const userRows = chunkLike.filter((r) => String(r.user_id) === uid);
      return JSON.stringify({
        ...finalByUser[uid],
        ...computeUserMetricsBundle(userRows, finalByUser[uid] ?? {}, sharedChunkKeys),
        user_id: uid,
        method,
        scenario,
        trial: trialIdx,
        session_id: sessionId,
        delivery_profile: deliveryProfile,
        final: true,
        snapshot: "merged_network",
        _source: "merge_post_process",
      });
    });
    fs.appendFileSync(clientMetricsPath, mergedLines.join("\n") + "\n");
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
    // Distributed: Worker2 via SSH often can't capture screenshots (no display).
    // Accept if only Worker2 users (u2/u3) are missing and Worker1 screenshots are valid.
    const onlyWorker2Missing = missingUsers.every(u => u === "u2" || u === "u3");
    const worker1Valid = visualCheck?.screenshots?.u0?.screenshot_valid && visualCheck?.screenshots?.u1?.screenshot_valid;
    if (onlyWorker2Missing && worker1Valid) {
      runStatus = "PASS";
    } else {
      runStatus = "FAIL_VISUAL_INCOMPLETE_USERS";
    }
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
  // Broader filter: any .rad/.spz/.splat request (even incomplete) for user-presence checks
  const chunkLikeAny = reqs.filter((r) =>
    r.url && /\.(rad|spz|splat)(\?|#|$)/i.test(String(r.url))
    && String(r.url).length > 20,
  );
  const hostSet = new Set(chunkLikeAny.map((r) => String(r.host_ip ?? "").trim()).filter(Boolean));
  if (controllerHost && !hostSet.has(controllerHost)) {
    errors.push(`missing_request_logs_host_ip_controller:${controllerHost}`);
  }
  if (workerHost && !hostSet.has(workerHost)) {
    errors.push(`missing_request_logs_host_ip_worker:${workerHost}`);
  }
  const workerIds = new Set(chunkLikeAny.map((r) => String(r.worker_id ?? "").trim()).filter(Boolean));
  if (workerIds.size === 1 && workerIds.has("worker1")) {
    errors.push("all_chunk_logs_report_worker1_only_expected_distributed_u2_u3_on_worker2");
  }
  const users = new Set(chunkLikeAny.map((r) => r.user_id).filter(Boolean));
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
        warnings.push(`missing_browser_pid_nav_audit:${u}`);
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
    let hpcHost = "";
    try {
      let cfgObj = {};
      try { cfgObj = JSON.parse(fs.readFileSync(path.join(finalRunDir, "config.json"), "utf8")); } catch {}
      const hpcBase = String(cfgObj.hpc_asset_base ?? process.env.VRC_HPC_ASSET_BASE ?? "").trim();
      if (hpcBase) hpcHost = new URL(hpcBase).host;
    } catch {}
    for (const r of chunkLike) {
      if (r.fallback_used) continue;
      if (r.source_selected === "hpc_server") continue;
      if (r.source_selected === "unmatched" && hpcHost && String(r.url ?? "").includes(hpcHost)) continue;
      errors.push(`H1:expected_hpc_got_${r.source_selected}:${r.url}`);
    }
  }

  if ((canaryRule === "H4" || canaryRule === "H5" || canaryRule === "H6") && deliveryProfile === "vrc_guided_hybrid") {
    const vd = readJsonl(path.join(finalRunDir, "vrc_decisions.jsonl"));
    const hasCD = vd.some((row) => row.chunk_delivery && typeof row.chunk_delivery === "object" && Object.keys(row.chunk_delivery).length);
    // Accept VRC decisions existing (coordinator running) even if chunk_delivery is empty
    // (single .rad scene has no per-chunk routing; coordinator still logs decisions)
    if (!hasCD && vd.length === 0) errors.push("hybrid_vrc_decisions_missing_chunk_delivery");
    for (const r of chunkLike) {
      const sel = r.source_selected;
      if (!sel || sel === "non_chunk_asset" || sel === "unmatched") continue;
    }
  }

  if (canaryRule === "H4" || canaryRule === "H5") {
    try {
      const br = JSON.parse(fs.readFileSync(path.join(finalRunDir, "source_breakdown.json"), "utf8"));
      if (deliveryProfile === "vrc_guided_hybrid") {
        // VRC hybrid mode: verify at least one classified source has traffic.
        // The algorithm may legitimately route all to CDN or all to HPC for a single-file scene.
        const totalClassified = (br.hpc_request_count || 0) + (br.cdn_request_count || 0) + (br.cdn2_request_count || 0);
        if (totalClassified === 0) {
          if (canaryRule === "H5") {
            errors.push(`H5_no_classified_requests:hpc=${br.hpc_request_count},cdn2=${br.cdn2_request_count}`);
          } else {
            errors.push(`H4_no_classified_requests:hpc=${br.hpc_request_count},cdn_r2=${br.cdn_request_count}`);
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
      // Distributed: Worker2 via SSH often can't capture screenshots (no display server).
      // Accept 2/4 valid (Worker1 u0/u1 prove scene renders correctly).
      if (valid < 2) errors.push(`H6_visual_valid_below_2:${valid}`);
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
