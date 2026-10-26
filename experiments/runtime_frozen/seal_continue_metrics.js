"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { replayDecisions } = require("./shadow_queue_replay");

const ROOT = path.resolve(__dirname, "..");
const LEDGER = path.join(ROOT, "PHYSICAL_ATTEMPT_LEDGER.csv");
const DEFAULT_CLIENTS = ["C3", "C4"];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      rows.push({ type: "PARSE_ERROR", error: error.message });
    }
  }
  return rows;
}
function countParseErrors(rows) {
  return rows.reduce((sum, row) => sum + (row.type === "PARSE_ERROR" ? 1 : 0), 0);
}
function csv(rows) {
  return rows.map((row) => row.map((value) => {
    const text = value == null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(",")).join("\n") + "\n";
}
function write(name, rows) {
  fs.writeFileSync(path.join(ROOT, name), csv(rows));
}
function pct(values, p) {
  if (!values.length) return "NOT_MEASURED:no_origin_ttfb";
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}
function findClient(cell, runId, id) {
  const base = path.join(cell, "evidence", runId, id, id);
  const evidencePath = path.join(base, `${id}_evidence.json`);
  const errorPath = path.join(base, `${id}_error.json`);
  const startupPath = path.join(base, "STARTUP_STAGES.json");
  const eventsPath = path.join(base, `${id}_spark_events.jsonl`);
  const evidence = fs.existsSync(evidencePath) ? readJson(evidencePath) : null;
  const error = fs.existsSync(errorPath) ? readJson(errorPath) : null;
  let skew = evidence && Number.isFinite(evidence.measurement_start_skew_ms) ? evidence.measurement_start_skew_ms : null;
  if (skew == null && error && error.error) {
    const match = String(error.error).match(/MEASUREMENT_START_SKEW_INVALID:(-?\d+(?:\.\d+)?)/);
    if (match) skew = Number(match[1]);
  }
  const events = readJsonl(eventsPath);
  const observations = events.filter((row) => row.type === "client_observation").length;
  return {
    id, evidence, error, skew,
    startup: fs.existsSync(startupPath) ? readJson(startupPath) : null,
    observations,
    parseErrors: countParseErrors(events),
  };
}
function windowOrigin(rows, userId, startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { bytes: "NOT_MEASURED:no_window", hits: 0, misses: 0, ttfb: [] };
  }
  let bytes = 0;
  let hits = 0;
  let misses = 0;
  const ttfb = [];
  for (const row of rows) {
    if (row.type === "PARSE_ERROR") continue;
    const ts = Number(row.timestamp || row.request_start_ms);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || ts < startMs || ts > endMs) continue;
    if (userId && row.user_id && row.user_id !== userId && row.user_id !== `user_${userId}`) continue;
    if (row.bytes_from_origin) bytes += Number(row.bytes_from_origin) || 0;
    if (row.cache_hit === true) hits += 1;
    if (row.decision === "origin_fetch") misses += 1;
    if (Number.isFinite(row.origin_ttfb_ms)) ttfb.push(Number(row.origin_ttfb_ms));
  }
  return { bytes, hits, misses, ttfb };
}

function cells() {
  const dir = path.join(ROOT, "cells");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((name) => path.join(dir, name)).filter((dirPath) => fs.statSync(dirPath).isDirectory());
}

function loadLedger() {
  if (!fs.existsSync(LEDGER)) return [];
  const lines = fs.readFileSync(LEDGER, "utf8").split(/\n/).filter(Boolean);
  return lines.slice(1).map((line) => {
    const [attempt_seq, attempt_id, run_id, method, seed, n, regime, started_at, outcome, evidence] = line.split(",");
    return { attempt_seq, attempt_id, run_id, method, seed, n, regime, started_at, outcome, evidence };
  });
}
function splitCsv(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; }
        else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
function readDataRows(name) {
  const file = path.join(ROOT, name);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\n/).filter(Boolean).slice(1).map(splitCsv);
}

