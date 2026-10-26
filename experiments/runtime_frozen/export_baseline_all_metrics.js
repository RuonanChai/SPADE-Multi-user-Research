"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "BASELINE_ALL_METRICS.csv");
const CLIENTS = ["C3", "C4", "C5"];
const USER = { C3: "user_C3_0", C4: "user_C4_1", C5: "user_C5_2" };

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch (error) { rows.push({ type: "PARSE_ERROR" }); }
  }
  return rows;
}
function num(value) {
  if (value == null || value === "" || String(value).startsWith("NOT_")) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function median(values) {
  const nums = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!nums.length) return "";
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}
function round(value, digits) {
  if (!Number.isFinite(value)) return "";
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
function pct(values, p) {
  const nums = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!nums.length) return "";
  return nums[Math.min(nums.length - 1, Math.max(0, Math.ceil(nums.length * p) - 1))];
}
function csvCell(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, "\"\"")}"`;
  return text;
}
function sceneOf(runId) {
  if (runId.includes("hobbiton")) return "hobbiton";
  if (runId.includes("poland")) return "poland";
  if (runId.includes("cozy")) return "cozy";
  if (runId.includes("coit")) return "coit";
  return "";
}
function traceOf(runId) {
  if (runId.includes("burst_turn")) return "burst_turn";
  if (runId.includes("random_walk")) return "random_walk";
  if (runId.includes("stop_go")) return "stop_go";
  if (runId.includes("orbit")) return "orbit";
  return "";
}
function rangeOf(text) {
  const match = String(text || "").match(/(\d+)-(\d+)/);
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]) };
}
function overlapBytes(range, prior) {
  const start = Math.max(range.start, prior.start);
  const end = Math.min(range.end, prior.end);
  return end >= start ? end - start + 1 : 0;
}
function poseStats(file) {
  if (!file || !fs.existsSync(file)) return { status: "MISSING", frames: 0, exact_zero: 0, placed_spread: "", max_deviation: "" };
  const frames = readJson(file).frames || [];
  const positions = frames.map((frame) => frame.pose && frame.pose.position).filter((position) => Array.isArray(position) && position.length === 3);
  const exact = (position) => position[0] === 0 && position[1] === 0 && position[2] === 0;
  const zeros = positions.filter(exact);
  const placed = positions.filter((position) => !exact(position));
  let spread = 0;
  let deviation = 0;
  if (placed.length) {
    const anchor = placed[0];
    for (const position of placed) {
      const distance = Math.hypot(position[0] - anchor[0], position[1] - anchor[1], position[2] - anchor[2]);
      if (distance > spread) spread = distance;
    }
  }
  if (positions.length) {
    const first = positions[0];
    for (const position of positions) {
      const distance = Math.hypot(position[0] - first[0], position[1] - first[1], position[2] - first[2]);
      if (distance > deviation) deviation = distance;
    }
  }
  let status = "MISSING";
  if (!positions.length) status = "NO_POSITIONS";
  else if (placed.length && zeros.length && spread < 0.2) status = "POSE_DISCONTINUOUS";
  else if (!placed.length || spread < 0.2) status = "COLLAPSED";
  else if (zeros.length) status = "ORIGIN_HOLES";
  else status = "PRESENT";
  return { status, frames: positions.length, exact_zero: zeros.length, placed_spread: round(spread, 4), max_deviation: round(deviation, 4) };
}
function ledgerRows() {
  const file = path.join(ROOT, "PHYSICAL_ATTEMPT_LEDGER.csv");
  return fs.readFileSync(file, "utf8").split(/\n/).filter(Boolean).slice(1).map((line) => {
    const parts = line.split(",");
    return {
      attempt_seq: Number(parts[0]),
      attempt_id: parts[1],
      run_id: parts[2],
      method: parts[3],
      seed: parts[4],
      n: Number(parts[5]),
      regime: parts[6],
      started_at: parts[7],
      outcome: parts[8],
    };
  });
}
function latestAttempts() {
  const latest = new Map();
  const byAttempt = new Map();
  const file = path.join(ROOT, "ATTEMPT_LOGICAL.jsonl");
  for (const line of fs.readFileSync(file, "utf8").split(/\n/).filter(Boolean)) {
    const row = JSON.parse(line);
    byAttempt.set(row.attempt, row.logical_id);
    const prev = latest.get(row.logical_id);
    if (!prev || Number(row.seq) >= Number(prev.seq)) latest.set(row.logical_id, row);
  }
  return { byAttempt, latestIds: new Set([...latest.values()].map((row) => row.attempt)) };
}
function sealedOrigin() {
  const file = path.join(ROOT, "RUN_MASTER.csv");
  const lines = fs.readFileSync(file, "utf8").trim().split(/\n/);
  const header = lines[0].split(",");
  const map = new Map();
  for (const line of lines.slice(1)) {
    const parts = line.split(",");
    const record = {};
    header.forEach((name, index) => { record[name] = parts[index]; });
    map.set(record.attempt_id, record);
  }
  return map;
}
function resourceSummary(evidence, clients) {
  const per = {};
  const allCpu = [];
  const allGpu = [];
  const allMem = [];
  let files = 0;
  for (const client of clients) {
    const file = path.join(evidence, client, client, `${client}_resource_1hz.jsonl`);
    const samples = readJsonl(file).filter((row) => row.type !== "PARSE_ERROR");
    if (fs.existsSync(file)) files += 1;
    const cpu = samples.map((row) => Number(row.cpu_percent)).filter(Number.isFinite);
    const gpu = samples.map((row) => Number(row.gpu_util_percent)).filter(Number.isFinite);
    const mem = samples.map((row) => Number(row.gpu_memory_used_mb)).filter(Number.isFinite);
    per[client] = { cpu: median(cpu), gpu: median(gpu), mem: median(mem), n: samples.length };
    allCpu.push(...cpu);
    allGpu.push(...gpu);
    allMem.push(...mem);
  }
  const status = files === 0 ? "NOT_MEASURED:no_resource_file" : (allCpu.length || allGpu.length) ? "MEASURED" : "NOT_MEASURED:samples_null";
  return { per, cpu: median(allCpu), gpu: median(allGpu), mem: median(allMem), samples: allCpu.length || allGpu.length || allMem.length, status };
}
function analyze(row) {
  const cell = path.join(ROOT, "cells", row.attempt_id);
  const runId = row.run_id;
  const specPath = path.join(cell, "metrics", runId, "cell_spec.json");
  const spec = fs.existsSync(specPath) ? readJson(specPath) : {};
  const expected = spec.clients ? Object.keys(spec.clients) : CLIENTS.slice(0, row.n || 2);
  const evidenceRoot = path.join(cell, "evidence", runId);
  const evidence = {};
  const errors = {};
  const startup = {};
  const pose = {};
  for (const client of expected) {
    const base = path.join(evidenceRoot, client, client);
    const evidencePath = path.join(base, `${client}_evidence.json`);
    const errorPath = path.join(base, `${client}_error.json`);
    const startupPath = path.join(base, "STARTUP_STAGES.json");
    evidence[client] = fs.existsSync(evidencePath) ? readJson(evidencePath) : null;
    errors[client] = fs.existsSync(errorPath) ? (readJson(errorPath).error || "") : "";
    startup[client] = fs.existsSync(startupPath) ? readJson(startupPath) : null;
    pose[client] = poseStats(path.join(base, "canvas_pose_manifest.json"));
  }
  const proxyPath = path.join(evidenceRoot, "S_runtime", "proxy.jsonl");
  const decisionPath = path.join(evidenceRoot, "S_runtime", "proxy_decisions.jsonl");
  const proxy = readJsonl(proxyPath).filter((item) => item.type !== "PARSE_ERROR");
  const decisions = readJsonl(decisionPath).filter((item) => item.type !== "PARSE_ERROR");
  const starts = expected.map((client) => evidence[client] && Date.parse(evidence[client].measurement_start)).filter(Number.isFinite);
  const ends = expected.map((client) => evidence[client] && Date.parse(evidence[client].measurement_end)).filter(Number.isFinite);
  const commonStart = starts.length === expected.length && expected.length ? Math.max(...starts) : null;
  const commonEnd = ends.length === expected.length && expected.length ? Math.min(...ends) : null;
  const inWindow = (stamp) => commonStart != null && commonEnd != null && stamp >= commonStart && stamp <= commonEnd;
  let proxyOrigin = 0;
  const ttfb = [];
  const fullOrigin = proxy.reduce((sum, item) => sum + (Number(item.bytes_from_origin) || 0), 0);
  const byRequest = new Map();
  for (const item of proxy) {
    if (item.request_id) byRequest.set(item.request_id, item);
    const stamp = Number(item.timestamp || item.request_start_ms);
    if (!inWindow(stamp)) continue;
    proxyOrigin += Number(item.bytes_from_origin) || 0;
    if (Number.isFinite(item.origin_ttfb_ms)) ttfb.push(Number(item.origin_ttfb_ms));
  }
  const perClient = {};
  for (const client of CLIENTS) {
    if (!expected.includes(client)) { perClient[client] = ""; continue; }
    const start = evidence[client] ? Date.parse(evidence[client].measurement_start) : NaN;
    const end = evidence[client] ? Date.parse(evidence[client].measurement_end) : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end)) { perClient[client] = ""; continue; }
    let bytes = 0;
    for (const item of proxy) {
      const stamp = Number(item.timestamp || item.request_start_ms);
      if (stamp < start || stamp > end) continue;
      if (item.user_id && item.user_id !== USER[client]) continue;
      bytes += Number(item.bytes_from_origin) || 0;
    }
    perClient[client] = bytes;
  }
  const keyState = new Map();
  const completedRanges = [];
  const reuse = { completion_origin_bytes: 0, resident_hit_bytes: 0, cross_user_hit_bytes: 0, inflight_bytes: 0, first_origin_bytes: 0, eviction_refetch_bytes: 0, refetch_without_eviction_bytes: 0, partial_overlap_bytes: 0, evictions: 0, demand_rows: 0, future_frames: 0 };
  const viewports = new Map();
  for (const item of decisions) {
    if (item.uses_future_trace_frame === true) reuse.future_frames += 1;
    if (item.type === "cache_eviction") reuse.evictions += 1;
    if (item.type === "client_observation") {
      if ((item.renderer_demand || []).length) reuse.demand_rows += 1;
      if (Array.isArray(item.viewport)) viewports.set(item.viewport.join("x"), (viewports.get(item.viewport.join("x")) || 0) + 1);
    }
    const stamp = Number(item.origin_end_ms || item.timestamp || item.request_start_ms);
    const counted = inWindow(stamp);
    const key = item.cache_key || "";
    const proxyRow = byRequest.get(item.request_id) || {};
    const served = Number(proxyRow.bytes_to_client) || Number(item.bytes) || 0;
    if (item.type === "origin_response") {
      const bytes = Number(item.bytes) || 0;
      if (counted) reuse.completion_origin_bytes += bytes;
      const state = keyState.get(key);
      if (!state) {
        if (counted) reuse.first_origin_bytes += bytes;
        keyState.set(key, { users: new Set([item.user_id]), evicted: false });
      } else if (state.evicted) {
        if (counted) reuse.eviction_refetch_bytes += bytes;
        state.evicted = false;
        state.users.add(item.user_id);
      } else {
        if (counted) reuse.refetch_without_eviction_bytes += bytes;
        state.users.add(item.user_id);
      }
      const range = rangeOf(item.content_range || item.range);
      if (range) {
        let overlapped = 0;
        for (const prior of completedRanges) {
          if (prior.key === key) continue;
          overlapped += overlapBytes(range, prior);
        }
        if (counted) reuse.partial_overlap_bytes += overlapped;
        completedRanges.push({ key, start: range.start, end: range.end });
      }
    } else if (item.type === "cache_eviction") {
      const state = keyState.get(key);
      if (state) state.evicted = true;
    } else if (item.type === "cache_hit") {
      const state = keyState.get(key);
      const cross = state && item.user_id && !state.users.has(item.user_id);
      if (counted) {
        if (cross) reuse.cross_user_hit_bytes += served;
        else reuse.resident_hit_bytes += served;
      }
    } else if (item.type === "inflight_merge" && counted) reuse.inflight_bytes += served;
  }
  const poseStatuses = expected.map((client) => pose[client].status);
  let poseStatus = "PRESENT";
  if (poseStatuses.some((status) => status === "MISSING" || status === "NO_POSITIONS")) poseStatus = "MISSING_CLIENT_POSE";
  else if (poseStatuses.some((status) => status === "POSE_DISCONTINUOUS")) poseStatus = "POSE_DISCONTINUOUS";
  else if (poseStatuses.some((status) => status === "COLLAPSED")) poseStatus = "COLLAPSED";
  else if (poseStatuses.some((status) => status === "ORIGIN_HOLES")) poseStatus = "ORIGIN_HOLES";
  const imagePath = path.join(cell, "metrics", runId, "IMAGE_METRICS.json");
  const image = fs.existsSync(imagePath) ? readJson(imagePath) : null;
  const proven = image && Array.isArray(image.rows) ? image.rows.filter((item) => item.proven === true && Number.isFinite(Number(item.psnr)) && Number.isFinite(Number(item.ssim))) : [];
  const measuredRows = image && Array.isArray(image.rows) ? image.rows.filter((item) => item.status === "MEASURED" && Number.isFinite(Number(item.psnr)) && Number.isFinite(Number(item.ssim))).length : 0;
  const skew = {};
  for (const client of CLIENTS) {
    if (!expected.includes(client)) { skew[client] = "NOT_IN_CELL"; continue; }
    const value = evidence[client] && Number.isFinite(evidence[client].measurement_start_skew_ms) ? evidence[client].measurement_start_skew_ms : null;
    if (value == null && String(errors[client]).includes("MEASUREMENT_START_SKEW_INVALID")) skew[client] = String(errors[client]).split(":").pop();
    else skew[client] = value == null ? "" : value;
  }
  const residualOk = expected.every((client) => num(skew[client]) != null && Math.abs(num(skew[client])) <= 3000);
  const viewport = [...viewports.entries()].sort((a, b) => b[1] - a[1])[0];
  const c3 = evidence.C3 || {};
  const resources = resourceSummary(evidenceRoot, expected);
  return {
    spec, expected, proxyPresent: fs.existsSync(proxyPath), commonStart, proxyOrigin, fullOrigin, perClient, ttfb, reuse, pose, poseStatus,
    psnr: round(median(proven.map((item) => Number(item.psnr))), 3),
    ssim: round(median(proven.map((item) => Number(item.ssim))), 4),
    provenPairs: proven.length,
    measuredRows,
    referenceProven: proven.filter((item) => item.completeness_status === "FULL_VIEW_REFERENCE_PROVEN").length,
    skew, residualOk, viewport: viewport ? viewport[0] : "NOT_RECORDED",
    trace: spec.trace || c3.trace || traceOf(runId),
    scene: sceneOf(runId),
    cache_bytes: spec.cache_max_bytes || (c3.capacity && c3.capacity.max_bytes) || "",
    cache_entries: spec.cache_max_entries || (c3.capacity && c3.capacity.max_entries) || "",
    namespace: row.method === "IND" ? "PER_USER_50MIB_100" : "SHARED_50MIB_100",
    resources,
    startup,
  };
}

