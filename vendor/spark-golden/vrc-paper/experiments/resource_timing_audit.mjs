/**
 * Phase 2: Collect and summarize PerformanceResourceTiming from the page.
 */
import { isChunkAssetUrl, latencyStats, writeAuditCsv } from "./audit_io.mjs";

export const RESOURCE_TIMING_EVAL = `() => {
  if (typeof window.__vrcFlushResourceTimingAudit === "function") {
    window.__vrcFlushResourceTimingAudit();
  }
  const raw = window.__vrcResourceTimingAudit || [];
  return raw;
}`;

export function resourceTimingRowsFromPageEntries(entries, meta) {
  const rows = [];
  for (const e of entries || []) {
    if (!e?.name || e.name === "__scan_error__") {
      rows.push({
        user: meta.userId,
        session_id: meta.sessionId,
        url: e.name || "",
        flags: e.flags || "ERROR",
        duration: "",
        requestStart: "",
        responseStart: "",
        responseEnd: "",
        transferSize: "",
        encodedBodySize: "",
        decodedBodySize: "",
      });
      continue;
    }
    if (!isChunkAssetUrl(e.name)) continue;
    rows.push({
      user: meta.userId,
      session_id: meta.sessionId,
      url: e.name,
      initiatorType: e.initiatorType ?? "",
      duration: e.duration ?? "",
      startTime: e.startTime ?? "",
      fetchStart: e.fetchStart ?? "",
      requestStart: e.requestStart ?? "",
      responseStart: e.responseStart ?? "",
      responseEnd: e.responseEnd ?? "",
      transferSize: e.transferSize ?? "",
      encodedBodySize: e.encodedBodySize ?? "",
      decodedBodySize: e.decodedBodySize ?? "",
      deliveryType: e.deliveryType ?? "",
      flags: e.flags ?? "",
    });
  }
  return rows;
}

export function summarizeResourceTiming(rows, userId) {
  const urows = rows.filter((r) => r.user === userId && isChunkAssetUrl(r.url));
  const taoBlocked = urows.filter((r) => String(r.flags).includes("RESOURCE_TIMING_TAO_BLOCKED")).length;
  const zero = urows.filter((r) => String(r.flags).includes("RESOURCE_TIMING_ZERO")).length;
  const withDuration = urows.filter((r) => Number(r.duration) > 0);
  const durations = withDuration.map((r) => Number(r.duration));
  const transferSizes = urows.map((r) => Number(r.transferSize)).filter((x) => x > 0);
  const durS = latencyStats(durations);
  const ok = withDuration.length > 0 && taoBlocked === 0;
  return {
    resource_timing_ok: ok,
    resource_timing_row_count: urows.length,
    resource_timing_tao_blocked_count: taoBlocked,
    resource_timing_zero_count: zero,
    resource_timing_duration_p50_ms: durS.p50,
    resource_timing_duration_p95_ms: durS.p95,
    resource_timing_transfer_bytes: transferSizes.reduce((a, b) => a + b, 0),
  };
}

export function writeResourceTimingAuditCsv(rows, file) {
  writeAuditCsv(rows, file);
}
