import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const PAGE_SIZE = 256 * 1024;

function parseArgs(argv) {
  const out = { root: "", runIds: "", windowMs: 250, out: "" };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "root") out.root = v;
    else if (k === "runIds") out.runIds = v;
    else if (k === "windowMs") out.windowMs = Number.parseInt(v || "250", 10);
    else if (k === "out") out.out = v;
  }
  return out;
}

function pct(values, p) {
  const xs = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const i = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
  return xs[i];
}

function normPages(url, rawRange) {
  if (!rawRange) return [`${url}#full-0`];
  const m = /^bytes=(\d+)-(\d+)?$/i.exec(String(rawRange).trim());
  if (!m) return [];
  const s = Math.floor(Number.parseInt(m[1], 10) / PAGE_SIZE);
  const e = Math.floor(Number.parseInt(m[2] || m[1], 10) / PAGE_SIZE);
  const out = [];
  for (let i = s; i <= e; i += 1) out.push(`${url}#${i}`);
  return out;
}

function isDebugProbeUrl(u) {
  return typeof u === "string" && /\/debug-scene-probe\.rad(\?|$)/i.test(u);
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function readJsonl(file) {
  const raw = await fs.readFile(file, "utf8").catch(() => "");
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

async function collectClientRows(runDir, runId) {
  const rows = [];
  for (const slot of ["local", "remote"]) {
    const dir = path.join(runDir, slot);
    const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of ents) {
      if (!e.isFile() || !e.name.startsWith("client-") || !e.name.endsWith(".jsonl")) continue;
      const ls = await readJsonl(path.join(dir, e.name));
      for (const r of ls) {
        if (runId && String(r.run_id || "") !== String(runId)) continue;
        if (r.source && r.source !== "cdp_network") continue;
        if (r.debug_only || isDebugProbeUrl(String(r.url || ""))) continue;
        rows.push(r);
      }
    }
  }
  return rows;
}

function toWindow(ts, base, windowMs) {
  if (!Number.isFinite(ts) || !Number.isFinite(base)) return -1;
  return Math.max(0, Math.floor((ts - base) / windowMs));
}

function mkWindow(i, windowMs) {
  return {
    t0_ms: i * windowMs,
    client_requests: 0,
    new_unique_pages: 0,
    upstream_requests_started: 0,
    upstream_inflight_peak: 0,
    upstream_bytes: 0,
    client_p95_latency: null,
    client_p99_latency: null,
    upstream_p95_latency: null,
    upstream_p99_latency: null,
  };
}

async function analyzeRun(root, runId, windowMs) {
  const runDir = path.join(root, runId);
  const notes = [];
  const proxyFile = path.join(runDir, "proxy", "proxy.jsonl");
  const summary = await readJson(path.join(runDir, "summary", "distributed-summary.json"));
  const validate = await readJson(path.join(runDir, "validate-run-coverage.json"));

  const clientRows = await collectClientRows(runDir, runId);
  if (!clientRows.length) notes.push("no client cdp rows");
  const pAll = await readJsonl(proxyFile);
  const proxyRows = pAll.filter(
    (p) =>
      (!p.event || p.event === "request_complete") &&
      String(p.run_id || "") === String(runId) &&
      !isDebugProbeUrl(String(p.url || "")),
  );
  if (!proxyRows.length) notes.push("no proxy request_complete rows");

  const tsClient = clientRows.map((r) => Number(r.request_ts_ms || r.end_ts_ms || 0)).filter((x) => x > 0);
  const tsProxy = proxyRows.map((r) => Number(r.recv_ts || 0)).filter((x) => x > 0);
  const baseTs = Math.min(...[...tsClient, ...tsProxy].filter((x) => Number.isFinite(x) && x > 0));
  if (!Number.isFinite(baseTs)) notes.push("missing base timestamp");

  const windows = new Map();
  const ensure = (i) => {
    if (i < 0) return null;
    if (!windows.has(i)) windows.set(i, mkWindow(i, windowMs));
    return windows.get(i);
  };

  const seenPages = new Set();
  const clientDurPerWindow = new Map();
  for (const r of clientRows) {
    const t = Number(r.request_ts_ms || r.end_ts_ms || 0);
    const wi = toWindow(t, baseTs, windowMs);
    const w = ensure(wi);
    if (!w) continue;
    w.client_requests += 1;
    const pgs = normPages(String(r.url || ""), r.raw_range);
    let inc = 0;
    for (const p of pgs) {
      if (!seenPages.has(p)) {
        seenPages.add(p);
        inc += 1;
      }
    }
    w.new_unique_pages += inc;
    const d = Number(r.duration_ms);
    if (Number.isFinite(d)) {
      if (!clientDurPerWindow.has(wi)) clientDurPerWindow.set(wi, []);
      clientDurPerWindow.get(wi).push(d);
    }
  }

  const upDurPerWindow = new Map();
  const events = [];
  const queue = [];
  const service = [];
  const tail = [];
  const totalProxy = [];
  for (const p of proxyRows) {
    const recv = Number(p.recv_ts || 0);
    const st = Number(p.upstream_start_ts || p.phase_timestamps?.upstream_fetch_started || 0);
    const end = Number(p.upstream_end_ts || 0);
    const dend = Number(p.downstream_end_ts || p.phase_timestamps?.downstream_finished || 0);
    const wiStart = toWindow(st || recv, baseTs, windowMs);
    const wStart = ensure(wiStart);
    if (wStart) wStart.upstream_requests_started += 1;
    const wiEnd = toWindow(end || recv, baseTs, windowMs);
    const wEnd = ensure(wiEnd);
    if (wEnd) wEnd.upstream_bytes += Number(p.upstream_bytes || 0);
    const up = end > 0 && st > 0 ? end - st : null;
    if (up != null && Number.isFinite(up) && up >= 0) {
      if (!upDurPerWindow.has(wiEnd)) upDurPerWindow.set(wiEnd, []);
      upDurPerWindow.get(wiEnd).push(up);
    }
    if (st > 0 && end > st) {
      events.push({ t: st, d: 1 });
      events.push({ t: end, d: -1 });
    }
    if (recv > 0 && st > 0) queue.push(st - recv);
    if (st > 0 && end > 0) service.push(end - st);
    if (end > 0 && dend > 0) tail.push(dend - end);
    if (recv > 0 && dend > 0) totalProxy.push(dend - recv);
  }

  events.sort((a, b) => (a.t - b.t) || (b.d - a.d));
  const peakMap = new Map();
  let inflight = 0;
  for (const ev of events) {
    inflight += ev.d;
    const wi = toWindow(ev.t, baseTs, windowMs);
    if (wi < 0) continue;
    peakMap.set(wi, Math.max(peakMap.get(wi) || 0, inflight));
  }

  for (const [i, w] of windows.entries()) {
    w.upstream_inflight_peak = peakMap.get(i) || 0;
    const cd = clientDurPerWindow.get(i) || [];
    w.client_p95_latency = pct(cd, 95);
    w.client_p99_latency = pct(cd, 99);
    const ud = upDurPerWindow.get(i) || [];
    w.upstream_p95_latency = pct(ud, 95);
    w.upstream_p99_latency = pct(ud, 99);
  }

  const runSum = (summary?.runs || []).find((r) => String(r.run_id) === String(runId)) || null;
  const valid = Boolean(validate?.coverage_ok && runSum && !runSum?.validity?.run_invalid);

  return {
    run_id: runId,
    scenario: runSum?.scenario || null,
    valid,
    notes,
    totals: {
      B_client_agg: runSum?.totals?.total_B_client_agg ?? null,
      B_unique: runSum?.totals?.total_B_unique ?? null,
      B_upstream: runSum?.totals?.total_B_upstream ?? null,
    },
    latency_breakdown: {
      queue_p50: pct(queue, 50),
      queue_p95: pct(queue, 95),
      queue_p99: pct(queue, 99),
      service_p50: pct(service, 50),
      service_p95: pct(service, 95),
      service_p99: pct(service, 99),
      downstream_tail_p50: pct(tail, 50),
      downstream_tail_p95: pct(tail, 95),
      downstream_tail_p99: pct(tail, 99),
      total_proxy_delay_p50: pct(totalProxy, 50),
      total_proxy_delay_p95: pct(totalProxy, 95),
      total_proxy_delay_p99: pct(totalProxy, 99),
      client_total_delay_p50: pct(clientRows.map((r) => Number(r.duration_ms)).filter((x) => Number.isFinite(x)), 50),
      client_total_delay_p95: pct(clientRows.map((r) => Number(r.duration_ms)).filter((x) => Number.isFinite(x)), 95),
      client_total_delay_p99: pct(clientRows.map((r) => Number(r.duration_ms)).filter((x) => Number.isFinite(x)), 99),
    },
    windows: [...windows.values()].sort((a, b) => a.t0_ms - b.t0_ms),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root || !args.runIds || !args.out) throw new Error("need --root --runIds --out");
  const root = path.resolve(args.root);
  const ids = args.runIds.split(",").map((x) => x.trim()).filter(Boolean);
  const runs = [];
  for (const id of ids) {
    runs.push(await analyzeRun(root, id, args.windowMs > 0 ? args.windowMs : 250));
  }
  const out = {
    generated_at: new Date().toISOString(),
    window_ms: args.windowMs > 0 ? args.windowMs : 250,
    runs,
  };
  const outPath = path.resolve(args.out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

