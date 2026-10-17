import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { URL } from "node:url";

const PAGE_SIZE = 256 * 1024;

function parseArgs(argv) {
  const out = {
    listenPort: 8090,
    origin: "http://127.0.0.1:8080",
    logFile: "proxy/proxy-logs.jsonl",
    /** 可选：与主站相同路径的 splat 等静态资源在 R2 上时的公网基址（如 https://xxx.r2.dev） */
    r2Origin: "",
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "port") out.listenPort = Number.parseInt(v || "8090", 10);
    else if (k === "origin") out.origin = v || out.origin;
    else if (k === "log") out.logFile = v || out.logFile;
    else if (k === "r2Origin") out.r2Origin = v || "";
  }
  return out;
}

function normalizeLogicalPages(url, rawRange) {
  if (!rawRange) return [];
  const match = /^bytes=(\d+)-(\d+)?$/i.exec(String(rawRange).trim());
  if (!match) return [];
  const start = Number.parseInt(match[1], 10);
  const end = match[2] ? Number.parseInt(match[2], 10) : start;
  const startPage = Math.floor(start / PAGE_SIZE);
  const endPage = Math.floor(end / PAGE_SIZE);
  const pages = [];
  for (let i = startPage; i <= endPage; i += 1) {
    pages.push(`${url}#${i}`);
  }
  return pages;
}

async function appendJsonl(file, entry) {
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
}

/** 本进程无 HTTP 缓存；透传模式 cache_hit 恒为 false。若未来加内存缓存，在此设 true。 */
function cacheHitForRequest() {
  return false;
}

