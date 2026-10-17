/**
 * 逻辑页双口径：totals（全实验）与 windows（窗口切片）；客户端以 CDP 为主、fetch_hook 为 fallback。
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { SCENE_EXT, RANGE_RE } from "../scripts/dist-replay-constants.mjs";

function parseArgs(argv) {
  const out = {
    clientLog: "results/client-fetch.jsonl",
    proxyLog: "proxy/proxy-logs.jsonl",
    windowMs: 1000,
    out: "analysis/metrics-by-window.json",
    runId: "",
    expectedUsers: 0,
    pageSize: 256 * 1024,
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "clientLog") out.clientLog = v || out.clientLog;
    else if (k === "proxyLog") out.proxyLog = v || out.proxyLog;
    else if (k === "windowMs") out.windowMs = Number.parseInt(v || "1000", 10);
    else if (k === "out") out.out = v || out.out;
    else if (k === "runId") out.runId = v;
    else if (k === "expectedUsers") out.expectedUsers = Number.parseInt(v || "0", 10);
    else if (k === "pageSize") out.pageSize = Number.parseInt(v || String(256 * 1024), 10);
  }
  if (!out.runId) out.runId = process.env.SPARK_RUN_ID || "";
  if (out.expectedUsers <= 0 && process.env.SPARK_EXPECTED_USERS)
    out.expectedUsers = Number.parseInt(process.env.SPARK_EXPECTED_USERS, 10);
  return out;
}

function isCdpPrimary(r) {
  return r && (!r.source || r.source === "cdp_network");
}

function normalizePages(url, rawRange, pageSize) {
  if (!rawRange) {
    return [`${url}#full-0`];
  }
  const m = /^bytes=(\d+)-(\d+)?$/i.exec(String(rawRange).trim());
  if (!m) return [];
  const start = Number.parseInt(m[1], 10);
  const end = m[2] ? Number.parseInt(m[2], 10) : start;
  const s = Math.floor(start / pageSize);
  const e = Math.floor(end / pageSize);
  const o = [];
  for (let i = s; i <= e; i += 1) o.push(`${url}#${i}`);
  return o;
}

function hasSceneUrl(u) {
  return typeof u === "string" && SCENE_EXT.test(u);
}

function hasRangeEntry(row) {
  if (row.raw_range && String(row.raw_range).length) return true;
  const rh = row.response_headers;
  if (!rh) return false;
  const cr = Object.keys(rh).find((k) => k.toLowerCase() === "content-range");
  return Boolean(cr && rh[cr]);
}

function hasRangeInHeadersOrReq(row) {
  if (hasRangeEntry(row)) return true;
  if (row.request_headers && (RANGE_RE.test(JSON.stringify(row.request_headers)) || /range/i.test(JSON.stringify(row.request_headers))))
    return true;
  return false;
}

function pct(values, p) {
  const sorted = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function toWindowIndex(tsMs, baseTs, windowMs) {
  if (!Number.isFinite(tsMs) || !Number.isFinite(baseTs)) return -1;
  return Math.max(0, Math.floor((tsMs - baseTs) / windowMs));
}

async function readJsonlFile(file) {
  const raw = await fs.readFile(file, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function collectClientLines(clientPath, runId) {
  const p = path.resolve(clientPath);
  if (!existsSync(p)) return [];
  const st = await fs.stat(p).catch(() => null);
  if (!st) return [];
  if (st.isFile()) {
    const rows = await readJsonlFile(p);
    return rows.filter((r) => (runId ? String(r.run_id || "") === String(runId) : true));
  }
  const out = [];
  async function walk(dir) {
    const ent = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of ent) {
      const q = path.join(dir, e.name);
      if (e.isDirectory()) await walk(q);
      else if (e.isFile() && e.name.startsWith("client-") && e.name.endsWith(".jsonl")) {
        const rows = await readJsonlFile(q);
        for (const r of rows) {
          if (runId && String(r.run_id || "") !== String(runId)) continue;
          out.push(r);
        }
      }
    }
  }
  await walk(p);
  return out;
}

async function readProxyLog(proxyPath) {
  const p = path.resolve(proxyPath);
  if (!existsSync(p)) return [];
  const raw = await fs.readFile(p, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function filterProxyRows(prox, runId) {
  return prox.filter((x) => {
    if (x.event && x.event !== "request_complete") return false;
    if (runId && String(x.run_id || "") !== String(runId)) return false;
    return true;
  });
}

function selectClientRows(all, runId) {
  const filtered = runId ? all.filter((r) => String(r.run_id || "") === String(runId)) : all;
  const cdp = filtered.filter(isCdpPrimary);
  if (cdp.length) return { rows: cdp, used: "cdp_network" };
  return { rows: filtered, used: "fetch_hook_fallback" };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pageSize = args.pageSize > 0 ? args.pageSize : 256 * 1024;
  const allClient = await collectClientLines(args.clientLog, args.runId);
  const { rows: useRows, used: clientSource } = selectClientRows(allClient, args.runId);
  const runIdOut = args.runId || (useRows[0] && useRows[0].run_id) || "unknown";

  const allProxy = await readProxyLog(args.proxyLog);
  const proxyComplete = filterProxyRows(allProxy, args.runId);

  const has_scene_request =
    useRows.some((r) => hasSceneUrl(r.url)) || allProxy.some((p) => hasSceneUrl(String(p.url || "")));
  const has_range_request =
    useRows.some((r) => hasRangeInHeadersOrReq(r)) || allProxy.some((p) => p.raw_range && String(p.raw_range).length > 0);

  const userIds = [...new Set(useRows.map((r) => r.user_id).filter(Boolean))];
  const byUser = new Map();
  for (const u of userIds) byUser.set(u, { completion: 0 });
  for (const r of useRows) {
    const u = r.user_id || "unknown";
    if (!r.ok) continue;
    if (!byUser.has(u)) byUser.set(u, { completion: 0 });
    byUser.get(u).completion += 1;
  }
  const active_users = [...byUser.values()].filter((x) => x.completion > 0).length;
  const expected = args.expectedUsers > 0 ? args.expectedUsers : 0;
  const upstream_bytes_sum = proxyComplete.reduce((a, p) => a + (Number(p.upstream_bytes) || 0), 0);

  const pageListAgg = useRows.flatMap((f) => normalizePages(f.url, f.raw_range, pageSize));
  const uniqueC = new Set(pageListAgg);
  const pageListU = proxyComplete.flatMap((p) => normalizePages(p.url || "", p.raw_range, pageSize));
  const uniqueU = new Set(pageListU);

  const B_client_agg = pageListAgg.length * pageSize;
  const B_unique = uniqueC.size * pageSize;
  const B_upstream = uniqueU.size * pageSize;
  const total_upstream_bytes_positive = upstream_bytes_sum > 0;

  const reason = [];
  if (!has_scene_request) reason.push("missing scene-class request (URL extension)");
  if (!has_range_request) reason.push("missing range request (bytes= / Content-Range)");
  if (expected > 0 && active_users < expected) reason.push("active_users < expected_users");
  if (B_upstream <= 0) reason.push("B_upstream (logical) <= 0");
  if (!total_upstream_bytes_positive) reason.push("sum(proxy upstream_bytes) <= 0");

  const run_invalid =
    !has_scene_request ||
    !has_range_request ||
    (expected > 0 && active_users < expected) ||
    B_upstream <= 0 ||
    !total_upstream_bytes_positive;

  const allTs = [
    ...useRows.map((x) => Number(x.end_ts_ms || x.response_ts_ms || x.request_ts_ms || 0)).filter((x) => x > 0),
    ...proxyComplete.map((x) => Number(x.recv_ts || x.phase_timestamps?.downstream_received || 0)).filter((x) => x > 0),
  ];
  const baseTs = allTs.length ? Math.min(...allTs) : 0;
  const windowMs = args.windowMs > 0 ? args.windowMs : 1000;
  const windows = new Map();
  const ensureW = (idx) => {
    if (idx < 0) return null;
    if (!windows.has(idx)) {
      windows.set(idx, {
        window_index: idx,
        t_start_ms: idx * windowMs,
        t_end_ms: (idx + 1) * windowMs,
        b_client_agg: 0,
        unique_client_pages: new Set(),
        proxy_pages: new Set(),
      });
    }
    return windows.get(idx);
  };

  for (const r of useRows) {
    const t = Number(r.end_ts_ms || r.response_ts_ms || r.request_ts_ms || 0);
    const idx = toWindowIndex(t, baseTs, windowMs);
    const w = ensureW(idx);
    if (!w) continue;
    const parts = normalizePages(r.url, r.raw_range, pageSize);
    w.b_client_agg = (w.b_client_agg || 0) + parts.length * pageSize;
    for (const pg of parts) w.unique_client_pages.add(pg);
  }
  for (const p of proxyComplete) {
    const t = Number(p.recv_ts || p.phase_timestamps?.downstream_received || 0);
    const idx = toWindowIndex(t, baseTs, windowMs);
    const w = ensureW(idx);
    if (!w) continue;
    for (const pg of normalizePages(p.url || "", p.raw_range, pageSize)) w.proxy_pages.add(pg);
  }

  const windowRows = [...windows.values()]
    .sort((a, b) => a.window_index - b.window_index)
    .map((row) => {
      const cPages = row.unique_client_pages;
      const uPages = row.proxy_pages;
      return {
        window_index: row.window_index,
        t_start_ms: row.t_start_ms,
        t_end_ms: row.t_end_ms,
        B_client_agg: row.b_client_agg || 0,
        B_unique: cPages.size * pageSize,
        B_upstream: uPages.size * pageSize,
      };
    });

  const clientDurations = useRows.map((x) => Number(x.duration_ms)).filter((x) => Number.isFinite(x));
  const upLat = proxyComplete
    .map((x) => {
      const t0 = Number(x.upstream_start_ts || x.phase_timestamps?.upstream_fetch_started || 0);
      return Number(x.upstream_end_ts || 0) - t0;
    })
    .filter((x) => Number.isFinite(x) && x >= 0);

  const out = {
    run_id: String(runIdOut),
    page_size: pageSize,
    window_ms: windowMs,
    client_source: clientSource,
    validity: {
      has_scene_request,
      has_range_request,
      active_users,
      expected_users: expected,
      B_upstream,
      upstream_bytes_sum,
      total_upstream_bytes_positive,
      run_invalid,
      reason,
    },
    totals: {
      B_client_agg,
      B_unique,
      B_upstream,
    },
    latency: {
      client_p50: pct(clientDurations, 50),
      client_p95: pct(clientDurations, 95),
      client_p99: pct(clientDurations, 99),
      upstream_p50: pct(upLat, 50),
      upstream_p95: pct(upLat, 95),
      upstream_p99: pct(upLat, 99),
    },
    windows: windowRows,
  };

  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, JSON.stringify(out, null, 2), "utf8");
  if (run_invalid) process.exitCode = 2;
  console.log(`Wrote ${args.out}${run_invalid ? " (run_invalid)" : ""}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
