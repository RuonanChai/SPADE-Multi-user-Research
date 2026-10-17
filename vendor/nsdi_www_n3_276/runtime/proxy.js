"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const { createCache } = require("./matched_cache");

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const METHOD = flag("--method", "LRU");
const PORT = Number(flag("--port", "18081"));
const ORIGIN = flag("--origin-url", "");
const RUN_ID = flag("--run-id", "");
const EVIDENCE = flag("--evidence-dir", "");
const CACHE_MAX_ENTRIES = Number(flag("--cache-max-entries", "100"));
const CACHE_MAX_BYTES = Math.round(Number(flag("--cache-max-mb", "50")) * 1024 * 1024);
const DLS_K = Number(flag("--dls-k", "0"));
if (!["LRU", "SIEVE", "S3-FIFO"].includes(METHOD) || !ORIGIN || !RUN_ID || !EVIDENCE) {
  throw new Error("PROXY_ARGS");
}
if (CACHE_MAX_BYTES !== 52428800 || CACHE_MAX_ENTRIES !== 100 || DLS_K !== 0) {
  throw new Error(`PROXY_CONTRACT ${CACHE_MAX_BYTES} ${CACHE_MAX_ENTRIES} ${DLS_K}`);
}
fs.mkdirSync(EVIDENCE, { recursive: true });
const requestLog = fs.createWriteStream(`${EVIDENCE}/proxy.jsonl`, { flags: "a" });
const decisionLog = fs.createWriteStream(`${EVIDENCE}/proxy_decisions.jsonl`, { flags: "a" });
const resourceLog = fs.createWriteStream(`${EVIDENCE}/proxy_resource.jsonl`, { flags: "a" });
const cache = createCache(METHOD, CACHE_MAX_BYTES, CACHE_MAX_ENTRIES);
const inflight = new Map();
let sequence = 0;
const stats = { requests: 0, hits: 0, misses: 0, merges: 0, origin: 0, evictions: 0 };

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

function fetchOrigin(targetUrl, rangeHeader) {
  const started = Date.now();
  decision({ type: "origin_fetch", url: targetUrl, range: rangeHeader || null, origin_start_ms: started });
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
          origin_first_byte_ms: first,
          origin_end_ms: ended,
        });
        resolve({ statusCode: res.statusCode, headers: res.headers, body });
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
  write(requestLog, { timestamp: Date.now(), proxy_request_id: `w08_${++sequence}`, method: METHOD, ...row });
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
  const parsed = new URL(req.url, "http://127.0.0.1");
  const runId = req.headers["x-run-id"] || parsed.searchParams.get("run_id");
  if (runId !== RUN_ID) {
    res.writeHead(409, { "Access-Control-Allow-Origin": "*", "X-P5-Reject-Reason": "STALE_RUN_ID" });
    res.end("Stale run ID rejected");
    return;
  }
  const userId = normalizeUser(req.headers["x-user-id"] || parsed.searchParams.get("user_id"));
  const rangeHeader = req.headers.range || "";
  const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
  const start = match ? Number(match[1]) : 0;
  const end = match && match[2] ? Number(match[2]) : null;
  const targetUrl = ORIGIN + parsed.pathname;
  const cacheKey = `${targetUrl}:${start}-${end === null ? "*" : end}`;
  stats.requests += 1;
  const cached = cache.lookup(cacheKey);
  if (cached) {
    stats.hits += 1;
    decision({ type: "cache_hit", cache_key: cacheKey, user_id: userId });
    logClient({
      user_id: userId, url: targetUrl, range_start: start, range_end: end, range_size: cached.length,
      cache_hit: true, bytes_from_origin: 0, bytes_to_client: cached.length, decision: "cache_hit",
    });
    send(res, 206, { "Content-Type": "application/octet-stream", "Content-Range": `bytes ${start}-${start + cached.length - 1}/*` }, cached);
    return;
  }
  if (inflight.has(cacheKey)) {
    stats.merges += 1;
    inflight.get(cacheKey).push({ res, userId, start, end, targetUrl });
    decision({ type: "inflight_merge", cache_key: cacheKey, user_id: userId });
    return;
  }
  stats.misses += 1;
  inflight.set(cacheKey, [{ res, userId, start, end, targetUrl }]);
  decision({ type: "cache_miss", cache_key: cacheKey, user_id: userId });
  try {
    const result = await fetchOrigin(targetUrl, rangeHeader || null);
    const body = result.body;
    const evicted = cache.admit(cacheKey, body.length, body);
    for (const item of evicted) {
      stats.evictions += 1;
      decision({ type: "cache_eviction", cache_key: item.key, bytes: item.nbytes });
    }
    const waiters = inflight.get(cacheKey) || [];
    inflight.delete(cacheKey);
    waiters.forEach((waiter, index) => {
      const originBytes = index === 0 ? body.length : 0;
      logClient({
        user_id: waiter.userId, url: waiter.targetUrl, range_start: waiter.start, range_end: waiter.end,
        range_size: body.length, cache_hit: false, bytes_from_origin: originBytes, bytes_to_client: body.length,
        decision: index === 0 ? "origin_fetch" : "inflight_merge",
      });
      send(waiter.res, result.statusCode, result.headers, body);
    });
  } catch (error) {
    const waiters = inflight.get(cacheKey) || [];
    inflight.delete(cacheKey);
    decision({ type: "origin_error", cache_key: cacheKey, message: error.message });
    for (const waiter of waiters) {
      if (!waiter.res.headersSent) send(waiter.res, 502, { "Content-Type": "text/plain" }, Buffer.from(error.message));
    }
  }
});
server.startedAt = Date.now();
setInterval(() => {
  const mem = process.memoryUsage();
  write(resourceLog, { timestamp: Date.now(), rss_mb: mem.rss / (1024 * 1024), heap_mb: mem.heapUsed / (1024 * 1024), stats });
}, 1000).unref();
server.listen(PORT, "0.0.0.0");