function pathnameOnly(reqUrl) {
  try {
    return new URL(String(reqUrl || "/"), "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

/** 自 run_id（如 rep-B-lockstep-123）解析场景，unknown 时返回 null。 */
function scenarioFromRunId(runId) {
  const s = String(runId || "");
  if (!s || s === "unknown") return null;
  const m = /rep-(B-lockstep|C-nearcohort|D-divergent)-/.exec(s);
  return m ? m[1] : null;
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

function pickCacheAndMetaHeaders(resHeaders) {
  const out = { cache: {}, content_length: null, content_type: null };
  if (!resHeaders) return out;
  out.content_length = getHeader(resHeaders, "content-length");
  out.content_type = getHeader(resHeaders, "content-type");
  for (const key of ["cf-cache-status", "x-cache", "age", "etag", "last-modified", "x-served-by"]) {
    const v = getHeader(resHeaders, key);
    if (v) out.cache[key] = v;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const origin = new URL(args.origin);
  const r2Base = String(args.r2Origin || "").trim() ? new URL(String(args.r2Origin).trim()) : null;
  await fs.mkdir(path.dirname(args.logFile), { recursive: true });
  try {
    await fs.access(args.logFile);
  } catch {
    await fs.writeFile(args.logFile, "", "utf8");
  }
  const mainAgent = origin.protocol === "https:" ? https : http;

  const server = http.createServer(async (req, res) => {
    const downstreamReceivedTs = Date.now();
    const requestId = `${downstreamReceivedTs}-${Math.random().toString(36).slice(2, 10)}`;
    const clientId = req.headers["x-user-id"] || req.headers["x-client-id"] || "unknown";
    const runId = req.headers["x-run-id"] || "unknown";
    const traceId = req.headers["x-trace-id"] || "unknown";
    const rawRange = req.headers.range || null;
    const logicalPages = normalizeLogicalPages(req.url || "", rawRange);
    const p = pathnameOnly(req.url);
    const useR2 = Boolean(r2Base && p.startsWith("/assets/splats/"));
    const upstreamBase = useR2 ? r2Base : origin;
    const activeAgent = useR2 ? (r2Base.protocol === "https:" ? https : http) : mainAgent;
    const upstreamUrl = new URL(req.url || "/", upstreamBase);
    const upstreamHeaders = { ...req.headers, host: upstreamBase.host };
    const bodyChunks = [];

    await appendJsonl(args.logFile, {
      event: "downstream_request_received",
      request_id: requestId,
      client_id: String(clientId),
      run_id: String(runId),
      trace_id: String(traceId),
      url: req.url || "",
      method: req.method || "GET",
      raw_range: rawRange,
      normalized_logical_pages: logicalPages,
      recv_ts: downstreamReceivedTs,
      upstream_target: useR2 ? "r2" : "main",
    });

    req.on("data", (chunk) => bodyChunks.push(chunk));
    req.on("error", async (error) => {
      await appendJsonl(args.logFile, {
        event: "error",
        request_id: requestId,
        client_id: clientId,
        url: req.url,
        recv_ts: downstreamReceivedTs,
        status: 499,
        error: error.message,
      });
    });

    req.on("end", () => {
      const upstreamFetchStartedTs = Date.now();
      const upstreamReq = activeAgent.request(
        upstreamUrl,
        {
          method: req.method,
          headers: upstreamHeaders,
        },
        (upstreamRes) => {
          let upstreamFirstByteTs = null;
          let upstreamBytes = 0;
          let downstreamBytes = 0;
          const status = upstreamRes.statusCode || 502;
          const resHeaders = upstreamRes.headers || {};
          /** 便于 curl/预检区分本代理与误占用 8092 的其它 HTTP 服务（如 Python SimpleHTTPServer） */
          const resHeadersOut = { ...resHeaders, "x-spark-proxy": "instrumented-reverse" };
          res.writeHead(status, resHeadersOut);
          upstreamRes.on("data", (chunk) => {
            if (upstreamFirstByteTs == null) upstreamFirstByteTs = Date.now();
            upstreamBytes += chunk.length;
            downstreamBytes += chunk.length;
            res.write(chunk);
          });
          upstreamRes.on("end", async () => {
            const upstreamFinishedTs = Date.now();
            res.end();
            const downstreamFinishedTs = Date.now();
            const tfb = upstreamFirstByteTs ?? upstreamFinishedTs;
            const t_request_start_ms = upstreamFetchStartedTs;
            const t_first_byte_ms = tfb;
            const t_last_byte_ms = upstreamFinishedTs;
            const ttfb_ms = Math.max(0, t_first_byte_ms - t_request_start_ms);
            const body_transfer_ms = Math.max(0, t_last_byte_ms - t_first_byte_ms);
            const service_ms = Math.max(0, t_last_byte_ms - t_request_start_ms);
            const effective_mbps =
              body_transfer_ms > 0 ? (upstreamBytes * 8) / body_transfer_ms / 1000 : null;
            const meta = pickCacheAndMetaHeaders(resHeaders);
            const httpVersion =
              upstreamRes.httpVersion ||
              (upstreamRes.httpVersionMajor != null
                ? `${upstreamRes.httpVersionMajor}.${upstreamRes.httpVersionMinor || 0}`
                : null);
            let connection_reused = null;
            try {
              if (typeof upstreamReq.reusedSocket === "boolean") connection_reused = upstreamReq.reusedSocket;
            } catch {
              /* */
            }
            const pathName = pathnameOnly(req.url);
            const scen = scenarioFromRunId(runId);
            await appendJsonl(args.logFile, {
              event: "request_complete",
              request_id: requestId,
              client_id: String(clientId),
              run_id: String(runId),
              trace_id: String(traceId),
              scenario: scen,
              pathname: pathName,
              object_id: pathName,
              url: req.url || "",
              raw_range: rawRange,
              normalized_logical_pages: logicalPages,
              upstream_target: useR2 ? "r2" : "main",
              cache_hit: cacheHitForRequest(),
              phase_timestamps: {
                downstream_received: downstreamReceivedTs,
                upstream_fetch_started: upstreamFetchStartedTs,
                upstream_first_byte: upstreamFirstByteTs ?? upstreamFinishedTs,
                upstream_finished: upstreamFinishedTs,
                downstream_finished: downstreamFinishedTs,
              },
              recv_ts: downstreamReceivedTs,
              upstream_start_ts: upstreamFetchStartedTs,
              upstream_first_byte_ts: upstreamFirstByteTs ?? upstreamFinishedTs,
              upstream_end_ts: upstreamFinishedTs,
              downstream_end_ts: downstreamFinishedTs,
              t_request_start_ms,
              t_first_byte_ms,
              t_last_byte_ms,
              ttfb_ms,
              body_transfer_ms,
              service_ms,
              effective_mbps,
              protocol_version: httpVersion,
              connection_reused,
              cache_headers: meta.cache,
              content_length_header: meta.content_length,
              content_type_header: meta.content_type,
              status_code: status,
              status,
              upstream_bytes: upstreamBytes,
              downstream_bytes: downstreamBytes,
            });
          });
        },
      );

      upstreamReq.on("error", async (error) => {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "x-spark-proxy": "instrumented-reverse" });
        res.end("Bad gateway");
        await appendJsonl(args.logFile, {
          event: "request_complete",
          request_id: requestId,
          client_id: String(clientId),
          run_id: String(runId),
          trace_id: String(traceId),
          url: req.url || "",
          raw_range: rawRange,
          normalized_logical_pages: logicalPages,
          upstream_target: useR2 ? "r2" : "main",
          cache_hit: false,
          phase_timestamps: {
            downstream_received: downstreamReceivedTs,
            upstream_fetch_started: upstreamFetchStartedTs,
            upstream_failed: Date.now(),
          },
          recv_ts: downstreamReceivedTs,
          upstream_start_ts: upstreamFetchStartedTs,
          status: 502,
          error: error.message,
          upstream_bytes: 0,
          downstream_bytes: 0,
        });
      });

      for (const chunk of bodyChunks) {
        upstreamReq.write(chunk);
      }
      upstreamReq.end();
    });
  });

  server.on("error", (err) => {
    console.error(`[instrumented-reverse-proxy] listen failed on :${args.listenPort}`, err?.message || err);
    process.exitCode = 1;
    process.exit(1);
  });

  /** 显式绑定 IPv4，便于局域网 worker 连接 client_server_url 所在主机端口 */
  server.listen(args.listenPort, "0.0.0.0", () => {
    const extra = r2Base ? ` (+R2 ${r2Base.origin} for /assets/splats/*)` : "";
    console.log(`Instrumented proxy listening on 0.0.0.0:${args.listenPort} -> ${args.origin}${extra}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
