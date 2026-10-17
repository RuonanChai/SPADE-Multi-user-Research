/**
 * Viewport-oriented shared edge proxy：对可共享静态 3D/媒体资源做 in-flight 合并与短 TTL 内存缓存。
 *
 *   node scripts/proxy/viewport-shared-edge-proxy.mjs \
 *     --port=8092 \
 *     --origin=https://cdn.example.com \
 *     --log=results/run/proxy/shared-proxy.jsonl \
 *     --cacheTtlMs=30000 \
 *     --coalesceWindowMs=2000 \
 *     --maxCacheObjectBytes=104857600
 */
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { URL } from "node:url";
import { randomBytes } from "node:crypto";

/** 可合并 / 缓存的静态资源扩展名（小写，不含点） */
const SHAREABLE_EXT = new Set([
  "spz",
  "ply",
  "bin",
  "wasm",
  "glb",
  "gltf",
  "ktx2",
  "jpg",
  "jpeg",
  "png",
  "m4s",
  "mp4",
]);

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
]);

/** 规范化 query 时剥离的键（用户隔离 / cachebuster） */
const STRIP_QUERY_KEYS = new Set([
  "user_id",
  "trace_id",
  "run_id",
  "session_id",
  "client_id",
  "ts",
  "t",
  "cachebuster",
  "cb",
  "nonce",
  "_",
]);

const PRESERVE_RES_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "cache-control",
  "etag",
  "last-modified",
];

function parseArgs(argv) {
  const out = {
    listenPort: 8090,
    origin: "http://127.0.0.1:8080",
    logFile: path.join("proxy", "shared-proxy.jsonl"),
    cacheTtlMs: 30_000,
    coalesceWindowMs: 0,
    maxCacheObjectBytes: 104_857_600,
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    const k = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const v = eq === -1 ? "" : arg.slice(eq + 1);
    if (k === "port") out.listenPort = Number.parseInt(v || "8090", 10);
    else if (k === "origin") out.origin = v || out.origin;
    else if (k === "log") out.logFile = v || out.logFile;
    else if (k === "cacheTtlMs") out.cacheTtlMs = Math.max(0, Number.parseInt(v || "30000", 10));
    else if (k === "coalesceWindowMs") out.coalesceWindowMs = Math.max(0, Number.parseInt(v || "0", 10));
    else if (k === "maxCacheObjectBytes") out.maxCacheObjectBytes = Math.max(0, Number.parseInt(v || "104857600", 10));
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function appendJsonl(file, entry) {
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
}

function getHeader(h, name) {
  if (!h) return null;
  const n = name.toLowerCase();
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === n) {
      const v = h[k];
      if (Array.isArray(v)) return v.length ? v.join(", ") : null;
      return v != null ? String(v) : null;
    }
  }
  return null;
}

function stripHopFromHeaders(headers) {
  const out = { ...headers };
  for (const key of Object.keys(out)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) delete out[key];
  }
  return out;
}

function headersForUpstream(clientHeaders, hostHeader) {
  const out = {};
  for (const [k, v] of Object.entries(clientHeaders)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (k.toLowerCase() === "host") continue;
    out[k] = v;
  }
  out.host = hostHeader;
  return out;
}

function pickPreservedResponseHeaders(upstreamHeaders, bodyLength) {
  const out = {};
  for (const name of PRESERVE_RES_HEADERS) {
    if (name === "content-length") {
      out["content-length"] = String(bodyLength);
      continue;
    }
    const v = getHeader(upstreamHeaders, name);
    if (v != null && v !== "") out[name.toLowerCase()] = v;
  }
  return out;
}

function extFromPathname(pathname) {
  const seg = String(pathname || "").split("/").pop() || "";
  const dot = seg.lastIndexOf(".");
  return dot >= 0 ? seg.slice(dot + 1).split("?")[0].toLowerCase() : "";
}

function normalizeSearch(search) {
  const raw = String(search || "");
  const qs = raw.startsWith("?") ? raw.slice(1) : raw;
  const params = new URLSearchParams(qs);
  const pairs = [];
  for (const [k, v] of params.entries()) {
    if (STRIP_QUERY_KEYS.has(k.toLowerCase())) continue;
    pairs.push([k, v]);
  }
  pairs.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const next = new URLSearchParams();
  for (const [k, v] of pairs) next.append(k, v);
  return next.toString();
}

