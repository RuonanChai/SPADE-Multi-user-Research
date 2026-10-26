"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const { createCache } = require("./matched_cache");
const { Fg1 } = require("./fg1_cache");
const { Fg2 } = require("./fg2_cache");
const { Fg3 } = require("./fg3_cache");
const { Fg4 } = require("./fg4_cache");
const { Fg5 } = require("./fg5_cache");
const { SpadeByteCache } = require("./spade_byte_cache");
const { regimeForRunId } = require("./phase_regimes");
const { createIdentity } = require("./request_trace");
const { observationFromHeaders, normalizePosted, shouldProtect, SpadeQueueCache } = require("./observation_signal");
const { createSpade5 } = require("./spade5_facade");
const { TrustedDigestStore, resolveMiss, fetchPeerChecked, RUNTIME_VERSION } = require("./verified_peer");

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const METHOD = flag("--method", "LRU");
const HANDOFF = flag("--handoff", METHOD === "SPADE-BYTE" ? "1" : "0") === "1";
const PORT = Number(flag("--port", "18081"));
const ORIGIN = flag("--origin-url", "");
const RUN_ID = flag("--run-id", "");
const EVIDENCE = flag("--evidence-dir", "");
const CACHE_MAX_ENTRIES = Number(flag("--cache-max-entries", "100"));
const CACHE_MAX_BYTES = Math.round(Number(flag("--cache-max-mb", "50")) * 1024 * 1024);
const DLS_K = Number(flag("--dls-k", "0"));
if (!["LRU", "FIFO", "SIEVE", "S3-FIFO", "IND", "SPADE_F", "SPADE_Q", "SPADE-M200", "SPADE-HOLD", "SPADE-PRESS", "SPADE-DEMAND", "SPADE-R2", "SPADE-S3", "SPADE-FG1", "SPADE-FG2", "SPADE-FG3", "SPADE-FG4", "SPADE-FG5", "SPADE-BYTE"].includes(METHOD) || !ORIGIN || !RUN_ID || !EVIDENCE) {
  throw new Error("PROXY_ARGS");
}
const CACHE_ALLOWED = new Set(["52428800:100", "555745280:100", "1073741824:100", "52428800:2000", "1073741824:2000", "268435456:2000"]);
if (!CACHE_ALLOWED.has(`${CACHE_MAX_BYTES}:${CACHE_MAX_ENTRIES}`) || DLS_K !== 0) {
  throw new Error(`PROXY_CONTRACT ${CACHE_MAX_BYTES} ${CACHE_MAX_ENTRIES} ${DLS_K}`);
}
fs.mkdirSync(EVIDENCE, { recursive: true });
const requestLog = fs.createWriteStream(`${EVIDENCE}/proxy.jsonl`, { flags: "a" });
const decisionLog = fs.createWriteStream(`${EVIDENCE}/proxy_decisions.jsonl`, { flags: "a" });
const resourceLog = fs.createWriteStream(`${EVIDENCE}/proxy_resource.jsonl`, { flags: "a" });
const identity = createIdentity();
const live = METHOD === "SPADE_F" ? require("./spade_f_live").createLiveCache(CACHE_MAX_BYTES, CACHE_MAX_ENTRIES) : null;
const independent = METHOD === "IND";
const observations = new Map();
const signaling = { posts: 0, bytes: 0 };
let activeUser = "";
const queueCache = METHOD === "SPADE_Q" ? new SpadeQueueCache(CACHE_MAX_BYTES, CACHE_MAX_ENTRIES, (key) => shouldProtect(key, observations, Date.now(), activeUser).protect) : null;
const spade5 = createSpade5(METHOD);
const fg1 = METHOD === "SPADE-FG1" ? new Fg1(CACHE_MAX_BYTES, CACHE_MAX_ENTRIES) : null;
const fg2 = METHOD === "SPADE-FG2" ? new Fg2(CACHE_MAX_BYTES, CACHE_MAX_ENTRIES) : null;
const fg3 = METHOD === "SPADE-FG3" ? new Fg3(CACHE_MAX_BYTES, CACHE_MAX_ENTRIES, regimeForRunId(RUN_ID)) : null;
const fg4 = METHOD === "SPADE-FG4" ? new Fg4(CACHE_MAX_BYTES, CACHE_MAX_ENTRIES) : null;
const fg5 = METHOD === "SPADE-FG5" ? new Fg5(CACHE_MAX_BYTES, CACHE_MAX_ENTRIES, regimeForRunId(RUN_ID)) : null;
const spadeByte = METHOD === "SPADE-BYTE" ? new SpadeByteCache(CACHE_MAX_BYTES, CACHE_MAX_ENTRIES) : null;
if (fg5) {
  decisionLog.write(JSON.stringify({ timestamp: Date.now(), type: "fg5_mode", regime: fg5.regime, mode: fg5.mode, implementation: "createCache" }) + "\n");
}
if (spadeByte) {
  spadeByte.onRho = (row) => decisionLog.write(JSON.stringify({ timestamp: Date.now(), type: "spade_byte_rho", ...row, uses_future_trace_frame: false }) + "\n");
  decisionLog.write(JSON.stringify({ timestamp: Date.now(), type: "spade_byte", ...spadeByte.contract() }) + "\n");
}
decisionLog.write(JSON.stringify({ timestamp: Date.now(), type: "handoff_switch", enabled: HANDOFF, hold_ms: 15000, client_cap_bytes: 160 * 1024 * 1024, proxy_cache_bytes: CACHE_MAX_BYTES, proxy_cache_entries: CACHE_MAX_ENTRIES }) + "\n");
const cache = independent || live || queueCache || spade5 || fg1 || fg2 || fg3 || fg4 || fg5 || spadeByte ? null : createCache(METHOD, CACHE_MAX_BYTES, CACHE_MAX_ENTRIES);
const userCaches = new Map();
function cacheFor(userId) {
  if (spadeByte) return spadeByte;
  if (fg5) return fg5;
  if (fg4) return fg4;
  if (fg3) return fg3;
  if (fg2) return fg2;
  if (fg1) return fg1;
  if (spade5) return spade5;
  if (live) return live;
  if (queueCache) return queueCache;
  if (!independent) return cache;
  if (!userCaches.has(userId)) userCaches.set(userId, createCache("FIFO", CACHE_MAX_BYTES, CACHE_MAX_ENTRIES));
  return userCaches.get(userId);
}
function rememberObservation(userId, obs) {
  observations.set(userId, obs);
}
function signalFields(userId, cacheKey, now) {
  const signal = shouldProtect(cacheKey, observations, now, userId);
  const past = [];
  for (const [user, obs] of observations) {
    if (!obs || obs.received_ms > now) continue;
    past.push({
      user_id: user,
      received_ms: obs.received_ms,
      source: obs.source,
      pose: obs.pose || null,
      viewport: obs.viewport || null,
      fov: obs.fov == null ? null : obs.fov,
      visible_splats: obs.visible_splats == null ? null : obs.visible_splats,
      queued_unsent_count: (obs.queued_unsent || []).length,
      renderer_demand_count: (obs.renderer_demand || []).length,
      uses_future_trace_frame: obs.uses_future_trace_frame === true,
    });
  }
  return {
    past_observation_count: past.length,
    past_observations: past,
    queued_by_other_user: signal.protect,
    signal_user_id: signal.user_id,
    signal_received_ms: signal.received_ms,
    uses_future_trace_frame: false,
    signaling_posts: signaling.posts,
    signaling_bytes: signaling.bytes,
  };
}
const inflight = new Map();
const stats = { requests: 0, hits: 0, misses: 0, merges: 0, origin: 0, evictions: 0, handoff: 0, handoffFail: 0 };
const holders = new Map();
const digests = new TrustedDigestStore();
const HANDOFF_HOLD_MS = 15000;

