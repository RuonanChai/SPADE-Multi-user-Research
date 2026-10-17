/**
 * VRC Metric Collector
 * Hooks into window.__sparkExpEvent (emitted by SplatPager.ts) and tracks:
 * - viewport_to_visible_latency_ms per chunk
 * - duplicate_request_ratio
 * - bytes transferred
 * - fps, stall_time, visible_quality, qoe
 */
(function () {
  "use strict";

  const cfg = window.__vrcConfig;
  const userId = window.__vrcUserId ?? "u0";
  const method = window.__vrcMethod ?? "Spark-MU";
  const sessionId = window.__vrcSessionId ?? "session_0";
  const scenarioId = window.__vrcScenarioId ?? "nearby";

  const metrics = {
    user_id: userId,
    method,
    session_id: sessionId,
    scenario_id: scenarioId,

    // per-chunk timing
    chunk_request_times: new Map(),   // chunkKey → t_request
    chunk_complete_times: new Map(),  // chunkKey → t_complete
    chunk_bytes: new Map(),           // chunkKey → bytes

    // aggregates
    viewport_latencies: [],
    duplicate_chunks: new Set(),
    seen_chunks: new Set(),
    total_bytes: 0,
    shared_bytes: 0,
    personalized_bytes: 0,

    // rendering
    frame_times: [],
    stall_events: 0,
    last_frame_t: null,
    visible_splat_counts: [],

    // inflight tracking
    inflight_bytes: 0,
    recent_completions: [],
  };

  // ── Spark experiment event hook ──────────────────────────────────────────────
  // Drain any events buffered by the early stub installed in vrc_scene.html
  const buffered = window.__sparkExpEventQueue ?? [];
  window.__sparkExpEventQueue = null; // prevent further buffering

  function handleSparkEvent(evt) {
    const t = evt._t ?? performance.now(); // use original event time if available
    // Spark emits: "scheduler_decision", "fetch_enqueue", "fetch_response"
    // Our fetch interceptor adds: "chunk_request_start", "chunk_complete", "chunk_error"
    const chunkKey = evt.pathName ?? evt.chunkId ?? evt.object_id ?? String(evt.chunk ?? "?");

    // Spark native: fetch_enqueue = chunk request started
    if (evt.type === "fetch_enqueue" || evt.type === "chunk_request_start") {
      metrics.chunk_request_times.set(chunkKey, t);
      metrics.inflight_bytes += evt.bytes ?? 0;
      if (metrics.seen_chunks.has(chunkKey)) {
        metrics.duplicate_chunks.add(chunkKey);
      }
      metrics.seen_chunks.add(chunkKey);
      sendWs({ type: "chunk_event", event: "request_start", chunk: chunkKey, bytes: evt.bytes, t });
    }

    // Spark native: fetch_response = chunk completed
    if (evt.type === "fetch_response" || evt.type === "chunk_complete") {
      const tReq = evt._t_req ?? metrics.chunk_request_times.get(chunkKey) ?? t;
      const latency = t - tReq;
      metrics.chunk_complete_times.set(chunkKey, t);
      metrics.inflight_bytes = Math.max(0, metrics.inflight_bytes - (evt.bytes ?? 0));
      if (latency >= 0 && latency < 60000) { // sanity: <60s
        metrics.viewport_latencies.push(latency);
      }
      metrics.total_bytes += evt.bytes ?? (evt.num_splats ? evt.num_splats * 32 : 0);
      metrics.chunk_bytes.set(chunkKey, evt.bytes ?? 0);
      metrics.recent_completions.push({ t, latency, bytes: evt.bytes ?? 0 });
      if (metrics.recent_completions.length > 20) metrics.recent_completions.shift();
      sendWs({ type: "chunk_event", event: "complete", chunk: chunkKey, latency_ms: latency, bytes: evt.bytes, t });
    }

    if (evt.type === "chunk_error") {
      sendWs({ type: "chunk_event", event: "error", chunk: chunkKey, t });
    }

    // scheduler_decision: track VRC decisions
    if (evt.type === "scheduler_decision") {
      // Track object/chunk being prioritized
      if (!metrics.seen_chunks.has(chunkKey)) {
        metrics.seen_chunks.add(chunkKey);
      }
    }

    // Track VRC decisions that mark chunks as shared vs personalized
    if (evt.type === "vrc_scheduled" && evt.shared) {
      metrics.shared_bytes += evt.bytes ?? 0;
    }
    if (evt.type === "vrc_scheduled" && !evt.shared) {
      metrics.personalized_bytes += evt.bytes ?? 0;
    }
  }

  // Install the real handler
  window.__sparkExpEvent = handleSparkEvent;

  // Drain buffered events from the early stub
  for (const evt of buffered) {
    try { handleSparkEvent(evt); } catch {}
  }
  console.log(`[vrc] metric_collector: drained ${buffered.length} buffered events`);

  // ── Frame loop: fps + stall detection ────────────────────────────────────────
  const origLoop = window.__sparkAnimCallback;
  let frameCount = 0;
  let fpsWindowStart = performance.now();

  function patchAnimationLoop() {
    const canvas = document.getElementById("canvas");
    if (!canvas) { setTimeout(patchAnimationLoop, 200); return; }

    const origRAF = window.requestAnimationFrame.bind(window);
    const wrappedRAF = (cb) => origRAF((t) => {
      const now = performance.now();
      const dt = metrics.last_frame_t ? now - metrics.last_frame_t : 0;
      metrics.last_frame_t = now;
      if (dt > 100) metrics.stall_events++;
      metrics.frame_times.push(dt);
      if (metrics.frame_times.length > 300) metrics.frame_times.shift();
      frameCount++;
      cb(t);
    });
    // Note: cannot easily patch RAF without breaking the renderer;
    // instead we poll via our own RAF loop
  }

  let _lastFrameT = null;
  (function rafLoop(t) {
    const now = performance.now();
    if (_lastFrameT !== null) {
      const dt = now - _lastFrameT;
      if (dt > 100) metrics.stall_events++;
      metrics.frame_times.push(dt);
      if (metrics.frame_times.length > 600) metrics.frame_times.shift();
    }
    _lastFrameT = now;
    window.requestAnimationFrame(rafLoop);
  })(0);

  // ── Compute summary metrics ───────────────────────────────────────────────────
  function computeSummary() {
    const lats = [...metrics.viewport_latencies].sort((a, b) => a - b);
    const n = lats.length;
    const p50 = n ? lats[Math.floor(n * 0.5)] : 0;
    const p95 = n ? lats[Math.floor(n * 0.95)] : 0;
    const p99 = n ? lats[Math.floor(n * 0.99)] : 0;
    const frac50 = n ? lats.filter((x) => x > 50).length / n : 0;
    const fts = metrics.frame_times.filter((x) => x > 0);
    const fps = fts.length ? 1000 / (fts.reduce((a, b) => a + b, 0) / fts.length) : 0;
    const stall_ratio = fts.length ? fts.filter((x) => x > 100).length / fts.length : 0;
    // visible_quality: proxy by fraction of scene chunks loaded (0–1)
    const visible_quality = Math.min(1, metrics.seen_chunks.size / Math.max(1, window.__vrcTotalChunks ?? 50));
    const latency_norm = Math.min(1, p95 / 1000);
    const qoe = visible_quality - cfg.qoe_alpha * latency_norm - cfg.qoe_beta * stall_ratio;

    const recent = metrics.recent_completions;
    const recent_completion_ms = recent.length
      ? recent.reduce((a, b) => a + b.latency, 0) / recent.length
      : 0;

    return {
      user_id: userId,
      method,
      session_id: sessionId,
      scenario_id: scenarioId,
      t: Date.now(),
      p50_latency_ms: p50,
      p95_latency_ms: p95,
      p99_latency_ms: p99,
      fraction_over_50ms: frac50,
      viewport_to_visible_latency_ms: n ? p95 : 0,
      viewport_to_visible_latency_source: n ? "browser_chunk_events" : "no_chunk_events_yet",
      viewport_latencies: lats,
      object_or_range_completion_ms: p50,
      object_or_range_completion_p95_ms: p95,
      p95_latency_source: "object_or_range_completion",
      duplicate_request_ratio: metrics.seen_chunks.size
        ? metrics.duplicate_chunks.size / metrics.seen_chunks.size
        : 0,
      unique_bytes: metrics.total_bytes,
      aggregate_client_bytes: metrics.total_bytes,
      shared_bytes: metrics.shared_bytes,
      personalized_bytes: metrics.personalized_bytes,
      fps,
      stall_time: metrics.stall_events * 16,
      visible_quality,
      qoe,
      vrc_scheduling_delay_ms: 0,
      sync_delay_ms: window.__vrcSyncDelay ?? 0,
      request_inflight_bytes: metrics.inflight_bytes,
      recent_completion_ms,
    };
  }

  // Expose for the experiment runner to call via page.evaluate()
  window.__vrcGetMetrics = computeSummary;
  window.__vrcRawMetrics = metrics;
  // VRC decision log: accumulate all decisions received from server
  window.__vrcDecisionLog = [];

  // ── WebSocket sync ────────────────────────────────────────────────────────────
  let ws = null;
  let wsConnected = false;
  let wsPendingQueue = [];

  function connectWs() {
    try {
      ws = new WebSocket(cfg.sync_server_url + `?user_id=${encodeURIComponent(userId)}`);
      ws.onopen = () => {
        wsConnected = true;
        for (const m of wsPendingQueue) ws.send(JSON.stringify(m));
        wsPendingQueue = [];
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          window.__vrcLastServerMsg = msg;
          if (msg.type === "vrc_decision") {
            window.__vrcDecision = msg;
            window.__vrcLatestDecision = msg;
            window.__vrcDecisionLog = window.__vrcDecisionLog ?? [];
            window.__vrcDecisionLog.push({ ...msg, t_client: Date.now() });
          }
          if (msg.type === "peer_states" || msg.type === "peer_state_update") {
            window.__vrcPeers = msg.peers ?? window.__vrcPeers ?? [];
          }
        } catch {}
      };
      ws.onclose = () => {
        wsConnected = false;
        setTimeout(connectWs, 2000);
      };
      ws.onerror = () => {
        // silent; will reconnect on close
      };
    } catch {}
  }

  function sendWs(msg) {
    if (wsConnected && ws?.readyState === 1) {
      ws.send(JSON.stringify(msg));
    } else {
      wsPendingQueue.push(msg);
    }
  }

  // ── Periodic viewport state sync ──────────────────────────────────────────────
  function getViewportChunks() {
    // Derive visible chunk IDs from VRC decision or local camera
    const decision = window.__vrcDecision;
    if (decision) {
      const uid = userId;
      const shared = decision.shared_chunks ?? [];
      const personal = decision.personalized_chunks?.[uid] ?? [];
      return [...shared, ...personal];
    }
    // Fallback: use seen chunks as proxy for viewport demand
    return [...metrics.seen_chunks];
  }

  function sendUserState() {
    const cam = window.__slDiagCam;
    const pos = cam ? [cam.position.x, cam.position.y, cam.position.z] : [0, 0, 0];
    const quat = cam ? [cam.quaternion.x, cam.quaternion.y, cam.quaternion.z, cam.quaternion.w] : [0, 0, 0, 1];
    const t0 = performance.now();
    const msg = {
      type: "user_state",
      user_id: userId,
      method,
      t: Date.now(),
      position: pos,
      quaternion: quat,
      viewport_chunks: getViewportChunks(),
      inflight_bytes: metrics.inflight_bytes,
      recent_completion_ms: computeSummary().recent_completion_ms,
    };
    const t1 = performance.now();
    sendWs(msg);
    // expose sync delay
    window.__vrcSyncDelay = t1 - t0;
  }

  // ── Periodic metrics POST to server ──────────────────────────────────────────
  function pushMetrics() {
    const summary = computeSummary();
    sendWs({ type: "metrics_snapshot", ...summary });
    // Also POST to HTTP for aggregation
    fetch(`${cfg.sync_server_http}/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(summary),
    }).catch(() => {});
  }

  // Start periodic tasks
  connectWs();
  setInterval(sendUserState, cfg.decision_interval_ms);
  setInterval(pushMetrics, cfg.metrics_interval_ms);

  console.log(`[vrc] metric_collector active: user=${userId} method=${method} session=${sessionId}`);
})();
