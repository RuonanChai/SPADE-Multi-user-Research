/**
 * Orchestrate Phase 1–6 audits for one trial (local probe / diagnostics).
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { writeAuditCsv } from "./audit_io.mjs";
import { summarizeCdpNetworkAudit } from "./cdp_network_audit.mjs";
import {
  RESOURCE_TIMING_EVAL,
  resourceTimingRowsFromPageEntries,
  summarizeResourceTiming,
  writeResourceTimingAuditCsv,
} from "./resource_timing_audit.mjs";
import { alignCdnServerLogs, writeCdnServerAlignCsv } from "./cdn_server_log_align.mjs";
import { computeLatencyAttribution } from "./latency_attribution.mjs";
import { writeBottleneckSummary } from "./write_bottleneck_summary.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESOURCE_TIMING_PROBE = path.join(__dirname, "..", "client_instrument", "resource_timing_probe.js");

export function auditEnvEnabled() {
  return {
    network: process.env.VRC_CDP_NETWORK_AUDIT === "1",
    trace: process.env.VRC_CDP_PERF_TRACE === "1",
    resourceTiming: process.env.VRC_RESOURCE_TIMING_AUDIT === "1"
      || process.env.VRC_CDP_NETWORK_AUDIT === "1",
    cdnLog: !!(process.env.VRC_CDN_PROXY_LOG || "").trim(),
    summary: process.env.VRC_WRITE_BOTTLENECK_SUMMARY === "1",
  };
}

export function perfTraceUsers() {
  const raw = (process.env.VRC_PERF_TRACE_USERS ?? "0").trim();
  if (!raw) return new Set(["u0"]);
  return new Set(raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean));
}

export function loadResourceTimingInitScript() {
  return fs.readFileSync(RESOURCE_TIMING_PROBE, "utf8");
}

/**
 * @param {object} opts
 * @param {string} opts.runDir
 * @param {string} opts.sessionId
 * @param {string[]} opts.userIds
 * @param {Array<{ page, userId, networkAuditor?, perfTrace? }>} opts.pages
 * @param {object[]} opts.chunkRequests playwright-enriched request log rows
 * @param {Record<string, object>} opts.browserSnapByUser
 * @param {number} opts.trialStartMs
 */
