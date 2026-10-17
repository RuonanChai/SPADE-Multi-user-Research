/**
 * 不经 instrumented proxy 时，从 CDP client jsonl 合成 proxy.jsonl 中的 request_complete，
 * 供 validate-run-coverage / analyze-abc-distributed / validate-bcd-run-artifacts 使用。
 * 上游耗时与字节近似自客户端观测（无独立 upstream 探针）。
 */
import fs from "node:fs/promises";
import path from "node:path";

import { PAGE_SIZE } from "./dist-replay-constants.mjs";

function parseArgs(argv) {
  const out = { runRoot: "", proxyLog: "", runId: "" };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "runRoot") out.runRoot = v;
    else if (k === "proxyLog") out.proxyLog = v;
    else if (k === "runId") out.runId = v;
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

function isCdp(r) {
  return r && (!r.source || r.source === "cdp_network");
}

function isDebugProbeUrl(u) {
  return typeof u === "string" && /\/debug-scene-probe\.rad(\?|$)/i.test(u);
}

function upstreamBytesFromRow(row) {
  const enc = Number(row.encodedDataLength);
  if (Number.isFinite(enc) && enc > 0) return enc;
  const cl = Number(row.content_length);
  if (Number.isFinite(cl) && cl > 0) return cl;
  return 1;
}

async function walkClientLines(runRoot) {
  const rows = [];
  async function walk(dir) {
    const ent = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of ent) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.startsWith("client-") && e.name.endsWith(".jsonl")) {
        const raw = await fs.readFile(p, "utf8");
        for (const line of raw.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          try {
            rows.push(JSON.parse(t));
          } catch {
            /* */
          }
        }
      }
    }
  }
  await walk(runRoot);
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.runRoot || !args.proxyLog) {
    console.error("需要 --runRoot= --proxyLog= [--runId=]");
    process.exitCode = 1;
    return;
  }
  const runRoot = path.resolve(args.runRoot);
  const proxyLog = path.isAbsolute(args.proxyLog) ? args.proxyLog : path.join(runRoot, args.proxyLog);
  const lines = await walkClientLines(runRoot);
  const filtered = lines.filter(
    (r) =>
      isCdp(r) &&
      !r.debug_only &&
      !isDebugProbeUrl(String(r.url || "")) &&
      (!args.runId || String(r.run_id || "") === String(args.runId)),
  );

  let appended = 0;
  for (const row of filtered) {
    const dur = Number(row.duration_ms);
    const endTs = Number(row.end_ts_ms);
    const startTs =
      Number.isFinite(endTs) && Number.isFinite(dur) ? Math.max(0, endTs - dur) : Number(row.request_ts_ms) || Date.now();
    const ub = upstreamBytesFromRow(row);
    const url = String(row.url || "");
    const rawRange = row.raw_range || null;
    const logicalPages = normalizeLogicalPages(url, rawRange);
    const proxyRow = {
      event: "request_complete",
      request_id: `cdp-${startTs}-${Math.random().toString(36).slice(2, 9)}`,
      client_id: String(row.user_id || "unknown"),
      run_id: String(row.run_id || ""),
      trace_id: String(row.trace_id || ""),
      pathname: (() => {
        try {
          return new URL(url, "http://local").pathname;
        } catch {
          return "";
        }
      })(),
      url,
      raw_range: rawRange,
      normalized_logical_pages: logicalPages,
      upstream_target: "direct_synthetic",
      cache_hit: false,
      phase_timestamps: {
        upstream_fetch_started: startTs,
        upstream_finished: Number.isFinite(endTs) ? endTs : startTs + Math.max(0, dur || 0),
      },
      upstream_start_ts: startTs,
      upstream_end_ts: Number.isFinite(endTs) ? endTs : startTs + Math.max(0, dur || 0),
      upstream_bytes: ub,
      downstream_bytes: ub,
      synthetic_from_cdp: true,
      status_code: row.status,
      status: row.status,
    };
    await fs.appendFile(proxyLog, `${JSON.stringify(proxyRow)}\n`, "utf8");
    appended += 1;
  }
  console.log(`[synthesize-proxy-from-cdp] appended ${appended} rows -> ${proxyLog}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
