"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = "F:/WWW_N3_MUX/research_control/SPADE_REUSE_AND_EXECUTE_20261019";
const CLIENTS = ["C3", "C4"];
const BLOCK = [
  { attempt: "bq1_n2_lru_stop_go_synchronized_seed27190001", method: "LRU", seed: 27190001, n: 2, regime: "synchronized", trace: "stop_go", comparable_budget: true },
  { attempt: "bq2_n2_fifo_stop_go_synchronized_seed27190001", method: "FIFO", seed: 27190001, n: 2, regime: "synchronized", trace: "stop_go", comparable_budget: true },
  { attempt: "bq3_n2_sieve_stop_go_synchronized_seed27190001", method: "SIEVE", seed: 27190001, n: 2, regime: "synchronized", trace: "stop_go", comparable_budget: true },
  { attempt: "bq4_n2_s3fifo_stop_go_synchronized_seed27190001", method: "S3-FIFO", seed: 27190001, n: 2, regime: "synchronized", trace: "stop_go", comparable_budget: true },
  { attempt: "bq5_n2_ind_stop_go_synchronized_seed27190001", method: "IND", seed: 27190001, n: 2, regime: "synchronized", trace: "stop_go", comparable_budget: false },
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\n/).filter(Boolean).map((line) => JSON.parse(line));
}
function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function writeCsv(file, header, rows) {
  const body = [header.join(","), ...rows.map((row) => header.map((key) => csvCell(row[key])).join(","))].join("\n") + "\n";
  fs.writeFileSync(file, body, { encoding: "utf8" });
}
function ownerOf(userId) {
  const text = String(userId || "");
  if (text.includes("C3")) return "C3";
  if (text.includes("C4")) return "C4";
  return "UNATTRIBUTABLE";
}
function clientDir(evidenceRoot, id) {
  const nested = path.join(evidenceRoot, id, id);
  if (fs.existsSync(path.join(nested, `${id}_evidence.json`))) return nested;
  return path.join(evidenceRoot, id);
}
function inWindow(ms, start, end) {
  return Number.isFinite(ms) && Number.isFinite(start) && Number.isFinite(end) && ms >= start && ms <= end;
}

function loadCell(spec) {
  const wave = path.join(ROOT, "cells", spec.attempt);
  const runId = fs.readdirSync(path.join(wave, "evidence"))[0];
  const evidenceRoot = path.join(wave, "evidence", runId);
  const runtime = path.join(evidenceRoot, "S_runtime");
  const decisions = readJsonl(path.join(runtime, "proxy_decisions.jsonl"));
  const served = readJsonl(path.join(runtime, "proxy.jsonl"));
  const contract = fs.existsSync(path.join(runtime, "runtime_contract.json")) ? readJson(path.join(runtime, "runtime_contract.json")) : {};
  const image = fs.existsSync(path.join(wave, "metrics", runId, "IMAGE_METRICS.json"))
    ? readJson(path.join(wave, "metrics", runId, "IMAGE_METRICS.json"))
    : { psnr_measured: 0, pairs_total: 0, rows: [] };
  const clients = {};
  for (const id of CLIENTS) {
    const dir = clientDir(evidenceRoot, id);
    const evidenceFile = path.join(dir, `${id}_evidence.json`);
    const errorFile = path.join(dir, `${id}_error.json`);
    clients[id] = {
      dir,
      evidence: fs.existsSync(evidenceFile) ? readJson(evidenceFile) : null,
      error: fs.existsSync(errorFile) ? readJson(errorFile) : null,
    };
  }
  return { spec, runId, wave, decisions, served, contract, image, clients };
}

function windowsOf(cell) {
  const starts = [];
  const ends = [];
  for (const id of CLIENTS) {
    const evidence = cell.clients[id].evidence;
    if (!evidence || !evidence.measurement_start || !evidence.measurement_end) continue;
    starts.push(Date.parse(evidence.measurement_start));
    ends.push(Date.parse(evidence.measurement_end));
  }
  if (starts.length !== 2) return { ok: false };
  const unionStart = Math.min(...starts);
  const unionEnd = Math.max(...ends);
  const commonStart = Math.max(...starts);
  const commonEnd = Math.min(...ends);
  return {
    ok: commonEnd > commonStart,
    unionStart,
    unionEnd,
    commonStart,
    commonEnd,
  };
}