function main() {
  const rows = ledgerRows();
  const { byAttempt, latestIds } = latestAttempts();
  const sealed = sealedOrigin();
  const header = [
    "attempt_seq", "attempt_id", "run_id", "logical_id", "is_latest_attempt", "started_at", "scene", "trace", "regime", "n", "method", "seed", "outcome",
    "cache_budget_bytes", "cache_budget_entries", "cache_namespace",
    "common_origin_proxy_bytes", "common_origin_completion_bytes", "sealed_common_origin_bytes", "origin_match",
    "c3_origin_bytes", "c4_origin_bytes", "c5_origin_bytes", "full_origin_bytes",
    "p50_origin_ttfb_ms", "p95_origin_ttfb_ms",
    "skew_c3_ms", "skew_c4_ms", "skew_c5_ms", "residual_ok",
    "pose_status", "c3_pose_status", "c4_pose_status", "c5_pose_status", "c3_placed_spread", "exact_zero_pose_frames_c3",
    "psnr_median_proven", "ssim_median_proven", "psnr_proven_pairs", "image_measured_rows", "reference_full_view_pairs", "image_claim_status",
    "q5_before_5s", "fv_from_navigation", "t1m_from_navigation",
    "cpu_percent_median", "gpu_util_percent_median", "gpu_memory_used_mb_median", "resource_sample_count", "resource_status",
    "cpu_percent_median_c3", "cpu_percent_median_c4", "cpu_percent_median_c5",
    "gpu_util_percent_median_c3", "gpu_util_percent_median_c4", "gpu_util_percent_median_c5",
    "gpu_memory_used_mb_median_c3", "gpu_memory_used_mb_median_c4", "gpu_memory_used_mb_median_c5",
    "demand_rows", "future_frame_events", "resident_hit_bytes", "cross_user_hit_bytes", "inflight_merge_bytes",
    "first_origin_bytes", "eviction_refetch_bytes", "refetch_without_eviction_bytes", "partial_overlap_bytes", "evictions",
    "log_complete", "viewport", "dpr", "metric_口径",
  ];
  const lines = [header.join(",")];
  rows.forEach((row, index) => {
    const cell = analyze(row);
    const saved = sealed.get(row.attempt_id) || {};
    const sealedCommon = num(saved.common_origin_bytes);
    const reconstructed = cell.proxyPresent && cell.commonStart != null ? num(cell.proxyOrigin) : null;
    let originMatch = "NO_PROXY_LOG";
    if (!cell.proxyPresent) originMatch = "NO_PROXY_LOG";
    else if (cell.commonStart == null) originMatch = "NO_COMMON_WINDOW";
    else if (sealedCommon == null) originMatch = "NO_SEALED_ORIGIN_CSV";
    else originMatch = sealedCommon === reconstructed ? "RECONCILED" : "MISMATCH";
    const clientMedian = (field, client) => cell.expected.includes(client) ? cell.resources.per[client][field] : "NOT_IN_CELL";
    const record = [
      row.attempt_seq, row.attempt_id, row.run_id, byAttempt.get(row.attempt_id) || "", latestIds.has(row.attempt_id), row.started_at,
      cell.scene, cell.trace, row.regime, row.n, row.method, row.seed, row.outcome,
      cell.cache_bytes, cell.cache_entries, cell.namespace,
      cell.proxyPresent && cell.commonStart != null ? cell.proxyOrigin : "",
      cell.proxyPresent && cell.commonStart != null ? cell.reuse.completion_origin_bytes : "",
      saved.common_origin_bytes || "", originMatch,
      cell.perClient.C3, cell.perClient.C4, cell.perClient.C5, cell.proxyPresent ? cell.fullOrigin : "",
      pct(cell.ttfb, 0.5), pct(cell.ttfb, 0.95),
      cell.skew.C3, cell.skew.C4, cell.skew.C5, cell.residualOk,
      cell.poseStatus,
      cell.pose.C3 ? cell.pose.C3.status : "NOT_IN_CELL",
      cell.pose.C4 ? cell.pose.C4.status : "NOT_IN_CELL",
      cell.pose.C5 ? cell.pose.C5.status : "NOT_IN_CELL",
      cell.pose.C3 ? cell.pose.C3.placed_spread : "",
      cell.pose.C3 ? cell.pose.C3.exact_zero : "",
      cell.psnr, cell.ssim, cell.provenPairs, cell.measuredRows, cell.referenceProven, "UNVERIFIED_NOT_REFERENCE_FIDELITY",
      "NOT_SAMPLED", "NOT_SAMPLED", "NOT_SAMPLED",
      cell.resources.cpu, cell.resources.gpu, cell.resources.mem, cell.resources.samples, cell.resources.status,
      clientMedian("cpu", "C3"), clientMedian("cpu", "C4"), clientMedian("cpu", "C5"),
      clientMedian("gpu", "C3"), clientMedian("gpu", "C4"), clientMedian("gpu", "C5"),
      clientMedian("mem", "C3"), clientMedian("mem", "C4"), clientMedian("mem", "C5"),
      cell.reuse.demand_rows, cell.reuse.future_frames, cell.reuse.resident_hit_bytes, cell.reuse.cross_user_hit_bytes, cell.reuse.inflight_bytes,
      cell.reuse.first_origin_bytes, cell.reuse.eviction_refetch_bytes, cell.reuse.refetch_without_eviction_bytes, cell.reuse.partial_overlap_bytes, cell.reuse.evictions,
      saved.log_complete || "", cell.viewport, "NOT_RECORDED", "audit_www2027_analyzeCell_common_window",
    ];
    lines.push(record.map(csvCell).join(","));
    if ((index + 1) % 10 === 0) console.log(`EXPORTED ${index + 1}/${rows.length}`);
  });
  fs.writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(`WROTE ${OUT} rows=${rows.length}`);
}

main();
