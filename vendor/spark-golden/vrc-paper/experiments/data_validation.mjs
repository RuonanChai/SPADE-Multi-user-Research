/**
 * Per-session hard validation — invalid runs must not count as scientific data.
 */
import fs from "node:fs";
import path from "node:path";
import { readSummaryCsv } from "./summary_csv.mjs";

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function readCsvLoose(file) {
  return readSummaryCsv(file);
}

const STREAMING_METHODS = new Set(["VRC", "Spark-MU", "VP-S", "NET-S", "VRC-V", "VRC-N", "VRC-O"]);
const MIN_CHUNK_COUNT_STREAMING = Number(process.env.VRC_VAL_MIN_CHUNK_REQUESTS ?? 2);
const MIN_VISIBLE_QUALITY = Number(process.env.VRC_VAL_MIN_VISIBLE_QUALITY ?? 0.05);
const MIN_USER_BYTES = Number(process.env.VRC_VAL_MIN_USER_BYTES ?? 65536);

/**
 * @param {string} finalRunDir
 * @param {object} [opts]
 */
export function validateSessionDataHard(finalRunDir, opts = {}) {
  const expectedUsers = Number(opts.expected_users ?? 4);
  const deliveryProfile = String(opts.delivery_profile ?? "").trim().toLowerCase();
  const method = String(opts.method ?? "").trim();
  const canary = String(opts.canary ?? "").trim();
  const cdnLabel = String(opts.cdn_label ?? "").trim().toLowerCase();

  /** @type {Record<string, { valid: boolean, reasons: string[], warnings: string[] }>} */
  const users = {};
  const globalReasons = [];
  const globalWarnings = [];

  const isOriginBaseline = deliveryProfile === "origin_only"
    || (method === "Full" && deliveryProfile === "origin_only");
  const isConnectivityBaseline = isOriginBaseline;

  let captureMode = String(process.env.VRC_CAPTURE_MODE ?? "").trim().toLowerCase();
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(finalRunDir, "config.json"), "utf8"));
    if (cfg.capture_mode) captureMode = String(cfg.capture_mode).trim().toLowerCase();
  } catch { /* */ }
  let metricsOnlyRun = captureMode === "metrics_only";
  try {
    const st = JSON.parse(fs.readFileSync(path.join(finalRunDir, "status.json"), "utf8"));
    if (st.visual_status === "skipped_for_metrics_only") metricsOnlyRun = true;
  } catch { /* */ }

  const perClientPath = path.join(finalRunDir, "per_client_metrics.csv");
  if (!fs.existsSync(perClientPath)) {
    globalReasons.push("missing_per_client_metrics_csv");
    return buildReport(finalRunDir, users, globalReasons, globalWarnings, false, isConnectivityBaseline);
  }

  const rows = readCsvLoose(perClientPath);
  let sessionCdn = 0;
  let sessionCdn2 = 0;
  let sessionHpc = 0;
  try {
    const sb = JSON.parse(fs.readFileSync(path.join(finalRunDir, "source_breakdown.json"), "utf8"));
    sessionCdn = (sb.cdn_bytes || 0) > 0 || (sb.cdn_request_count || 0) > 0;
    sessionCdn2 = (sb.cdn2_bytes || 0) > 0 || (sb.cdn2_request_count || 0) > 0;
    sessionHpc = (sb.hpc_bytes || 0) > 0 || (sb.hpc_request_count || 0) > 0;
  } catch { /* */ }
  const userIds = [];
  for (let i = 0; i < expectedUsers; i++) userIds.push(`u${i}`);

  let validCount = 0;
  for (const uid of userIds) {
    const reasons = [];
    const warnings = [];
    const row = rows.find((r) => String(r.user_id ?? "").trim() === uid);
    if (!row) {
      reasons.push("missing_per_client_row");
      users[uid] = { valid: false, reasons, warnings };
      continue;
    }

    const ms = String(row.metrics_source ?? row.viewport_to_visible_latency_source ?? "").trim();
    const fps = Number(row.fps ?? 0);
    const agg = Number(row.aggregate_client_bytes ?? 0);
    const hpc = Number(row.hpc_bytes ?? 0);
    const cdn = Number(row.cdn_bytes ?? 0);
    const cdn2 = Number(row.cdn2_bytes ?? 0);
    const transport = hpc + cdn + cdn2;
    const chunkCount = Number(row.chunk_request_count ?? 0);
    const vq = Number(row.visible_quality ?? 0);

    const proxyMetrics = ms.includes("proxy") || ms === "object_or_range_completion_proxy";

    if (isConnectivityBaseline) {
      warnings.push("connectivity_baseline_origin_only_whole_file_not_streaming_lod");
      if (ms === "no_chunk_timing" || ms === "no_chunk_events_yet") {
        warnings.push(`connectivity_metrics_incomplete:${ms}`);
      }
      if (!(fps > 0)) warnings.push(`connectivity_fps_not_reported:${fps}`);
      const effectiveBytes = Math.max(agg, transport);
      if (!(effectiveBytes >= MIN_USER_BYTES)) {
        if (transport === 1 || agg === 0) {
          warnings.push("connectivity_no_completed_rad_in_network_log");
        } else {
          warnings.push(`connectivity_bytes_low:${effectiveBytes}`);
        }
      }
      if (chunkCount <= 1) warnings.push("expected_whole_file_rad_baseline_chunk_count_lte_1");
      if (vq === 0 || Math.abs(vq - 0.02) < 0.001) {
        warnings.push(`connectivity_visible_quality_low:${vq}`);
      }
    } else {
      if (ms === "no_chunk_timing" || ms === "no_chunk_events_yet") {
        reasons.push(`invalid_metrics_source:${ms}`);
      }
      if (!metricsOnlyRun && !proxyMetrics && !(fps > 0)) {
        reasons.push(`fps_not_positive:${fps}`);
      }
      const effectiveBytes = Math.max(agg, transport);
      if (!(effectiveBytes >= MIN_USER_BYTES)) {
        if (transport === 1 || agg === 0) {
          reasons.push("no_real_transfer_bytes(incomplete_or_placeholder)");
        } else {
          reasons.push(`aggregate_bytes_too_low:${effectiveBytes}`);
        }
      }
      if (STREAMING_METHODS.has(method) && chunkCount <= 1) {
        reasons.push(`chunk_request_count_too_low_for_streaming_lod:${chunkCount}`);
      }
      if (!metricsOnlyRun && !proxyMetrics && (vq === 0 || Math.abs(vq - 0.02) < 0.001)) {
        reasons.push(`visible_quality_too_low:${vq}`);
      }
    }

    const valid = reasons.length === 0;
    if (valid) validCount++;
    users[uid] = { valid, reasons, warnings };
  }

  let isDistributed = false;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(finalRunDir, "config.json"), "utf8"));
    isDistributed = !!cfg.vrc_distributed;
  } catch { /* */ }

  const minSessionCdn2 = Number(process.env.VRC_VAL_MIN_SESSION_CDN2_BYTES ?? 1_000_000);
  if (
    canary === "H3"
    && isDistributed
    && sessionCdn2 >= minSessionCdn2
    && validCount < expectedUsers
  ) {
    for (const uid of userIds) {
      const u = users[uid];
      if (!u || u.valid) continue;
      const shardOnly = u.reasons.every((r) =>
        r.includes("no_chunk_timing")
        || r.includes("no_real_transfer_bytes")
        || r.includes("chunk_request_count_too_low"),
      );
      if (shardOnly) {
        u.warnings.push("distributed_h3_cdn2_session_ok_worker_shard_no_chunk_timing");
        u.valid = true;
        u.reasons = [];
        validCount++;
      }
    }
  }

  if (validCount !== expectedUsers) {
    globalReasons.push(`valid_clients_${validCount}_of_${expectedUsers}`);
  }

  if (deliveryProfile === "vrc_guided_hybrid" || canary === "H2" || canary === "H3" || canary === "H3b") {
    if ((cdnLabel === "cdn1" || canary === "H2") && !(sessionCdn > 0)) {
      globalReasons.push("cdn1_canary_requires_session_cdn_traffic");
    }
    if ((cdnLabel === "cdn2" || canary === "H3") && !(sessionCdn2 > 0)) {
      globalReasons.push("cdn2_canary_requires_session_cdn2_traffic");
    }
    if ((canary === "H3b" || cdnLabel === "mixed") && !(sessionCdn > 0 && sessionCdn2 > 0)) {
      globalReasons.push("dual_cdn_canary_requires_both_cdn1_and_cdn2_session_traffic");
    }
    if (deliveryProfile === "vrc_guided_hybrid" && !(sessionHpc > 0 || sessionCdn > 0 || sessionCdn2 > 0)) {
      globalReasons.push("hybrid_requires_classified_session_traffic");
    }
  }

  let ok = globalReasons.length === 0 && validCount === expectedUsers;
  if (isConnectivityBaseline && validCount === expectedUsers) {
    ok = globalReasons.length === 0;
    globalWarnings.push("connectivity_baseline_pass_with_warnings_not_streaming_lod_science");
  }
  return buildReport(finalRunDir, users, globalReasons, globalWarnings, ok, isConnectivityBaseline);
}