function tally(cell) {
  const win = windowsOf(cell);
  const counts = {
    request: 0, cache_hit: 0, inflight_merge: 0, cache_miss: 0, cache_eviction: 0, origin_error: 0,
    origin_response: 0, origin_bytes: 0, version_proven: 0, version_unconfirmed: 0,
  };
  const meas = {
    request: 0, cache_hit: 0, inflight_merge: 0, cache_miss: 0, cache_eviction: 0,
    origin_response: 0, origin_bytes: 0, c3: 0, c4: 0, unattributable: 0,
  };
  const union = { origin_bytes: 0, c3: 0, c4: 0 };
  const warmup = { origin_bytes: 0 };
  const reasons = {};
  let divergent = 0;
  for (const row of cell.decisions) {
    const ms = Number(row.origin_end_ms || row.timestamp);
    if (row.type === "request") counts.request += 1;
    if (row.type === "cache_hit") counts.cache_hit += 1;
    if (row.type === "inflight_merge") counts.inflight_merge += 1;
    if (row.type === "cache_miss") counts.cache_miss += 1;
    if (row.type === "origin_error") counts.origin_error += 1;
    if (row.type === "version_observation") {
      if (row.version_proven === true) counts.version_proven += 1;
      else counts.version_unconfirmed += 1;
    }
    if (row.type === "cache_eviction") {
      counts.cache_eviction += 1;
      reasons[row.reason || "NONE"] = (reasons[row.reason || "NONE"] || 0) + 1;
      if (row.lru_head && row.cache_key && row.cache_key !== row.lru_head) divergent += 1;
    }
    if (row.type === "origin_response") {
      const bytes = Number(row.bytes) || 0;
      const owner = ownerOf(row.user_id);
      counts.origin_response += 1;
      counts.origin_bytes += bytes;
      if (win.ok && inWindow(ms, win.unionStart, win.unionEnd)) {
        union.origin_bytes += bytes;
        if (owner === "C3") union.c3 += bytes;
        else if (owner === "C4") union.c4 += bytes;
      }
      if (win.ok && inWindow(ms, win.commonStart, win.commonEnd)) {
        meas.origin_response += 1;
        meas.origin_bytes += bytes;
        if (owner === "C3") meas.c3 += bytes;
        else if (owner === "C4") meas.c4 += bytes;
        else meas.unattributable += bytes;
      } else if (win.ok && Number.isFinite(ms) && ms < win.commonStart) {
        warmup.origin_bytes += bytes;
      }
    }
    if (win.ok && inWindow(ms, win.commonStart, win.commonEnd)) {
      if (row.type === "request") meas.request += 1;
      if (row.type === "cache_hit") meas.cache_hit += 1;
      if (row.type === "inflight_merge") meas.inflight_merge += 1;
      if (row.type === "cache_miss") meas.cache_miss += 1;
      if (row.type === "cache_eviction") meas.cache_eviction += 1;
    }
  }
  const servedOrigin = cell.served.reduce((sum, row) => sum + (Number(row.bytes_from_origin) || 0), 0);
  return { win, counts, meas, union, warmup, reasons, divergent, servedOrigin };
}

function t60(image, client) {
  const row = (image.rows || []).find((item) => item.client === client && Number(item.checkpoint_s) === 60);
  if (!row || row.psnr === null || row.psnr === undefined) return { psnr: "NOT_MEASURED", ssim: "NOT_MEASURED", status: "NOT_MEASURED" };
  return { psnr: row.psnr, ssim: row.ssim, status: row.status };
}

function coreOk(cell, stats) {
  return CLIENTS.every((id) => cell.clients[id].evidence && cell.clients[id].evidence.verdict === "VALID")
    && stats.win.ok
    && stats.counts.origin_bytes === stats.servedOrigin
    && stats.counts.origin_error === 0
    && CLIENTS.every((id) => {
      const skew = cell.clients[id].evidence.measurement_start_skew_ms;
      return typeof skew === "number" && Math.abs(skew) <= 3000;
    });
}