function buildNormalizedUrl(pathname, normalizedSearch) {
  const p = pathname || "/";
  if (!normalizedSearch) return p;
  return `${p}?${normalizedSearch}`;
}

function buildLogicalObjectKey(pathname, normalizedSearch) {
  return buildNormalizedUrl(pathname, normalizedSearch);
}

function buildShareKey(method, pathname, normalizedSearch, rangeHeader) {
  const rng = rangeHeader ? String(rangeHeader).trim() : "(none)";
  const qs = normalizedSearch || "";
  return `${method.toUpperCase()}|${pathname}|${qs}|${rng}`;
}

function isShareableRequest(method, pathname) {
  if (String(method || "").toUpperCase() !== "GET") return false;
  const ext = extFromPathname(pathname);
  if (!SHAREABLE_EXT.has(ext)) return false;
  const lower = String(pathname || "").toLowerCase();
  if (lower.includes("/scripts/traces/")) return false;
  return true;
}

function newFetchId(prefix) {
  return `${prefix}-${Date.now()}-${randomBytes(6).toString("hex")}`;
}

function fetchUpstreamBuffered(agent, upstreamUrlStr, opts, onResponseFirstByte) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const upstreamReq = agent.request(
      upstreamUrlStr,
      opts,
      (upstreamRes) => {
        let first = true;
        upstreamRes.on("data", (c) => {
          if (first) {
            first = false;
            if (typeof onResponseFirstByte === "function") onResponseFirstByte();
          }
          chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        });
        upstreamRes.on("end", () => {
          resolve({
            statusCode: upstreamRes.statusCode || 502,
            headers: upstreamRes.headers || {},
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    upstreamReq.on("error", reject);
    upstreamReq.end();
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const origin = new URL(args.origin);
  const logResolved = path.isAbsolute(args.logFile) ? args.logFile : path.resolve(process.cwd(), args.logFile);
  await fs.mkdir(path.dirname(logResolved), { recursive: true });
  try {
    await fs.access(logResolved);
  } catch {
    await fs.writeFile(logResolved, "", "utf8");
  }

  const agent = origin.protocol === "https:" ? https : http;

  /** @type {Map<string, any>} */
  const memoryCache = new Map();

  /** @type {Map<string, {
   *   subscriberSeq: number,
   *   waiterCount: number,
   *   userIds: string[],
   *   fetchId: string,
   *   promise: Promise<any>,
   * }>} */
  const inflight = new Map();

  async function log(entry) {
    await appendJsonl(logResolved, entry);
  }

  function cacheGet(shareKey) {
    const ent = memoryCache.get(shareKey);
    if (!ent) return null;
    if (Date.now() - ent.storedAt > args.cacheTtlMs) {
      memoryCache.delete(shareKey);
      return null;
    }
    return ent;
  }

  function cacheSet(shareKey, entry) {
    if (entry.body.length > args.maxCacheObjectBytes) return;
    memoryCache.set(shareKey, { ...entry, storedAt: Date.now() });
  }

  /**
   * @returns {{ subscriberSeq: number, promise: Promise<any> }}
   */
  function subscribeShareFlight(shareKey, upstreamUrlStr, upstreamHeaders, userId) {
    let slot = inflight.get(shareKey);
    if (!slot) {
      const fetchId = newFetchId("uf");
      slot = {
        subscriberSeq: 0,
        waiterCount: 0,
        userIds: [],
        fetchId,
        promise: null,
      };
      slot.promise = (async () => {
        let upstream_start_ts = null;
        let upstream_first_body_ts = null;
        let upstream_end_ts = null;
        try {
          if (args.coalesceWindowMs > 0) await sleep(args.coalesceWindowMs);
          upstream_start_ts = Date.now();
          const res = await fetchUpstreamBuffered(agent, upstreamUrlStr, {
            method: "GET",
            headers: upstreamHeaders,
          }, () => {
            if (upstream_first_body_ts == null) upstream_first_body_ts = Date.now();
          });
          upstream_end_ts = Date.now();
          cacheSet(shareKey, {
            statusCode: res.statusCode,
            headers: res.headers,
            body: res.body,
            upstream_fetch_id: slot.fetchId,
            upstream_start_ts,
            upstream_first_body_ts,
            upstream_end_ts,
          });
          const wc = slot.waiterCount;
          const userIds = [...new Set(slot.userIds)].sort();
          await log({
            event: "upstream_share_fetch_complete",
            share_key: shareKey,
            upstream_fetch_id: slot.fetchId,
            upstream_bytes: res.body.length,
            waiter_count: wc,
            coalesced_user_ids: userIds,
            status_code: res.statusCode,
            coalesced: wc > 1,
            upstream_start_ts,
            upstream_end_ts,
          });
          return {
            statusCode: res.statusCode,
            headers: res.headers,
            body: res.body,
            _flight: {
              upstream_fetch_id: slot.fetchId,
              upstream_start_ts,
              upstream_first_body_ts: upstream_first_body_ts ?? upstream_end_ts,
              upstream_end_ts,
              coalesced_waiter_count: wc,
              coalesced_user_ids: userIds,
              upstream_body_bytes: res.body.length,
            },
          };
        } finally {
          inflight.delete(shareKey);
        }
      })();
      inflight.set(shareKey, slot);
    }
    slot.waiterCount += 1;
    slot.subscriberSeq += 1;
    slot.userIds.push(String(userId));
    const subscriberSeq = slot.subscriberSeq;
    return { subscriberSeq, promise: slot.promise };
  }

  const server = http.createServer((req, res) => {
    const request_start_ts = Date.now();
    const requestId = `${request_start_ts}-${randomBytes(4).toString("hex")}`;
    const user_id = String(req.headers["x-user-id"] || req.headers["x-client-id"] || "unknown");
    const trace_id = String(req.headers["x-trace-id"] || "unknown");
    const run_id = String(req.headers["x-run-id"] || "unknown");
    const method = req.method || "GET";
    const rawUrl = req.url || "/";

    let u;
    try {
      u = new URL(rawUrl, origin);
    } catch {
      res.writeHead(400).end("Bad URL");
      return;
    }
    const pathname = u.pathname || "/";
    const normSearch = normalizeSearch(u.search || "");
    const normalized_url = buildNormalizedUrl(pathname, normSearch);
    const logical_object_key = buildLogicalObjectKey(pathname, normSearch);
    const rangeHdr = getHeader(req.headers, "range");
    const shareKey = buildShareKey(method, pathname, normSearch, rangeHdr);
    const shareable = isShareableRequest(method, pathname);

    const bodyChunks = [];
    req.on("data", (c) => bodyChunks.push(c));
    req.on("error", () => {});
    req.on("end", async () => {
      const upstreamUrl = new URL(rawUrl, origin);
      upstreamUrl.protocol = origin.protocol;
      upstreamUrl.host = origin.host;
      const hostHeader = origin.host;
      const upstreamOptsBase = {
        method,
        headers: headersForUpstream(req.headers, hostHeader),
      };

      /** @param {Partial<any>} extra */
      async function writeRequestComplete(extra) {
        const ts_ms = Date.now();
        const row = {
          event: "request_complete",
          ts_ms,
          run_id,
          user_id,
          trace_id,
          method,
          url: rawUrl,
          normalized_url,
          share_key: shareKey,
          is_shareable: shareable,
          served_from: extra.served_from,
          status: extra.status ?? 502,
          content_type: extra.content_type ?? "",
          range: extra.range ?? (rangeHdr || ""),
          content_length: extra.content_length ?? 0,
          downstream_bytes: extra.downstream_bytes ?? 0,
          upstream_bytes_charged: extra.upstream_bytes_charged ?? 0,
          upstream_fetch_id: extra.upstream_fetch_id ?? "",
          coalesced_waiter_count: extra.coalesced_waiter_count ?? 1,
          coalesced_user_ids: Array.isArray(extra.coalesced_user_ids) ? extra.coalesced_user_ids : [user_id],
          request_start_ts,
          upstream_start_ts: extra.upstream_start_ts ?? null,
          upstream_end_ts: extra.upstream_end_ts ?? null,
          response_end_ts: extra.response_end_ts ?? ts_ms,
          wait_ms: extra.wait_ms ?? 0,
          ttfb_ms: extra.ttfb_ms ?? 0,
          total_ms: Math.max(0, (extra.response_end_ts ?? ts_ms) - request_start_ts),
          x_shared_cache: extra.x_shared_cache ?? "BYPASS",
        };
        await log(row);
      }

      try {
        if (!shareable) {
          const passFetchId = newFetchId("pass");
          let upstream_start_ts = null;
          let upstream_end_ts = null;
          let response_first_ts = null;
          let downstream_bytes = 0;
          let upstream_bytes = 0;
          let status = 502;
          let ctype = "";

          try {
            await new Promise((resolve, reject) => {
              upstream_start_ts = Date.now();
              const upstreamReq = agent.request(upstreamUrl.toString(), upstreamOptsBase, (upstreamRes) => {
                status = upstreamRes.statusCode || 502;
                ctype = getHeader(upstreamRes.headers, "content-type") || "";
                const headers = stripHopFromHeaders(upstreamRes.headers || {});
                const writeHeadTs = Date.now();
                if (response_first_ts == null) response_first_ts = writeHeadTs;
                res.writeHead(status, headers);

                upstreamRes.on("data", (chunk) => {
                  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                  upstream_bytes += buf.length;
                  downstream_bytes += buf.length;
                  res.write(buf);
                });
                upstreamRes.on("end", async () => {
                  try {
                    upstream_end_ts = Date.now();
                    res.end();
                    const response_end_ts = Date.now();
                    await writeRequestComplete({
                      served_from: "passthrough",
                      status,
                      content_type: ctype,
                      range: rangeHdr || "",
                      content_length: downstream_bytes,
                      downstream_bytes,
                      upstream_bytes_charged: upstream_bytes,
                      upstream_fetch_id: passFetchId,
                      coalesced_waiter_count: 1,
                      coalesced_user_ids: [user_id],
                      upstream_start_ts,
                      upstream_end_ts,
                      response_end_ts,
                      wait_ms: Math.max(0, (response_first_ts ?? response_end_ts) - request_start_ts),
                      ttfb_ms: Math.max(0, (response_first_ts ?? response_end_ts) - request_start_ts),
                      x_shared_cache: "BYPASS",
                    });
                    resolve();
                  } catch (e) {
                    reject(e);
                  }
                });
                upstreamRes.on("error", reject);
              });
              upstreamReq.on("error", reject);
              for (const ch of bodyChunks) upstreamReq.write(ch);
              upstreamReq.end();
            });
          } catch {
            if (!res.headersSent) {
              res.writeHead(502, { "content-type": "text/plain" });
              res.end("Bad gateway");
            }
            const response_end_ts = Date.now();
            await writeRequestComplete({
              served_from: "passthrough",
              status: 502,
              content_type: "text/plain",
              range: rangeHdr || "",
              content_length: 0,
              downstream_bytes: 0,
              upstream_bytes_charged: 0,
              upstream_fetch_id: passFetchId,
              coalesced_waiter_count: 1,
              coalesced_user_ids: [user_id],
              upstream_start_ts,
              upstream_end_ts,
              response_end_ts,
              wait_ms: Math.max(0, response_end_ts - request_start_ts),
              ttfb_ms: 0,
              x_shared_cache: "BYPASS",
            });
          }
          return;
        }

        await log({
          event: "shareable_client_request",
          request_id: requestId,
          client_id: user_id,
          trace_id,
          share_key: shareKey,
          raw_url: rawUrl,
          raw_range: rangeHdr || null,
          logical_object_key,
          asset_ext: extFromPathname(pathname),
          ts_ms: Date.now(),
        });

        const cached = cacheGet(shareKey);
        if (cached) {
          const downstream_bytes = cached.body.length;
          const hdr = pickPreservedResponseHeaders(cached.headers, downstream_bytes);
          hdr["x-shared-cache"] = "HIT";
          const wait_ts = Date.now();
          res.writeHead(cached.statusCode, hdr);
          res.end(cached.body);
          const response_end_ts = Date.now();
          await writeRequestComplete({
            served_from: "memory_cache",
            status: cached.statusCode,
            content_type: getHeader(cached.headers, "content-type") || "",
            range: rangeHdr || "",
            content_length: downstream_bytes,
            downstream_bytes,
            upstream_bytes_charged: 0,
            upstream_fetch_id: cached.upstream_fetch_id || "",
            coalesced_waiter_count: 1,
            coalesced_user_ids: [user_id],
            upstream_start_ts: cached.upstream_start_ts ?? null,
            upstream_end_ts: cached.upstream_end_ts ?? null,
            response_end_ts,
            wait_ms: Math.max(0, wait_ts - request_start_ts),
            ttfb_ms: Math.max(0, wait_ts - request_start_ts),
            x_shared_cache: "HIT",
          });
          return;
        }

        const upstreamHdr = headersForUpstream(req.headers, hostHeader);
        const { subscriberSeq, promise } = subscribeShareFlight(shareKey, upstreamUrl.toString(), upstreamHdr, user_id);

        const result = await promise;
        const flight = result._flight;

        const wait_ts = Date.now();
        const x_shared_cache = subscriberSeq === 1 ? "MISS" : "COALESCED";
        const served_from = subscriberSeq === 1 ? "origin" : "inflight_join";
        const upstream_bytes_charged = subscriberSeq === 1 ? flight.upstream_body_bytes : 0;

        const hdrOut = pickPreservedResponseHeaders(result.headers, result.body.length);
        hdrOut["x-shared-cache"] = x_shared_cache;
        res.writeHead(result.statusCode, hdrOut);
        res.end(result.body);

        const response_end_ts = Date.now();
        const downstream_bytes = result.body.length;

        const ttfb_ms =
          subscriberSeq === 1
            ? Math.max(0, (flight.upstream_first_body_ts ?? flight.upstream_end_ts) - request_start_ts)
            : Math.max(0, wait_ts - request_start_ts);

        await writeRequestComplete({
          served_from,
          status: result.statusCode,
          content_type: getHeader(result.headers, "content-type") || "",
          range: rangeHdr || "",
          content_length: downstream_bytes,
          downstream_bytes,
          upstream_bytes_charged,
          upstream_fetch_id: flight.upstream_fetch_id,
          coalesced_waiter_count: flight.coalesced_waiter_count,
          coalesced_user_ids: flight.coalesced_user_ids,
          upstream_start_ts: flight.upstream_start_ts,
          upstream_end_ts: flight.upstream_end_ts,
          response_end_ts,
          wait_ms: Math.max(0, wait_ts - request_start_ts),
          ttfb_ms,
          x_shared_cache,
        });
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end("Bad gateway");
        }
        const response_end_ts = Date.now();
        await appendJsonl(logResolved, {
          event: "share_error",
          request_id: requestId,
          user_id,
          share_key: shareKey,
          error: String(e?.message || e),
        });
        await writeRequestComplete({
          served_from: shareable ? "origin" : "passthrough",
          status: 502,
          content_type: "text/plain",
          range: rangeHdr || "",
          content_length: 0,
          downstream_bytes: 0,
          upstream_bytes_charged: 0,
          upstream_fetch_id: "",
          coalesced_waiter_count: 1,
          coalesced_user_ids: [user_id],
          upstream_start_ts: null,
          upstream_end_ts: null,
          response_end_ts,
          wait_ms: Math.max(0, response_end_ts - request_start_ts),
          ttfb_ms: 0,
          x_shared_cache: shareable ? "MISS" : "BYPASS",
        });
      }
    });
  });

  server.on("error", (err) => {
    console.error(`[viewport-shared-edge-proxy] listen failed on :${args.listenPort}`, err?.message || err);
    process.exitCode = 1;
    process.exit(1);
  });

  server.listen(args.listenPort, "0.0.0.0", () => {
    console.log(
      `[viewport-shared-edge-proxy] 0.0.0.0:${args.listenPort} -> ${origin.origin} log=${logResolved} cacheTtlMs=${args.cacheTtlMs} coalesceWindowMs=${args.coalesceWindowMs} maxCache=${args.maxCacheObjectBytes}`,
    );
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