export async function finalizeTrialAudits(opts) {
  const env = auditEnvEnabled();
  const results = {
    cdpNetworkRows: [],
    resourceTimingRows: [],
    cdnAlignRows: [],
    perUserAudit: {},
    paths: {},
  };

  for (const p of opts.pages) {
    if (p.networkAuditor) {
      try { await p.networkAuditor.stop(); } catch { /* */ }
      results.cdpNetworkRows.push(...p.networkAuditor.getCsvRows());
    }
    if (p.perfTrace) {
      try {
        const sum = await p.perfTrace.stop(opts.runDir);
        results.perUserAudit[p.userId] = { ...(results.perUserAudit[p.userId] || {}), ...sum };
      } catch (e) {
        results.perUserAudit[p.userId] = {
          ...(results.perUserAudit[p.userId] || {}),
          trace_ok: false,
          trace_error: e.message,
          trace_path: "",
        };
      }
    }
    if (env.resourceTiming && p.page && !p.page.isClosed()) {
      try {
        const entries = await p.page.evaluate(RESOURCE_TIMING_EVAL);
        const meta = { userId: p.userId, sessionId: opts.sessionId };
        results.resourceTimingRows.push(...resourceTimingRowsFromPageEntries(entries, meta));
      } catch (e) {
        results.resourceTimingRows.push({
          user: p.userId,
          session_id: opts.sessionId,
          url: "__evaluate_error__",
          flags: e.message,
        });
      }
    }
  }

  if (env.network && results.cdpNetworkRows.length) {
    const f = path.join(opts.runDir, "cdp_network_audit.csv");
    writeAuditCsv(results.cdpNetworkRows, f);
    results.paths.cdp_network_audit = f;
    const sumDir = path.join(path.dirname(opts.runDir), "..", "summary");
    try {
      const f2 = path.join(sumDir, `cdp_network_audit_${opts.sessionId}.csv`);
      writeAuditCsv(results.cdpNetworkRows, f2);
      results.paths.cdp_network_audit_summary = f2;
    } catch { /* */ }
  }

  if (env.resourceTiming) {
    const f = path.join(opts.runDir, "resource_timing_audit.csv");
    writeResourceTimingAuditCsv(results.resourceTimingRows, f);
    results.paths.resource_timing_audit = f;
  }

  if (env.cdnLog && results.cdpNetworkRows.length) {
    const align = alignCdnServerLogs(process.env.VRC_CDN_PROXY_LOG, results.cdpNetworkRows, {
      sessionId: opts.sessionId,
      trialStartMs: opts.trialStartMs,
      trialEndMs: Date.now(),
    });
    results.cdnAlignRows = align.rows;
    const f = path.join(opts.runDir, "cdn_server_log_align.csv");
    writeCdnServerAlignCsv(align.rows, f);
    results.paths.cdn_server_log_align = f;
    results.paths.cdn_proxy_log = process.env.VRC_CDN_PROXY_LOG;
  }

  for (const uid of opts.userIds) {
    const snap = opts.browserSnapByUser[uid] ?? {};
    const net = env.network ? summarizeCdpNetworkAudit(results.cdpNetworkRows, uid) : {};
    const rt = env.resourceTiming ? summarizeResourceTiming(results.resourceTimingRows, uid) : { resource_timing_ok: false };
    const trace = results.perUserAudit[uid] ?? { trace_ok: false };
    const chunkN = (opts.chunkRequests || []).filter((r) => r.user_id === uid).length;
    const attr = computeLatencyAttribution({
      ...net,
      ...rt,
      trace_ok: !!trace.trace_ok,
      trace_main_script_ms: trace.main_script_ms ?? 0,
      trace_long_task_count: trace.longtask_count ?? 0,
      trace_layout_paint_ms: trace.layout_paint_ms ?? 0,
      trace_composite_ms: trace.composite_ms ?? 0,
      trace_gpu_ms: (trace.gpu_ms ?? 0) + (trace.raster_ms ?? 0),
      fps: snap.fps ?? 0,
      p95_latency_ms: snap.p95_latency_ms ?? 0,
      viewport_to_visible_latency_ms: snap.viewport_to_visible_latency_ms,
      net_completed_request_count: net.net_completed_request_count ?? 0,
      playwright_chunk_rows: chunkN,
      net_zero_encoded_length_count: net.net_zero_encoded_length_count ?? 0,
    });
    results.perUserAudit[uid] = {
      ...net,
      ...rt,
      trace_ok: !!trace.trace_ok,
      trace_path: trace.trace_path ?? "",
      trace_main_script_ms: Math.round((trace.main_script_ms ?? 0) / 1000),
      trace_layout_paint_ms: Math.round((trace.layout_paint_ms ?? 0) / 1000),
      trace_composite_ms: Math.round((trace.composite_ms ?? 0) / 1000),
      trace_gpu_ms: Math.round(((trace.gpu_ms ?? 0) + (trace.raster_ms ?? 0)) / 1000),
      trace_long_task_count: trace.longtask_count ?? 0,
      trace_frame_count: trace.frame_count ?? 0,
      trace_loading_event_ms: Math.round((trace.trace_loading_event_ms ?? 0) / 1000),
      ...attr,
    };
  }

  return results;
}

export function mergeAuditIntoMetricRow(row, audit) {
  if (!audit) return row;
  return { ...row, ...audit };
}

export function maybeWriteBottleneckSummary(runDir, sessionId, perClientRows, paths) {
  if (process.env.VRC_WRITE_BOTTLENECK_SUMMARY !== "1") return null;
  return writeBottleneckSummary(runDir, { sessionId, perClientRows, auditPaths: paths });
}