function write(stream, row) {
  stream.write(JSON.stringify(row) + "\n");
}
function decision(row) {
  write(decisionLog, { timestamp: Date.now(), strategy: METHOD, ...row });
}
function normalizeUser(value) {
  const text = value || "unknown";
  return text.startsWith("user_") ? text : `user_${text}`;
}

function holderIp(userId) {
  if (userId === "user_C3_0") return "192.168.1.197";
  if (userId === "user_C4_1") return "192.168.1.196";
  if (userId === "user_C5_2") return "192.168.1.195";
  return "";
}
function noteHolder(key, userId) {
  const ip = holderIp(userId);
  if (!key || !userId || !ip) return;
  const rows = holders.get(key) || [];
  const now = Date.now();
  const kept = rows.filter((row) => now - row.time <= HANDOFF_HOLD_MS && row.userId !== userId);
  kept.push({ userId, ip, time: now });
  holders.set(key, kept);
}
function newestOtherHolder(key, userId) {
  const now = Date.now();
  const rows = (holders.get(key) || []).filter((row) => row.userId !== userId && now - row.time <= HANDOFF_HOLD_MS);
  if (!rows.length) return null;
  rows.sort((left, right) => right.time - left.time);
  return rows[0];
}
function fetchPeer() {
  throw new Error("UNVERIFIED_PEER_PATH_REMOVED");
}
function fetchOrigin(targetUrl, rangeHeader, meta) {
  const started = Date.now();
  decision({ type: "origin_fetch", request_id: meta.request_id, url: targetUrl, range: rangeHeader || null, origin_start_ms: started, cache_key: meta.cache_key });
  return new Promise((resolve, reject) => {
    const lib = targetUrl.startsWith("https:") ? https : http;
    const url = new URL(targetUrl);
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (targetUrl.startsWith("https:") ? 443 : 80),
      path: url.pathname + url.search,
      method: "GET",
      headers: rangeHeader ? { Range: rangeHeader } : {},
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      let first = null;
      res.on("data", (chunk) => {
        if (first === null) first = Date.now();
        chunks.push(chunk);
      });
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        const ended = Date.now();
        stats.origin += body.length;
        decision({
          type: "origin_response",
          url: targetUrl,
          status: res.statusCode,
          bytes: body.length,
          content_range: res.headers["content-range"] || null,
          etag: res.headers.etag || null,
          request_id: meta.request_id,
          cache_key: meta && meta.cache_key || null,
          user_id: meta && meta.user_id || null,
          range: rangeHeader || null,
          origin_first_byte_ms: first,
          origin_end_ms: ended,
          origin_start_ms: started,
        });
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          originTtfbMs: first === null ? null : first - started,
        });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("origin timeout")));
    req.end();
  });
}

