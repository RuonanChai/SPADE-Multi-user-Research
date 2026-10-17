/**
 * VRC Config
 * Single source of truth for QoE weights and tunable parameters.
 * Injected into every browser client via the instrumented page.
 */
(function () {
  const h = typeof window !== "undefined" && window.__vrcSyncHost
    ? String(window.__vrcSyncHost).trim()
    : "localhost";
  const p = typeof window !== "undefined" && window.__vrcSyncPort != null
    ? Number(window.__vrcSyncPort)
    : 9201;
  window.__vrcConfig = {
    // QoE formula: qoe = visible_quality - alpha*latency_norm - beta*stall_ratio
    qoe_alpha: 0.4,
    qoe_beta: 0.2,

    // Viewport frustum sampling
    frustum_samples: 64,

    // Network pacing (NET-S and VRC)
    max_inflight_bytes: 1.5 * 1024 * 1024, // 1.5 MB
    target_completion_ms: 50,              // interactive target

    // VRC decision interval (ms) — must match server
    decision_interval_ms: 50,

    // Metrics snapshot interval
    metrics_interval_ms: 200,

    // Sync server WebSocket + HTTP (distributed: sync_host query → __vrcSyncHost)
    sync_server_url: `ws://${h}:${p}`,
    sync_server_http: `http://${h}:${p}`,
  };
})();