const cells = BLOCK.map(loadCell);
const statsByMethod = {};
for (const cell of cells) statsByMethod[cell.spec.method] = { cell, stats: tally(cell) };
const lruBytes = statsByMethod.LRU.stats.meas.origin_bytes;

const runRows = [];
const clientRows = [];
const cacheRows = [];
const coverageRows = [];

for (const spec of BLOCK) {
  const pack = statsByMethod[spec.method];
  const cell = pack.cell;
  const stats = pack.stats;
  const ok = coreOk(cell, stats);
  const imageMeasured = Number(cell.image.psnr_measured) || 0;
  const imageTotal = Number(cell.image.pairs_total) || 0;
  const c3t60 = t60(cell.image, "C3");
  const c4t60 = t60(cell.image, "C4");
  const delta = spec.comparable_budget && ok ? stats.meas.origin_bytes - lruBytes : "NOT_COMPARABLE";
  const deltaPct = spec.comparable_budget && ok && lruBytes ? (stats.meas.origin_bytes - lruBytes) / lruBytes : "NOT_COMPARABLE";
  const qoeClaim = (typeof c3t60.ssim === "number" && c3t60.ssim >= 0.5 && typeof c4t60.ssim === "number" && c4t60.ssim >= 0.5)
    ? "T60_ONLY"
    : "FORBIDDEN";
  runRows.push({
    attempt_id: spec.attempt,
    run_id: cell.runId,
    method: spec.method,
    seed: spec.seed,
    n: spec.n,
    regime: spec.regime,
    trace: spec.trace,
    pair_valid: ok,
    comparable_budget: spec.comparable_budget,
    origin_bytes_raw: stats.counts.origin_bytes,
    served_origin_bytes: stats.servedOrigin,
    origin_match: stats.counts.origin_bytes === stats.servedOrigin,
    measurement_origin_bytes: stats.win.ok ? stats.meas.origin_bytes : "",
    measurement_c3: stats.win.ok ? stats.meas.c3 : "",
    measurement_c4: stats.win.ok ? stats.meas.c4 : "",
    measurement_unattributable: stats.win.ok ? stats.meas.unattributable : "",
    warmup_bytes: stats.win.ok ? stats.warmup.origin_bytes : "",
    union_origin_bytes: stats.win.ok ? stats.union.origin_bytes : "",
    hit: stats.meas.cache_hit,
    inflight_merge: stats.meas.inflight_merge,
    miss: stats.meas.cache_miss,
    evictions: stats.meas.cache_eviction,
    requests: stats.meas.request,
    divergent_victims: stats.divergent,
    origin_errors: stats.counts.origin_error,
    version_proven_events: stats.counts.version_proven,
    version_unconfirmed_events: stats.counts.version_unconfirmed,
    psnr_pairs_measured: imageMeasured,
    psnr_pairs_total: imageTotal,
    psnr_t60_c3: c3t60.psnr,
    ssim_t60_c3: c3t60.ssim,
    psnr_t60_c4: c4t60.psnr,
    ssim_t60_c4: c4t60.ssim,
    delta_origin_vs_lru: delta,
    delta_pct_vs_lru: deltaPct,
    cache_namespace: cell.contract.cache_namespace || "SHARED_50MIB_100",
    qoe_claim: qoeClaim,
  });
  cacheRows.push({
    method: spec.method,
    pair_valid: ok,
    comparable_budget: spec.comparable_budget,
    requests: stats.meas.request,
    cache_hit: stats.meas.cache_hit,
    inflight_merge: stats.meas.inflight_merge,
    cache_miss: stats.meas.cache_miss,
    evictions: stats.meas.cache_eviction,
    hit_rate: stats.meas.request ? stats.meas.cache_hit / stats.meas.request : "",
    inflight_rate: stats.meas.request ? stats.meas.inflight_merge / stats.meas.request : "",
    accounting_ok: stats.meas.cache_hit + stats.meas.cache_miss + stats.meas.inflight_merge === stats.meas.request,
    divergent_victims: stats.divergent,
    eviction_reasons: JSON.stringify(stats.reasons),
    origin_responses_meas: stats.meas.origin_response,
    measurement_origin_bytes: stats.win.ok ? stats.meas.origin_bytes : "",
    origin_bytes_all: stats.counts.origin_bytes,
    served_origin_bytes: stats.servedOrigin,
    origin_match: stats.counts.origin_bytes === stats.servedOrigin,
    delta_origin_vs_lru: delta,
  });
  coverageRows.push({
    method: spec.method,
    core: ok ? "PASS" : "FAIL",
    image: imageMeasured > 0 ? "MEASURED" : "NOT_MEASURED",
    psnr_pairs_measured: imageMeasured,
    psnr_pairs_total: imageTotal,
    qoe_claim: qoeClaim,
    paired_effect: spec.comparable_budget && ok ? "MATCHED_BLOCK_27190001_STOP_GO_SYNC" : (spec.method === "IND" ? "ARCHITECTURAL_CONTEXT_NOT_BUDGET_MATCHED" : "NOT_COMPARABLE"),
    freeze_eligible: "NO",
    freeze_reason: spec.method === "IND" ? "IND_NOT_BUDGET_MATCHED" : (!ok ? "CORE_NOT_PASS" : "NO_SPADE_CANDIDATE_IN_BLOCK"),
  });
  for (const id of CLIENTS) {
    const evidence = cell.clients[id].evidence;
    const err = cell.clients[id].error;
    const img = t60(cell.image, id);
    clientRows.push({
      attempt_id: spec.attempt,
      method: spec.method,
      client: id,
      verdict: evidence ? evidence.verdict : (err && err.verdict) || "MISSING",
      skew_ms: evidence ? evidence.measurement_start_skew_ms : "",
      measurement_start: evidence ? evidence.measurement_start : "",
      measurement_end: evidence ? evidence.measurement_end : "",
      rad_206: evidence && evidence.network ? evidence.network.rad_206_count : "",
      frames_replayed: evidence && evidence.trace_replay ? evidence.trace_replay.frames_replayed_final : "",
      visual_ready_ms: evidence ? evidence.visual_ready_ms : "",
      worker_sha256: evidence ? evidence.worker_sha256 : "",
      trace_sha256: evidence ? evidence.trace_sha256 : "",
      psnr_t60: img.psnr,
      ssim_t60: img.ssim,
      error: err ? String(err.error || "").slice(0, 240) : "",
    });
  }
}