function send(res, status, headers, body) {
  const out = {
    ...headers,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Origin, Range, Content-Type, Accept, X-User-ID, X-Run-ID",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  delete out["content-length"];
  delete out["transfer-encoding"];
  if (body) out["Content-Length"] = body.length;
  res.writeHead(status, out);
  res.end(body || "");
}

function logClient(row) {
  write(requestLog, { timestamp: Date.now(), method: METHOD, ...row });
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/runtime-contract")) {
    const contract = {
      schema_version: 1,
      run_id: RUN_ID,
      pid: process.pid,
      started_at: new Date(server.startedAt).toISOString(),
      method: METHOD,
      port: PORT,
      origin_url: ORIGIN,
      force_origin: true,
      cache_max_entries: CACHE_MAX_ENTRIES,
      cache_max_bytes: CACHE_MAX_BYTES,
      cache_namespace: independent ? "PER_USER_FIFO_ARCHITECTURAL_CONTEXT_NOT_BUDGET_MATCHED" : "SHARED",
      dls_k: 0,
      dls_gate: "partial",
      fetcher_slots: 3,
      origin_slots: -1,
      scheduler_source_sha256: crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex"),
      colru_scoring_source_sha256: crypto.createHash("sha256").update(fs.readFileSync(require.resolve("./matched_cache.js"))).digest("hex"),
      evidence_dir: EVIDENCE,
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(contract));
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" });
    res.end();
    return;
  }
  if (req.method === "POST" && req.url.split("?")[0] === "/client-observation") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const runHeader = req.headers["x-run-id"];
      if (runHeader !== RUN_ID) {
        res.writeHead(409, { "Access-Control-Allow-Origin": "*" });
        res.end("Stale run ID rejected");
        return;
      }
      let body = {};
      try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch (_) { body = {}; }
      const userId = normalizeUser(req.headers["x-user-id"] || body.user_id);
      const obs = normalizePosted(body, Date.now());
      rememberObservation(userId, obs);
      signaling.posts += 1;
      signaling.bytes += raw.length;
      decision({
        type: "client_observation",
        user_id: userId,
        source: obs.source,
        pose: obs.pose,
        quaternion: obs.quaternion,
        fov: obs.fov,
        viewport: obs.viewport,
        visible_splats: obs.visible_splats,
        queued_unsent: obs.queued_unsent,
        renderer_demand: obs.renderer_demand,
        meta_ready: obs.meta_ready,
        uses_future_trace_frame: obs.uses_future_trace_frame,
        signaling_bytes: raw.length,
        signaling_bytes_total: signaling.bytes,
      });
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
      res.end();
    });
    return;
  }
  const parsed = new URL(req.url, "http://127.0.0.1");
  const runId = req.headers["x-run-id"] || parsed.searchParams.get("run_id");
  if (runId !== RUN_ID) {
    res.writeHead(409, { "Access-Control-Allow-Origin": "*", "X-P5-Reject-Reason": "STALE_RUN_ID" });
    res.end("Stale run ID rejected");
    return;
  }
  const userId = normalizeUser(req.headers["x-user-id"] || parsed.searchParams.get("user_id"));
  const requestId = identity.nextId();
  const requestStart = Date.now();
  const rangeHeader = req.headers.range || "";
  const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
  const start = match ? Number(match[1]) : 0;
  const end = match && match[2] ? Number(match[2]) : null;
  const handoffKey = `${parsed.pathname}|${start}-${end === null ? "*" : end}`;
  const targetUrl = ORIGIN + parsed.pathname;
  const objectKey = `${targetUrl}|${start}-${end === null ? "*" : end}`;
  const rangeKey = independent ? `${userId}|${objectKey}` : objectKey;
  if (live) live.note(userId, requestStart);
  const lookupKey = identity.key(targetUrl, start, end);
  stats.requests += 1;
  const headerObs = observationFromHeaders(req.headers, requestStart);
  if (headerObs.header_present) rememberObservation(userId, headerObs);
  decision({
    type: "request", request_id: requestId, user_id: userId, cache_key: lookupKey, range: rangeHeader || null, request_start_ms: requestStart,
    observation_header: headerObs.header_present ? "PRESENT" : "ABSENT",
    pose: headerObs.pose, quaternion: headerObs.quaternion, fov: headerObs.fov, viewport: headerObs.viewport,
    visible_splats: headerObs.visible_splats, queued_unsent: headerObs.queued_unsent, renderer_demand: headerObs.renderer_demand,
    uses_future_trace_frame: headerObs.uses_future_trace_frame,
  });
  if (spade5) spade5.begin({ time: requestStart, userId, requestId, rendererDemand: headerObs.renderer_demand || [] });
  const cached = cacheFor(userId).lookup(lookupKey, {
    userId, time: requestStart, etag: null, versionProven: identity.versionProven, residentHit: true, inflight: false,
  });
  if (cached) {
    stats.hits += 1;
    decision({ type: "cache_hit", request_id: requestId, cache_key: lookupKey, user_id: userId });
    logClient({
      request_id: requestId, proxy_request_id: requestId, user_id: userId, url: targetUrl,
      range_start: start, range_end: end, range_size: cached.length, cache_hit: true,
      bytes_from_origin: 0, bytes_to_client: cached.length, decision: "cache_hit",
      request_start_ms: requestStart,
    });
    send(res, 206, {
      "Content-Type": "application/octet-stream",
      "Content-Range": `bytes ${start}-${start + cached.length - 1}/*`,
      "X-P5-Origin-Url": targetUrl,
      "X-P5-Origin-Decision": "cache_hit",
      "X-P5-Run-Id": RUN_ID,
      "X-P5-Request-Id": requestId,
      "X-P5-Scheduler-Method": METHOD,
      "X-P5-Handoff-Key": handoffKey,
    }, cached);
    if (HANDOFF) noteHolder(handoffKey, userId);
    return;
  }
  if (inflight.has(rangeKey)) {
    stats.merges += 1;
    inflight.get(rangeKey).push({ res, userId, start, end, targetUrl, requestId, requestStart, handoffKey });
    decision({ type: "inflight_merge", request_id: requestId, cache_key: lookupKey, user_id: userId });
    return;
  }
  stats.misses += 1;
  inflight.set(rangeKey, [{ res, userId, start, end, targetUrl, requestId, requestStart, handoffKey }]);
  decision({ type: "cache_miss", request_id: requestId, cache_key: lookupKey, user_id: userId });
  try {
    const holder = HANDOFF ? newestOtherHolder(handoffKey, userId) : null;
    let originTtfbMs = null;
    const peer = holder ? await fetchPeerChecked(holder.ip, handoffKey, 19081, 1500) : null;
    const resolved = await resolveMiss({
      peer, store: digests, url: targetUrl, start, end,
      fetchOrigin: async () => {
        const origin = await fetchOrigin(targetUrl, rangeHeader || null, { cache_key: lookupKey, user_id: userId, request_id: requestId });
        originTtfbMs = origin.originTtfbMs;
        return origin;
      },
    });
    const result = {
      statusCode: resolved.statusCode,
      headers: resolved.headers || {},
      body: resolved.body,
      originTtfbMs,
      peer: resolved.source === "peer",
      peerMs: resolved.peerMs,
      peerIp: holder && resolved.source === "peer" ? holder.ip : "",
    };
    decision({
      type: "peer_verify", request_id: requestId, cache_key: handoffKey, user_id: userId,
      runtime_version: RUNTIME_VERSION, source: resolved.source, reason: resolved.reason,
      peer_reject: resolved.peer_reject || null, peer_wait_ms: resolved.peerMs,
      digest_sha256: resolved.sha256, digest_source: resolved.digest_source,
      metadata_bytes: resolved.metadata_bytes, cached: resolved.cached,
    });
    if (holder && !result.peer) {
      stats.handoffFail += 1;
      decision({ type: "peer_handoff_miss", request_id: requestId, cache_key: handoffKey, user_id: userId, peer_ip: holder.ip, reason: resolved.peer_reject || resolved.reason });
    }
    if (result.peer) stats.handoff += result.body.length;
    const version = identity.observe(result.headers.etag || null);
    if (live) live.observeVersion(result.headers.etag || null);
    const body = result.body;
    const storeKey = identity.key(targetUrl, start, end);
    if (live) live.note(userId, Date.now());
    activeUser = userId;
    const evicted = resolved.cached ? (cacheFor(userId).admit(storeKey, body.length, body, {
      requestId, userId, time: Date.now(), etag: result.headers.etag || null,
      versionProven: identity.versionProven, inflight: false, residentHit: false,
    }) || []) : [];
    for (const item of evicted) {
      stats.evictions += 1;
      decision({
        type: "cache_eviction", request_id: requestId, cache_key: item.key, bytes: item.nbytes, user_id: userId,
        reason: independent ? "IND_PER_USER_FIFO" : (item.reason || "LRU_HEAD"), lru_head: item.lru_head || item.key,
        protected_key: item.protected_key || "", follower: item.follower || null,
        ...signalFields(userId, item.key, Date.now()),
      });
    }
    decision({ type: "version_observation", request_id: requestId, etag: result.headers.etag || null, version_proven: version.version_proven, reason: version.reason });
    const waiters = inflight.get(rangeKey) || [];
    inflight.delete(rangeKey);
    waiters.forEach((waiter, index) => {
      const fromPeer = Boolean(result.peer);
      const originBytes = fromPeer ? 0 : (index === 0 ? body.length : 0);
      const decisionName = fromPeer ? (index === 0 ? "peer_handoff" : "peer_handoff_merge") : (index === 0 ? "origin_fetch" : "inflight_merge");
      const record = {
        request_id: waiter.requestId, proxy_request_id: waiter.requestId, origin_request_id: requestId,
        user_id: waiter.userId, url: waiter.targetUrl, range_start: waiter.start, range_end: waiter.end,
        range_size: body.length, cache_hit: false, bytes_from_origin: originBytes, bytes_to_client: body.length,
        decision: decisionName,
        request_start_ms: waiter.requestStart, etag: result.headers.etag || null, cache_key: storeKey,
        handoff_key: waiter.handoffKey, peer_ip: result.peerIp || "",
      };
      if (!fromPeer && index === 0) record.origin_ttfb_ms = result.originTtfbMs;
      logClient(record);
      if (HANDOFF) noteHolder(waiter.handoffKey, waiter.userId);
      send(waiter.res, result.statusCode, {
        ...result.headers,
        "Content-Type": result.headers["content-type"] || "application/octet-stream",
        "Content-Range": result.headers["content-range"] || `bytes ${waiter.start}-${waiter.start + body.length - 1}/*`,
        "X-P5-Origin-Url": waiter.targetUrl,
        "X-P5-Origin-Decision": decisionName,
        "X-P5-Handoff-Key": waiter.handoffKey,
        "X-P5-Run-Id": RUN_ID,
        "X-P5-Request-Id": waiter.requestId,
        "X-P5-Scheduler-Method": METHOD,
      }, body);
    });
  } catch (error) {
    const waiters = inflight.get(rangeKey) || [];
    inflight.delete(rangeKey);
    decision({ type: "origin_error", request_id: requestId, cache_key: lookupKey, message: error.message });
    for (const waiter of waiters) {
      if (!waiter.res.headersSent) send(waiter.res, 502, { "Content-Type": "text/plain", "X-P5-Request-Id": waiter.requestId }, Buffer.from(error.message));
    }
  }
});
server.startedAt = Date.now();
setInterval(() => {
  const mem = process.memoryUsage();
  write(resourceLog, { timestamp: Date.now(), rss_mb: mem.rss / (1024 * 1024), heap_mb: mem.heapUsed / (1024 * 1024), stats, spade5: spade5 ? spade5.telemetry() : null });
}, 1000).unref();
server.listen(PORT, "0.0.0.0");
