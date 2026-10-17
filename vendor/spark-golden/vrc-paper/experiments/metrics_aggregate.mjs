/**
 * Shared per-user / per-session metric aggregation for run_experiment + distributed merge.
 */

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

export function normalizeRangeHeader(h) {
  if (h == null) return "";
  return String(h).trim();
}

export function chunkDedupKey(r) {
  const rangeK = normalizeRangeHeader(r.range_key ?? r.range ?? r.req_range);
  return `${String(r.url ?? "")}\t${rangeK}`;
}

export function isCompletedChunkRow(r) {
  return r.url
    && /\.(rad|spz|splat)(\?|#|$)/i.test(String(r.url))
    && Number(r.service_time_ms ?? 0) > 0
    && Number(r.service_time_ms) < 120000;
}

export function collectSharedChunkKeysFromDecisions(vrcDecisions = []) {
  const keys = new Set();
  for (const d of vrcDecisions) {
    for (const c of d.shared_chunks ?? []) keys.add(String(c));
    const cd = d.chunk_delivery ?? {};
    for (const [k, v] of Object.entries(cd)) {
      if (v && typeof v === "object" && v.shared) keys.add(String(k));
    }
  }
  return keys;
}

export function computeLatencyStats(latencies) {
  const lats = latencies.filter((x) => x > 0 && x < 120000).sort((a, b) => a - b);
  if (!lats.length) {
    return {
      p50_latency_ms: 0,
      p95_latency_ms: 0,
      p99_latency_ms: 0,
      fraction_over_50ms: 0,
    };
  }
  return {
    p50_latency_ms: percentile(lats, 0.5),
    p95_latency_ms: percentile(lats, 0.95),
    p99_latency_ms: percentile(lats, 0.99),
    fraction_over_50ms: lats.filter((x) => x > 50).length / lats.length,
  };
}

/**
 * @param {object[]} chunkRows completed chunk request rows for one user (or all users)
 * @param {Set<string>} [sharedChunkKeys] from VRC decisions
 */
export function computeSharedPersonalizedBytes(chunkRows, sharedChunkKeys = new Set()) {
  let shared_bytes = 0;
  let personalized_bytes = 0;
  for (const r of chunkRows) {
    const bytes = Math.max(0, Number(r.bytes_sent ?? r.bytes ?? 0) || 0);
    if (bytes <= 0) continue;
    const reason = String(r.source_reason ?? "");
    const ck = String(r.chunk_key ?? "");
    const lod = /lod-(\d+)/.exec(String(r.url ?? ""));
    const chunkId = ck || (lod ? lod[1] : "");
    const isShared = reason === "shared_hot"
      || reason === "static_cdn"
      || (chunkId && sharedChunkKeys.has(chunkId));
    if (isShared) shared_bytes += bytes;
    else personalized_bytes += bytes;
  }
  return { shared_bytes, personalized_bytes };
}

/**
 * Viewport latency: prefer browser chunk-event timings; else per-chunk completion from logs.
 */
export function computeViewportLatency(browserSnap = {}, chunkRows = []) {
  const fromBrowser = Array.isArray(browserSnap.viewport_latencies)
    ? browserSnap.viewport_latencies.filter((x) => x > 0 && x < 120000)
    : [];
  if (fromBrowser.length) {
    const sorted = [...fromBrowser].sort((a, b) => a - b);
    return {
      viewport_to_visible_latency_ms: percentile(sorted, 0.95),
      viewport_to_visible_latency_source: "browser_chunk_events",
    };
  }
  const proxy = chunkRows
    .map((r) => Number(r.object_or_range_completion_ms ?? r.service_time_ms ?? 0))
    .filter((x) => x > 0 && x < 120000);
  if (proxy.length) {
    const sorted = [...proxy].sort((a, b) => a - b);
    return {
      viewport_to_visible_latency_ms: percentile(sorted, 0.95),
      viewport_to_visible_latency_source: "object_or_range_completion_proxy",
    };
  }
  return {
    viewport_to_visible_latency_ms: 0,
    viewport_to_visible_latency_source: "no_chunk_timing",
  };
}

/**
 * Full latency + byte metrics for one user's chunk rows (+ optional browser snapshot).
 */
export function computeUserMetricsBundle(chunkRows, browserSnap = {}, sharedChunkKeys = new Set()) {
  const completed = chunkRows.filter(isCompletedChunkRow);
  const completionLats = completed.map((r) => Number(r.service_time_ms));
  const lat = computeLatencyStats(completionLats);
  const viewport = computeViewportLatency(browserSnap, completed);
  const totalBytes = completed.reduce((s, r) => s + (Number(r.bytes_sent ?? 0) || 0), 0);
  const dupMap = completed.reduce((m, r) => {
    const k = chunkDedupKey(r);
    m[k] = (m[k] || 0) + 1;
    return m;
  }, {});
  const dupKeys = Object.keys(dupMap);
  const dupCount = Object.values(dupMap).filter((v) => v > 1).length;
  const { shared_bytes, personalized_bytes } = computeSharedPersonalizedBytes(completed, sharedChunkKeys);

  const browserP95 = Number(browserSnap.p95_latency_ms ?? 0);
  const useBrowserLatency = browserP95 > 0 && (browserSnap.viewport_to_visible_latency_source === "browser_chunk_events"
    || (Array.isArray(browserSnap.viewport_latencies) && browserSnap.viewport_latencies.length > 0));

  return {
    ...lat,
    p95_latency_source: "object_or_range_completion",
    fraction_over_50ms_source: "object_or_range_completion",
    ...viewport,
    object_or_range_completion_ms: lat.p50_latency_ms,
    object_or_range_completion_p95_ms: lat.p95_latency_ms,
    aggregate_client_bytes: totalBytes,
    unique_bytes: totalBytes,
    duplicate_request_ratio: dupKeys.length ? dupCount / dupKeys.length : 0,
    chunk_request_count: completed.length,
    shared_bytes,
    personalized_bytes,
    fps: browserSnap.fps ?? 0,
    stall_time: browserSnap.stall_time ?? 0,
    visible_quality: browserSnap.visible_quality ?? 0,
    qoe: browserSnap.qoe ?? 0,
    vrc_scheduling_delay_ms: browserSnap.vrc_scheduling_delay_ms ?? 0,
    sync_delay_ms: browserSnap.sync_delay_ms ?? 0,
    request_inflight_bytes: browserSnap.request_inflight_bytes ?? 0,
    recent_completion_ms: browserSnap.recent_completion_ms ?? 0,
    _browser_latency_used: useBrowserLatency,
  };
}

export function computeNetworkMetricsFromRequests(allRequestLogs, vrcDecisions = []) {
  const chunkRequests = allRequestLogs.filter(isCompletedChunkRow);
  if (!chunkRequests.length) return {};
  const sharedKeys = collectSharedChunkKeysFromDecisions(vrcDecisions);
  const bundle = computeUserMetricsBundle(chunkRequests, {}, sharedKeys);
  const dupUrls = chunkRequests.reduce((m, r) => {
    m[r.url] = (m[r.url] || 0) + 1;
    return m;
  }, {});
  const dupCount = Object.values(dupUrls).filter((v) => v > 1).length;
  return {
    ...bundle,
    duplicate_request_ratio: dupCount / Math.max(1, Object.keys(dupUrls).length),
    _source: "playwright_network_log",
  };
}

/**
 * Build one row for per_client_metrics.csv (transport + full user metrics).
 */
export function buildPerClientMetricRow({
  session_id,
  method,
  scenario,
  trial,
  delivery_profile,
  user_id,
  worker_id = "",
  host_ip = "",
  cdn_label = "",
  chunkRows = [],
  browserSnap = {},
  sharedChunkKeys = new Set(),
  sourceBreakdown = null,
  audit = null,
}) {
  const breakdown = sourceBreakdown ?? null;
  const bundle = computeUserMetricsBundle(chunkRows, browserSnap, sharedChunkKeys);
  const transport = breakdown ?? {
    hpc_request_count: 0,
    cdn_request_count: 0,
    cdn2_request_count: 0,
    hpc_bytes: 0,
    cdn_bytes: 0,
    cdn2_bytes: 0,
    fallback_count: 0,
    fallback_bytes: 0,
    shared_hot_cdn_ratio: bundle.shared_bytes > 0 && bundle.aggregate_client_bytes > 0
      ? bundle.shared_bytes / Math.max(1, bundle.aggregate_client_bytes)
      : 0,
    personalized_origin_ratio: bundle.personalized_bytes > 0 && bundle.aggregate_client_bytes > 0
      ? bundle.personalized_bytes / Math.max(1, bundle.aggregate_client_bytes)
      : 0,
  };
  const aggBytes = Math.max(1, bundle.aggregate_client_bytes || 0);
  return {
    session_id,
    method,
    scenario,
    trial,
    delivery_profile,
    user_id,
    worker_id,
    host_ip,
    cdn_label,
    ...transport,
    ...bundle,
    shared_hot_cdn_ratio: bundle.shared_bytes > 0 ? bundle.shared_bytes / aggBytes : (transport.shared_hot_cdn_ratio ?? 0),
    personalized_origin_ratio: bundle.personalized_bytes > 0 ? bundle.personalized_bytes / aggBytes : (transport.personalized_origin_ratio ?? 0),
    metrics_source: bundle.viewport_to_visible_latency_source,
    ...(audit && typeof audit === "object" ? audit : {}),
  };
}

export function buildPerClientMetricRows({
  sessionId,
  method,
  scenario,
  trialIdx,
  deliveryProfile,
  cdnLabel,
  userIds,
  chunkRequests,
  finalMetricsByUser = {},
  shardMetaByUser = {},
  sharedChunkKeys = new Set(),
  computeSourceBreakdownFromChunkLogs,
  dominantCdnLabelFromChunkRows,
  getCdnLabelForUserIndex,
}) {
  return userIds.map((uid) => {
    const i = Number(String(uid).replace(/^u/, ""));
    const rows = chunkRequests.filter((r) => String(r.user_id) === uid);
    const browserSnap = finalMetricsByUser[uid] ?? {};
    const meta = shardMetaByUser[uid] ?? {};
    const userCdn = (typeof dominantCdnLabelFromChunkRows === "function" ? dominantCdnLabelFromChunkRows(rows) : "")
      || (typeof getCdnLabelForUserIndex === "function" ? getCdnLabelForUserIndex(i) : "")
      || cdnLabel
      || "";
    const breakdown = typeof computeSourceBreakdownFromChunkLogs === "function"
      ? computeSourceBreakdownFromChunkLogs(rows)
      : null;
    return buildPerClientMetricRow({
      session_id: sessionId,
      method,
      scenario,
      trial: trialIdx,
      delivery_profile: deliveryProfile,
      user_id: uid,
      worker_id: meta.worker_id ?? rows[0]?.worker_id ?? "",
      host_ip: meta.host_ip ?? rows[0]?.host_ip ?? "",
      cdn_label: userCdn,
      chunkRows: rows,
      browserSnap,
      sharedChunkKeys,
      sourceBreakdown: breakdown,
    });
  });
}
