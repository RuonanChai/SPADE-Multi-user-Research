/**
 * Phase 3: Align CDN / instrumented-proxy server logs with CDP network audit rows.
 */
import fs from "node:fs";
import { isChunkAssetUrl, writeAuditCsv } from "./audit_io.mjs";

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function urlPath(u) {
  try {
    return new URL(String(u)).pathname;
  } catch {
    return String(u).split("?")[0];
  }
}

/**
 * @param {string} logPath proxy jsonl (instrumented-reverse-proxy)
 * @param {object[]} cdpRows from CdpNetworkAuditor
 * @param {{ sessionId: string, trialStartMs?: number, trialEndMs?: number }} opts
 */
export function alignCdnServerLogs(logPath, cdpRows, opts = {}) {
  if (!logPath || !fs.existsSync(logPath)) {
    return { rows: [], aligned_count: 0, log_path: logPath || "", skipped: "log_missing" };
  }
  const events = readJsonl(logPath).filter((e) =>
    e.event === "request_complete" || e.event === "downstream_request_received",
  );
  const completes = events.filter((e) => e.event === "request_complete");
  const out = [];
  for (const cdp of cdpRows) {
    if (!isChunkAssetUrl(cdp.url)) continue;
    const path = urlPath(cdp.url);
    const range = String(cdp.range_header ?? "").trim();
    let match = completes.find((s) => {
      const sp = urlPath(s.url || s.pathname || "");
      if (sp !== path && !String(s.url || "").includes(path.split("/").pop() || "@@")) return false;
      const sr = String(s.raw_range ?? "").trim();
      if (range && sr && range !== sr) return false;
      if (opts.trialStartMs && s.recv_ts && s.recv_ts < opts.trialStartMs - 5000) return false;
      if (opts.trialEndMs && s.recv_ts && s.recv_ts > opts.trialEndMs + 5000) return false;
      return true;
    });
    if (!match && path) {
      match = completes.find((s) => String(s.url || "").includes(path.split("/").pop() || "@@"));
    }
    const cacheHdr = match?.cache_headers ?? {};
    out.push({
      user: cdp.user,
      session_id: opts.sessionId ?? cdp.session_id,
      cdp_requestId: cdp.requestId,
      url: cdp.url,
      range_header: range,
      content_range: match?.cache_headers?.["content-range"] ?? "",
      status: match?.status_code ?? match?.status ?? "",
      cache_status: cacheHdr["cf-cache-status"] ?? cacheHdr["x-cache"] ?? "",
      upstream_response_time: match?.ttfb_ms ?? "",
      request_time: match?.service_ms ?? "",
      bytes_sent: match?.upstream_bytes ?? match?.downstream_bytes ?? "",
      aligned: !!match,
      proxy_request_id: match?.request_id ?? "",
      upstream_target: match?.upstream_target ?? "",
    });
  }
  return {
    rows: out,
    aligned_count: out.filter((r) => r.aligned).length,
    log_path: logPath,
    server_event_count: completes.length,
  };
}

export function writeCdnServerAlignCsv(rows, file) {
  writeAuditCsv(rows, file);
}
