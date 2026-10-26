(function () {
  if (window.__P5_OBS_FETCH_WRAP) return;
  window.__P5_OBS_FETCH_WRAP = true;
  const origFetch = window.fetch.bind(window);

  function nums(list) {
    return Array.isArray(list) ? list.map((value) => Number(value)) : null;
  }

  function ensureMeta() {
    if (window.__p5RadMeta || window.__p5RadMetaPending) return;
    const paged = window.__world && window.__world.paged;
    if (!paged || !paged.getRadMeta) return;
    window.__p5RadMetaPending = true;
    paged.getRadMeta().then((value) => {
      window.__p5RadMeta = value;
    }).catch(() => {});
  }

  function rangeFor(chunk) {
    const metaState = window.__p5RadMeta;
    const row = metaState && metaState.meta && metaState.meta.chunks && metaState.meta.chunks[chunk];
    if (!row || row.filename || !Number.isFinite(row.offset) || !Number.isFinite(row.bytes)) {
      return { chunk, start: null, end: null, bytes: null, range_known: false };
    }
    const start = row.offset + (metaState.chunksStart || 0);
    return { chunk, start, end: start + row.bytes - 1, bytes: row.bytes, range_known: true };
  }

  function collect(reason) {
    ensureMeta();
    const frame = window.__p5FrameState || null;
    const camera = frame && frame.camera ? frame.camera : null;
    const pager = window.__spark && window.__spark.pager;
    const priority = pager && pager.fetchPriority ? pager.fetchPriority : [];
    const fetchers = pager && pager.fetchers ? pager.fetchers : [];
    const inflight = new Set(fetchers.map((row) => row.chunk));
    const demand = [];
    const queued = [];
    for (let i = 0; i < priority.length && i < 32; i += 1) {
      const item = rangeFor(priority[i].chunk);
      item.url = priority[i].splats && priority[i].splats.rootUrl ? priority[i].splats.rootUrl : null;
      demand.push(item);
      if (!inflight.has(priority[i].chunk)) queued.push(item);
    }
    const params = new URLSearchParams(location.search);
    const lookahead = Number.parseInt(params.get("spade_traj_lookahead_ms") || "0", 10) || 0;
    return {
      reason,
      ts_ms: Date.now(),
      perf_ms: performance.now(),
      run_id: params.get("run_id"),
      user_id: params.get("user_id"),
      camera_position: camera && camera.position ? nums(camera.position) : null,
      quaternion: camera && camera.quaternion ? nums(camera.quaternion) : null,
      fov: camera && Number.isFinite(camera.fov) ? camera.fov : null,
      viewport: camera && camera.viewport ? nums(camera.viewport) : [window.innerWidth, window.innerHeight],
      visible_splats: Number.isFinite(window.__visibleSplats) ? window.__visibleSplats : null,
      total_splats: Number.isFinite(window.__totalSplats) ? window.__totalSplats : null,
      queued_unsent: queued.slice(0, 8),
      queued_unsent_count: queued.length,
      renderer_demand: demand.slice(0, 8),
      renderer_demand_count: priority.length,
      inflight_count: fetchers.length,
      meta_ready: Boolean(window.__p5RadMeta),
      uses_future_trace_frame: lookahead > 0,
      lookahead_ms: lookahead,
    };
  }

  function compact(rows) {
    return rows.filter((row) => row.range_known).slice(0, 8).map((row) => `${row.start}-${row.end}`).join(",");
  }

  window.__p5CollectObservation = collect;

  window.fetch = function (input, init) {
    try {
      const rawUrl = typeof input === "string" ? input : (input && input.url);
      if (rawUrl && (String(rawUrl).includes("_p5rad") || String(rawUrl).includes(".rad"))) {
        const obs = collect("at_fetch");
        if (window.__sparkExpEvent) window.__sparkExpEvent({ type: "client_observation", observation: obs });
        const headers = new Headers((init && init.headers) || (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined));
        headers.set("x-p5-obs-reason", "at_fetch");
        if (obs.camera_position) headers.set("x-p5-pose", obs.camera_position.join(","));
        if (obs.quaternion) headers.set("x-p5-quat", obs.quaternion.join(","));
        if (obs.fov != null) headers.set("x-p5-fov", String(obs.fov));
        if (obs.viewport) headers.set("x-p5-vp", obs.viewport.join(","));
        if (obs.visible_splats != null) headers.set("x-p5-vis", String(obs.visible_splats));
        headers.set("x-p5-queued", compact(obs.queued_unsent));
        headers.set("x-p5-demand", compact(obs.renderer_demand));
        headers.set("x-p5-future-frame", obs.lookahead_ms > 0 ? "1" : "0");
        if (typeof Request !== "undefined" && input instanceof Request) input = new Request(input, { headers });
        else init = Object.assign({}, init, { headers });
      }
    } catch (_) {}
    return origFetch(input, init);
  };

  setInterval(() => {
    try {
      const obs = collect("interval");
      if (!obs.run_id || !obs.user_id) return;
      if (window.__sparkExpEvent) window.__sparkExpEvent({ type: "client_observation", observation: obs });
      const body = JSON.stringify(obs);
      origFetch("http://192.168.1.200:18081/client-observation", {
        method: "POST",
        headers: { "content-type": "application/json", "x-run-id": obs.run_id, "x-user-id": obs.user_id },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch (_) {}
  }, 200);
})();