function buildReport(finalRunDir, users, globalReasons, globalWarnings, ok, isConnectivityBaseline) {
  const userEntries = Object.entries(users).map(([user_id, v]) => ({
    user_id,
    valid: v.valid,
    reasons: v.reasons,
    warnings: v.warnings,
  }));
  return {
    ok,
    session_id: path.basename(finalRunDir),
    result_dir: finalRunDir,
    experiment_class: isConnectivityBaseline ? "connectivity_baseline" : "streaming_lod",
    valid_clients: userEntries.filter((u) => u.valid).length,
    expected_users: userEntries.length || 4,
    users: userEntries,
    global_reasons: globalReasons,
    global_warnings: globalWarnings,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Write validation_report.json under session dir + summary aggregate line.
 * @returns {boolean} ok
 */
export function writeValidationReport(finalRunDir, report) {
  const out = path.join(finalRunDir, "validation_report.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  const summaryDir = path.join(path.dirname(path.dirname(finalRunDir)), "summary");
  fs.mkdirSync(summaryDir, { recursive: true });
  const aggPath = path.join(summaryDir, "validation_reports.jsonl");
  fs.appendFileSync(aggPath, `${JSON.stringify(report)}\n`);
  return report.ok;
}

function isMain() {
  const a = process.argv[1] ?? "";
  return a.includes("data_validation.mjs");
}

if (isMain()) {
  const sessionDir = process.argv[2];
  if (!sessionDir) {
    console.error("usage: data_validation.mjs <finalRunDir> [--delivery-profile X] [--method M] [--canary H1]");
    process.exit(2);
  }
  const opts = {};
  for (let i = 3; i < process.argv.length; i += 2) {
    const k = process.argv[i];
    const v = process.argv[i + 1];
    if (k === "--delivery-profile") opts.delivery_profile = v;
    if (k === "--method") opts.method = v;
    if (k === "--canary") opts.canary = v;
    if (k === "--cdn-label") opts.cdn_label = v;
  }
  const report = validateSessionDataHard(sessionDir, opts);
  writeValidationReport(sessionDir, report);
  if (!report.ok) {
    console.error(`[data-validation] FAIL ${report.session_id}: ${[...report.global_reasons, ...report.users.flatMap((u) => u.reasons.map((r) => `${u.user_id}:${r}`))].join(" | ")}`);
    process.exit(2);
  }
  console.log(`[data-validation] PASS ${report.session_id} valid_clients=${report.valid_clients}/${report.expected_users} class=${report.experiment_class}`);
  process.exit(0);
}