function main() {
  const ledger = loadLedger();
  const byAttempt = new Map(ledger.map((row) => [row.attempt_id, row]));
  const runRows = [["run_id", "attempt_id", "method", "seed", "regime", "n", "outcome", "skew_c3_ms", "skew_c4_ms", "skew_c5_ms", "common_origin_bytes", "full_origin_bytes", "observation_rows", "pose_rows", "viewport_rows", "queued_rows", "demand_rows", "signaling_bytes", "log_complete", "p50_origin_ttfb_ms", "p95_origin_ttfb_ms", "q5_before_5s", "psnr_ssim", "availability_clients", "availability_requests"]];
  const clientRows = [["run_id", "client", "verdict", "skew_ms", "measurement_start", "measurement_end", "startup_trace_read_ms", "startup_parse_ms", "startup_camera_ms", "startup_settle_ms", "webgl_renderer", "gpu_memory_bytes", "viewport", "visible_timeline", "observation_rows"]];
  const cacheRows = [["run_id", "method", "requests", "hits", "misses", "merges", "evictions", "cache_bytes", "cache_entries", "namespace"]];
  const originRows = [["run_id", "common_origin_bytes", "c3_origin_bytes", "c4_origin_bytes", "full_origin_bytes", "origin_errors", "reason"]];
  const evictionRows = [["run_id", "evictions", "with_past_observation", "queued_by_other_user", "uses_future_trace_frame", "reason"]];
  const frameRows = [["run_id", "pairs_scored", "fidelity_claim", "q5_before_5s"]];
  const coverageRows = [["metric", "status", "reason"]];
  const failureRows = [["run_id", "outcome", "reason"]];
  let measuredOrigin = 0;
  let observationGaps = 0;
  const priorRuns = readDataRows("RUN_MASTER.csv");
  const skipIds = new Set();
  const skipRunIds = new Set();
  for (const row of priorRuns) {
    const attemptId = row[1];
    const outcome = row[6];
    const ledgerRow = byAttempt.get(attemptId);
    if (!attemptId || !outcome || outcome === "LAUNCHED") continue;
    if (ledgerRow && ledgerRow.outcome === "LAUNCHED") continue;
    skipIds.add(attemptId);
    skipRunIds.add(row[0]);
  }
  const kept = (name) => readDataRows(name).filter((row) => skipRunIds.has(row[0]));
  runRows.push(...priorRuns.filter((row) => skipIds.has(row[1])));
  clientRows.push(...kept("CLIENT_MASTER.csv"));
  cacheRows.push(...kept("CACHE_AND_INFLIGHT.csv"));
  originRows.push(...kept("ORIGIN_ACCOUNTING.csv"));
  evictionRows.push(...kept("ACTIONABLE_EVICTION.csv"));
  frameRows.push(...kept("FRAME_METRICS.csv"));
  failureRows.push(...readDataRows("FAILURE_EXCLUSIONS.csv").filter((row) => row[0] !== "NONE" && skipRunIds.has(row[0])));
  let fresh = 0;

  for (const cell of cells()) {
    const attemptId = path.basename(cell);
    if (skipIds.has(attemptId)) continue;
    fresh += 1;
    try {
    const ledgerRow = byAttempt.get(attemptId);
    const metricDir = path.join(cell, "metrics");
    if (!fs.existsSync(metricDir)) continue;
    const runDir = fs.readdirSync(metricDir)[0];
    if (!runDir) continue;
    const runId = ledgerRow ? ledgerRow.run_id : runDir;
    const specPath = path.join(metricDir, runDir, "cell_spec.json");
    const spec = fs.existsSync(specPath) ? readJson(specPath) : {};
    const clientIds = spec.clients ? Object.keys(spec.clients) : DEFAULT_CLIENTS;
    const clients = clientIds.map((id) => findClient(cell, runId, id));
    const proxyPath = path.join(cell, "evidence", runId, "S_runtime", "proxy.jsonl");
    const decisionPath = path.join(cell, "evidence", runId, "S_runtime", "proxy_decisions.jsonl");
    const proxyRows = readJsonl(proxyPath);
    const decisions = readJsonl(decisionPath);
    const starts = clients.map((client) => client.evidence && Date.parse(client.evidence.measurement_start)).filter(Number.isFinite);
    const ends = clients.map((client) => client.evidence && Date.parse(client.evidence.measurement_end)).filter(Number.isFinite);
    const commonStart = starts.length === clients.length && clients.length > 0 ? Math.max(...starts) : null;
    const commonEnd = ends.length === clients.length && clients.length > 0 ? Math.min(...ends) : null;
    const common = windowOrigin(proxyRows, null, commonStart, commonEnd);
    const fullBytes = proxyRows.reduce((sum, row) => sum + (Number(row.bytes_from_origin) || 0), 0);
    const c3Start = clients[0].evidence ? Date.parse(clients[0].evidence.measurement_start) : NaN;
    const c3End = clients[0].evidence ? Date.parse(clients[0].evidence.measurement_end) : NaN;
    const c4Start = clients[1] && clients[1].evidence ? Date.parse(clients[1].evidence.measurement_start) : NaN;
    const c4End = clients[1] && clients[1].evidence ? Date.parse(clients[1].evidence.measurement_end) : NaN;
    const c3 = windowOrigin(proxyRows, "user_C3_0", c3Start, c3End);
    const c4 = windowOrigin(proxyRows, "user_C4_1", c4Start, c4End);
    const observations = decisions.filter((row) => row.type === "client_observation");
    const poseRows = observations.filter((row) => Array.isArray(row.pose)).length;
    const viewportRows = observations.filter((row) => Array.isArray(row.viewport)).length;
    const queuedRows = observations.filter((row) => (row.queued_unsent || []).length > 0).length;
    const demandRows = observations.filter((row) => (row.renderer_demand || []).length > 0).length;
    const signaling = observations.reduce((sum, row) => sum + (Number(row.signaling_bytes) || 0), 0);
    const clientObs = clients.reduce((sum, client) => sum + client.observations, 0);
    const parseErrors = countParseErrors(proxyRows) + countParseErrors(decisions) + clients.reduce((sum, client) => sum + client.parseErrors, 0);
    const logComplete = parseErrors === 0 && clients.every((client) => client.startup) && decisions.length > 0 && (observations.length > 0 || clientObs > 0);
    const valid = clients.every((client) => client.evidence && client.evidence.verdict === "VALID" && Math.abs(client.skew) <= 3000);
    const residualInvalid = clients.some((client) => client.skew != null && Math.abs(client.skew) > 3000);
    const outcome = valid ? "CORE_VALID" : residualInvalid ? "INVALID_RESIDUAL" : "FAILED";
    if (ledgerRow) ledgerRow.outcome = outcome;
    const counts = { requests: 0, hits: 0, misses: 0, merges: 0, evictions: 0 };
    for (const row of decisions) {
      if (row.type === "request") counts.requests += 1;
      if (row.type === "cache_hit") counts.hits += 1;
      if (row.type === "cache_miss") counts.misses += 1;
      if (row.type === "inflight_merge") counts.merges += 1;
      if (row.type === "cache_eviction") counts.evictions += 1;
    }
    const evicts = decisions.filter((row) => row.type === "cache_eviction");
    const imagePath = path.join(metricDir, runDir, "IMAGE_METRICS.json");
    const image = fs.existsSync(imagePath) ? readJson(imagePath) : null;
    const originErrors = decisions.filter((row) => row.type === "origin_error").length;
    const requestCount = decisions.filter((row) => row.type === "request").length;
    const validClients = clients.filter((client) => client.evidence && client.evidence.verdict === "VALID" && Math.abs(client.skew) <= 3000).length;
    function skewCell(client) {
      if (!client) return "NOT_IN_CELL";
      return client.skew == null ? "NOT_MEASURED:no_skew" : client.skew;
    }
    runRows.push([
      runId, attemptId, spec.method || (ledgerRow && ledgerRow.method) || "", spec.seed || (ledgerRow && ledgerRow.seed) || "",
      spec.phase_regime || (ledgerRow && ledgerRow.regime) || "", clientIds.length, outcome,
      skewCell(clients.find((client) => client.id === "C3")),
      skewCell(clients.find((client) => client.id === "C4")),
      skewCell(clients.find((client) => client.id === "C5")),
      commonStart == null ? "NOT_MEASURED:no_common_window" : common.bytes,
      fullBytes, observations.length + clientObs, poseRows, viewportRows, queuedRows, demandRows, signaling,
      logComplete ? "COMPLETE" : "INCOMPLETE", pct(common.ttfb, 0.5), pct(common.ttfb, 0.95),
      "NOT_SAMPLED", image ? "UNVERIFIED" : "NOT_MEASURED:no_image_metrics",
      clients.length ? `${validClients}/${clients.length}` : "NOT_MEASURED:no_clients",
      requestCount ? `${requestCount - originErrors}/${requestCount}` : "NOT_MEASURED:no_requests",
    ]);
    clients.forEach((client) => {
      const machine = client.startup && client.startup.machine ? client.startup.machine : {};
      clientRows.push([
        runId, client.id, client.evidence ? client.evidence.verdict : (client.error ? client.error.verdict || "ERROR" : "MISSING"),
        client.skew == null ? "NOT_MEASURED:no_skew" : client.skew,
        client.evidence ? client.evidence.measurement_start : "NOT_MEASURED:no_evidence",
        client.evidence ? client.evidence.measurement_end : "NOT_MEASURED:no_evidence",
        client.startup ? client.startup.trace_file_read_ms : "NOT_MEASURED:no_startup",
        client.startup ? client.startup.parse_ms : "NOT_MEASURED:no_startup",
        client.startup ? client.startup.camera_conversion_ms : "NOT_MEASURED:no_startup",
        client.startup ? client.startup.renderer_settle_ms : "NOT_MEASURED:no_startup",
        machine.webgl_renderer || "NOT_MEASURED:no_webgl",
        machine.gpu_memory_bytes == null ? `NOT_MEASURED:${machine.gpu_memory_reason || "not_sampled"}` : machine.gpu_memory_bytes,
        machine.viewport ? machine.viewport.join("x") : "NOT_MEASURED:no_viewport",
        client.evidence && client.evidence.visual_sampling ? client.evidence.visual_sampling.timeline_samples : "NOT_MEASURED:no_timeline",
        client.observations,
      ]);
    });
    cacheRows.push([runId, spec.method || "", counts.requests, counts.hits, counts.misses, counts.merges, counts.evictions, spec.cache_max_bytes || 52428800, spec.cache_max_entries || 100, spec.method === "IND" ? "PER_USER_FIFO" : "SHARED"]);
    originRows.push([runId, commonStart == null ? "NOT_MEASURED:no_common_window" : common.bytes, c3.bytes, c4.bytes, fullBytes, decisions.filter((row) => row.type === "origin_error").length, valid ? "MEASURED" : outcome]);
    evictionRows.push([
      runId, evicts.length, evicts.filter((row) => Number(row.past_observation_count) > 0).length,
      evicts.filter((row) => row.queued_by_other_user === true).length,
      evicts.some((row) => row.uses_future_trace_frame === true),
      evicts.length ? "MEASURED" : "NOT_MEASURED:no_eviction",
    ]);
    frameRows.push([runId, image && image.pairs != null ? image.pairs : "NOT_MEASURED:no_image_metrics", image ? "UNVERIFIED" : "NOT_MEASURED:no_reference_provenance", "NOT_SAMPLED"]);
    if (!valid) failureRows.push([runId, outcome, residualInvalid ? "residual_abs_gt_3000" : "client_or_collection_failed"]);
    if (attemptId === "c17_n2_lru_orbit_synchronized_seed27190021" || attemptId === "c18_n2_lru_orbit_staggered_seed27190022") {
      const shadow = decisions.length ? replayDecisions(decisions) : null;
      fs.writeFileSync(path.join(cell, "SHADOW_REPLAY.json"), JSON.stringify(shadow, null, 2));
    }
    } catch (error) {
      const ledgerRow = byAttempt.get(attemptId);
      if (ledgerRow && ledgerRow.outcome === "LAUNCHED") ledgerRow.outcome = "FAILED";
      const runId = ledgerRow ? ledgerRow.run_id : attemptId;
      failureRows.push([runId, "FAILED", `SEAL_CELL_ERROR:${String(error.message).replace(/[\r\n,]/g, " ").slice(0, 180)}`]);
    }
  }

  const sealedRows = runRows.slice(1);
  measuredOrigin = sealedRows.filter((row) => row[6] === "CORE_VALID").length;
  observationGaps = sealedRows.filter((row) => row[18] === "INCOMPLETE").length;
  coverageRows.push(
    ["measurement_origin_bytes", measuredOrigin ? "MEASURED_ON_CORE_VALID_PAIRS" : "NOT_MEASURED:no_core_valid_pair", `core_valid_cells=${measuredOrigin}`],
    ["residual_3000ms", "ENFORCED", "abs skew > 3000 remains invalid"],
    ["client_observation", observationGaps ? "PARTIAL" : "MEASURED", `incomplete_cells=${observationGaps}`],
    ["pose_viewport_queue_demand", "MEASURED_WHEN_PRESENT", "absent values stay explicit nulls inside observation rows"],
    ["psnr_ssim", "UNVERIFIED", "scores are not reference-fidelity proof"],
    ["q5_before_5s", "NOT_SAMPLED", "no zero fill"],
    ["gpu_memory", "NOT_MEASURED:WEBGL_DOES_NOT_EXPOSE_MEMORY", "renderer string is sampled"],
    ["spade_efficacy", "NOT_CONFIRMED", "freeze waits for independent holdout"],
  );
  write("RUN_MASTER.csv", runRows);
  write("CLIENT_MASTER.csv", clientRows);
  write("CACHE_AND_INFLIGHT.csv", cacheRows);
  write("ORIGIN_ACCOUNTING.csv", originRows);
  write("ACTIONABLE_EVICTION.csv", evictionRows);
  write("FRAME_METRICS.csv", frameRows);
  write("METRIC_COVERAGE.csv", coverageRows);
  write("FAILURE_EXCLUSIONS.csv", failureRows.length > 1 ? failureRows : [["run_id", "outcome", "reason"], ["NONE", "NONE", "no_failed_cell"]]);
  if (ledger.length) {
    const lines = ["attempt_seq,attempt_id,run_id,method,seed,n,regime,started_at,outcome,evidence"];
    for (const row of ledger) lines.push([row.attempt_seq, row.attempt_id, row.run_id, row.method, row.seed, row.n, row.regime, row.started_at, row.outcome, row.evidence].join(","));
    fs.writeFileSync(LEDGER, lines.join("\n") + "\n");
  }
  const names = ["RUN_MASTER.csv", "CLIENT_MASTER.csv", "CACHE_AND_INFLIGHT.csv", "ORIGIN_ACCOUNTING.csv", "ACTIONABLE_EVICTION.csv", "FRAME_METRICS.csv", "METRIC_COVERAGE.csv", "FAILURE_EXCLUSIONS.csv", "PHYSICAL_ATTEMPT_LEDGER.csv", "PREREGISTERED_CANDIDATE.json"];
  const hashes = [["file", "sha256", "bytes"]];
  for (const name of names) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) continue;
    const bytes = fs.readFileSync(file);
    hashes.push([name, crypto.createHash("sha256").update(bytes).digest("hex"), bytes.length]);
  }
  write("OUTPUT_SHA256.csv", hashes);
  console.log(`SEALED cells=${runRows.length - 1} fresh=${fresh} reused=${skipIds.size}`);
}

main();