coverageRows.push({
  method: "SPADE",
  core: "NOT_EXECUTED",
  image: "NOT_MEASURED",
  psnr_pairs_measured: 0,
  psnr_pairs_total: 0,
  qoe_claim: "FORBIDDEN",
  paired_effect: "NOT_EXECUTED_NO_CONFIRMED_SPADE",
  freeze_eligible: "NO",
  freeze_reason: "NO_FROZEN_CANDIDATE_AND_NO_MATCHED_SPADE_CELL_IN_BLOCK",
});

writeCsv(path.join(ROOT, "RUN_MASTER.csv"), Object.keys(runRows[0]), runRows);
writeCsv(path.join(ROOT, "13_RUN_MASTER.csv"), Object.keys(runRows[0]), runRows);
writeCsv(path.join(ROOT, "CLIENT_MASTER.csv"), Object.keys(clientRows[0]), clientRows);
writeCsv(path.join(ROOT, "14_CLIENT_MASTER.csv"), Object.keys(clientRows[0]), clientRows);
writeCsv(path.join(ROOT, "CACHE_AND_INFLIGHT.csv"), Object.keys(cacheRows[0]), cacheRows);
writeCsv(path.join(ROOT, "METRIC_COVERAGE.csv"), Object.keys(coverageRows[0]), coverageRows);
writeCsv(path.join(ROOT, "15_METRIC_COVERAGE.csv"), Object.keys(coverageRows[0]), coverageRows);

const summary = {
  block: "seed=27190001 N=2 stop_go synchronized coit-40m-sh1-lod 50MiB/100",
  methods: BLOCK.map((row) => row.method),
  lru_measurement_origin_bytes: lruBytes,
  spade: "NOT_EXECUTED",
  freeze_eligible: false,
};
fs.writeFileSync(path.join(ROOT, "COMPARISON_BLOCK_27190001.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ wrote: ["RUN_MASTER.csv", "CLIENT_MASTER.csv", "CACHE_AND_INFLIGHT.csv", "METRIC_COVERAGE.csv"], lruBytes, methods: BLOCK.map((row) => row.method) }));
