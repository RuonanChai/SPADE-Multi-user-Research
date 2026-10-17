/**
 * Node.js analysis aggregator — produces summary CSVs from raw session data.
 * Complements analyze.py for environments without Python/matplotlib.
 * Reads from VRC_RESULTS_ROOT (or vrc-paper/results by default).
 *
 * Usage: node vrc-paper/analysis/aggregate.mjs [--results-root <path>]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const RESULTS_ROOT = (() => {
  const idx = process.argv.indexOf("--results-root");
  if (idx !== -1 && process.argv[idx + 1]) return path.resolve(process.argv[idx + 1]);
  if (process.env.VRC_RESULTS_ROOT) return path.resolve(process.env.VRC_RESULTS_ROOT);
  return path.join(ROOT, "results");
})();

const RAW = path.join(RESULTS_ROOT, "raw");
const SUMMARY = path.join(RESULTS_ROOT, "summary");
fs.mkdirSync(SUMMARY, { recursive: true });

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function writeCsv(rows, file) {
  if (!rows.length) return;
  const keys = [...new Set(rows.flatMap(Object.keys))];
  const lines = rows.map(r => keys.map(k => {
    const v = r[k];
    if (v == null) return "";
    const s = String(v);
    return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(","));
  fs.writeFileSync(file, [keys.join(","), ...lines].join("\n") + "\n");
  console.log(`  wrote ${file} (${rows.length} rows)`);
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

// ── Load all session directories ──────────────────────────────────────────────
function loadSessions() {
  if (!fs.existsSync(RAW)) return [];
  const dirs = fs.readdirSync(RAW).filter(d => {
    const p = path.join(RAW, d);
    return fs.statSync(p).isDirectory() && !d.startsWith("_shardwork");
  });
  return dirs.map(d => ({ id: d, dir: path.join(RAW, d) }));
}

// ── Compute per-session metrics from request_logs + client_metrics ─────────────
function computeSessionMetrics(session) {
  const reqFile = path.join(session.dir, "request_logs.jsonl");
  const metricsFile = path.join(session.dir, "client_metrics.jsonl");
  const statusFile = path.join(session.dir, "status.json");
  const sourceFile = path.join(session.dir, "source_breakdown.json");

  const requests = readJsonl(reqFile);
  const clientMetrics = readJsonl(metricsFile);
  const status = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, "utf8")) : {};
  const source = fs.existsSync(sourceFile) ? JSON.parse(fs.readFileSync(sourceFile, "utf8")) : {};

  // Parse session_id: Method_scenario_tN_timestamp
  const parts = session.id.split("_");
  const method = parts[0] || "";
  const scenario = parts[1] || "";
  const trialMatch = session.id.match(/_t(\d+)_/);
  const trial = trialMatch ? Number(trialMatch[1]) : 0;

  // Chunk requests (.rad/.spz/.splat with service_time_ms)
  const chunkReqs = requests.filter(r =>
    r.url && /\.(rad|spz|splat)(\?|#|$)/i.test(r.url) &&
    r.service_time_ms > 0 && r.service_time_ms < 120000
  );

  if (!chunkReqs.length && !clientMetrics.length) return null;

  const latencies = chunkReqs.map(r => r.service_time_ms).sort((a, b) => a - b);
  const n = latencies.length;
  const totalBytes = chunkReqs.reduce((s, r) => s + (r.bytes_sent || 0), 0);
  const urlCounts = {};
  for (const r of chunkReqs) { urlCounts[r.url] = (urlCounts[r.url] || 0) + 1; }
  const dupCount = Object.values(urlCounts).filter(v => v > 1).length;
  const dupRatio = dupCount / Math.max(1, Object.keys(urlCounts).length);

  // Per-user breakdown
  const userMetrics = {};
  for (const r of chunkReqs) {
    const uid = r.user_id || "u0";
    if (!userMetrics[uid]) userMetrics[uid] = { latencies: [], bytes: 0, count: 0 };
    userMetrics[uid].latencies.push(r.service_time_ms);
    userMetrics[uid].bytes += r.bytes_sent || 0;
    userMetrics[uid].count++;
  }

  // Final client metrics snapshot (last per user)
  const finalSnapshots = {};
  for (const m of clientMetrics) {
    if (m.user_id) finalSnapshots[m.user_id] = m;
  }

  return {
    session_id: session.id,
    method,
    scenario,
    trial,
    status: status.status || "unknown",
    chunk_request_count: n,
    p50_latency_ms: n ? percentile(latencies, 0.5) : null,
    p95_latency_ms: n ? percentile(latencies, 0.95) : null,
    p99_latency_ms: n ? percentile(latencies, 0.99) : null,
    fraction_over_50ms: n ? latencies.filter(x => x > 50).length / n : null,
    aggregate_client_bytes: totalBytes,
    unique_bytes: totalBytes - (dupRatio * totalBytes),
    duplicate_request_ratio: dupRatio,
    delivery_profile: source.delivery_profile || status.delivery_profile || "",
    cdn_label: source.cdn_label || "",
    source_validation_ok: source.source_validation_ok ?? null,
    userMetrics,
    finalSnapshots,
  };
}

// ── Viewport overlap (Jaccard) from server JSONL ──────────────────────────────
function computeViewportOverlap(session) {
  const serverFile = path.join(session.dir, `${session.id}_server.jsonl`);
  const altServer = fs.readdirSync(session.dir).find(f => f.endsWith("_server.jsonl"));
  const file = fs.existsSync(serverFile) ? serverFile : (altServer ? path.join(session.dir, altServer) : null);
  if (!file || !fs.existsSync(file)) return null;

  const events = readJsonl(file);
  const userStates = events.filter(e => e.event === "user_state" && e.viewport_chunks?.length);

  if (userStates.length < 2) return null;

  // Group by 50ms windows
  const windows = {};
  for (const evt of userStates) {
    const wk = Math.floor((evt.t || 0) / 50);
    if (!windows[wk]) windows[wk] = {};
    const uid = evt.user_id || "";
    windows[wk][uid] = new Set(evt.viewport_chunks.map(String));
  }

  const jaccards = [];
  const sharedRatios = [];

  for (const users of Object.values(windows)) {
    const uids = Object.keys(users);
    if (uids.length < 2) continue;

    // Global Jaccard
    let union = new Set();
    let intersection = null;
    for (const uid of uids) {
      union = new Set([...union, ...users[uid]]);
      if (!intersection) intersection = new Set(users[uid]);
      else intersection = new Set([...intersection].filter(x => users[uid].has(x)));
    }
    jaccards.push(intersection.size / Math.max(1, union.size));

    // Shared ratio
    const demand = {};
    for (const uid of uids) {
      for (const c of users[uid]) { demand[c] = (demand[c] || 0) + 1; }
    }
    const shared = Object.values(demand).filter(v => v >= 2).length;
    sharedRatios.push(shared / Math.max(1, Object.keys(demand).length));
  }

  if (!jaccards.length) return null;

  return {
    session_id: session.id,
    n_windows: jaccards.length,
    global_jaccard_mean: +(jaccards.reduce((a, b) => a + b, 0) / jaccards.length).toFixed(4),
    global_jaccard_p50: +percentile(jaccards, 0.5).toFixed(4),
    global_jaccard_p95: +percentile(jaccards, 0.95).toFixed(4),
    shared_ratio_mean: +(sharedRatios.reduce((a, b) => a + b, 0) / sharedRatios.length).toFixed(4),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  console.log(`[aggregate] RESULTS_ROOT=${RESULTS_ROOT}`);
  const sessions = loadSessions();
  if (!sessions.length) {
    console.log("[aggregate] No session directories found in raw/. Run experiments first.");
    process.exit(1);
  }
  console.log(`[aggregate] Found ${sessions.length} sessions`);

  const perRun = [];
  const perClient = [];
  const overlapRows = [];

  for (const session of sessions) {
    const metrics = computeSessionMetrics(session);
    if (!metrics) continue;

    perRun.push({
      session_id: metrics.session_id,
      method: metrics.method,
      scenario: metrics.scenario,
      trial: metrics.trial,
      status: metrics.status,
      chunk_request_count: metrics.chunk_request_count,
      p50_latency_ms: metrics.p50_latency_ms,
      p95_latency_ms: metrics.p95_latency_ms,
      p99_latency_ms: metrics.p99_latency_ms,
      fraction_over_50ms: metrics.fraction_over_50ms,
      aggregate_client_bytes: metrics.aggregate_client_bytes,
      unique_bytes: metrics.unique_bytes,
      duplicate_request_ratio: metrics.duplicate_request_ratio,
      delivery_profile: metrics.delivery_profile,
      cdn_label: metrics.cdn_label,
      source_validation_ok: metrics.source_validation_ok,
    });

    // Per-client rows
    for (const [uid, um] of Object.entries(metrics.userMetrics)) {
      const snap = metrics.finalSnapshots[uid] || {};
      perClient.push({
        session_id: metrics.session_id,
        method: metrics.method,
        scenario: metrics.scenario,
        trial: metrics.trial,
        user_id: uid,
        worker_id: snap.worker_id || "",
        host_ip: snap.host_ip || "",
        chunk_request_count: um.count,
        p50_latency_ms: percentile(um.latencies, 0.5),
        p95_latency_ms: percentile(um.latencies, 0.95),
        p99_latency_ms: percentile(um.latencies, 0.99),
        aggregate_client_bytes: um.bytes,
        fps: snap.fps ?? "",
        visible_quality: snap.visible_quality ?? "",
        qoe: snap.qoe ?? "",
      });
    }

    // Viewport overlap
    const overlap = computeViewportOverlap(session);
    if (overlap) overlapRows.push(overlap);
  }

  writeCsv(perRun, path.join(SUMMARY, "per_run_metrics.csv"));
  writeCsv(perClient, path.join(SUMMARY, "per_client_metrics.csv"));
  writeCsv(overlapRows, path.join(SUMMARY, "viewport_overlap_per_session.csv"));

  // Aggregate by method × scenario
  const groups = {};
  for (const r of perRun) {
    const key = `${r.method}|${r.scenario}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }

  const summary = [];
  for (const [key, rows] of Object.entries(groups)) {
    const [method, scenario] = key.split("|");
    const p95s = rows.map(r => r.p95_latency_ms).filter(v => v != null);
    const fracs = rows.map(r => r.fraction_over_50ms).filter(v => v != null);
    const dups = rows.map(r => r.duplicate_request_ratio).filter(v => v != null);
    const bytes = rows.map(r => r.aggregate_client_bytes).filter(v => v != null);
    summary.push({
      method,
      scenario,
      n: rows.length,
      p95_latency_ms_mean: p95s.length ? +(p95s.reduce((a, b) => a + b, 0) / p95s.length).toFixed(2) : "",
      p95_latency_ms_p50: p95s.length ? +percentile(p95s, 0.5).toFixed(2) : "",
      fraction_over_50ms_mean: fracs.length ? +(fracs.reduce((a, b) => a + b, 0) / fracs.length).toFixed(4) : "",
      duplicate_request_ratio_mean: dups.length ? +(dups.reduce((a, b) => a + b, 0) / dups.length).toFixed(4) : "",
      aggregate_client_bytes_mean: bytes.length ? Math.round(bytes.reduce((a, b) => a + b, 0) / bytes.length) : "",
    });
  }
  writeCsv(summary, path.join(SUMMARY, "metrics_summary.csv"));

  // All methods overview
  const ALL_METHODS = ["Full", "Spark-MU", "VP-S", "NET-S", "VRC-V", "VRC-N", "VRC-O", "VRC"];
  const overview = summary.filter(r => ALL_METHODS.includes(r.method));
  writeCsv(overview, path.join(SUMMARY, "all_methods_overview.csv"));

  console.log(`[aggregate] Done: ${perRun.length} runs, ${perClient.length} client rows, ${overlapRows.length} overlap rows`);
}

main();
