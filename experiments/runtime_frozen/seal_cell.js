"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const ROOT = path.dirname(__dirname);
const TRACE = JSON.parse(fs.readFileSync(path.join(__dirname, "traces", "stop_go.json"), "utf8"));
const FRAMES = (TRACE.frames || TRACE.samples || []).map((frame) => ({
  time: typeof frame.time === "number" ? frame.time : frame.t_ms / 1000,
  position: frame.camera ? [frame.camera.x, frame.camera.y, frame.camera.z] : frame.position,
})).filter((frame) => frame.position && Number.isFinite(frame.time));
const COIT = [-0.858, 2.203, -1.128];
const POLAND = [43.7, -3.5, -1.7];
const CHECKS = [2, 5, 10, 20, 40, 60];

function nearest(time) {
  let best = FRAMES[0];
  for (const frame of FRAMES) if (Math.abs(frame.time - time) < Math.abs(best.time - time)) best = frame;
  return best;
}
function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
function intended(sceneFile, sample) {
  if (sceneFile === "coit-40m-sh1-lod") return sample;
  if (sceneFile === "poland-lod") return POLAND.map((value, index) => value + (sample[index] - COIT[index]));
  return null;
}
function percentile(values, p) {
  const nums = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!nums.length) return "";
  const index = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1));
  return Number(nums[index].toFixed(3));
}
async function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch (error) { /* torn */ }
  }
  return rows;
}
async function viewAt(file, target) {
  const rows = await readJsonl(file);
  let best = null;
  for (const row of rows) {
    const cam = row.playback && row.playback.camera;
    if (!cam || !Number.isFinite(cam.x)) continue;
    const dt = Math.abs(Number(row.timestamp) - target);
    if (!best || dt < best.dt) best = { dt, camera: [cam.x, cam.y, cam.z], quaternion: cam.quaternion || row.playback.quaternion || null };
  }
  if (!best || best.dt > 250) return null;
  return best;
}

async function main() {
  const attempt = process.argv[2];
  const runId = process.argv[3];
  const sceneFile = process.argv[4];
  const regime = process.argv[5];
  const wave = path.join(ROOT, "cells", attempt);
  const reasons = [];
  const spec = JSON.parse(fs.readFileSync(path.join(wave, "metrics", runId, "cell_spec.json"), "utf8"));
  if (Number(spec.cache_max_bytes) !== 52428800 || Number(spec.cache_max_entries) !== 100) reasons.push("CACHE_BUDGET");
  const clients = Object.keys(spec.clients || {}).sort();
  const joined = clients.join("+");
  if (joined !== "C3+C4+C5" && joined !== "C3+C4") reasons.push("CLIENT_SET");
  const statePath = path.join(wave, "runtime", `state_${runId}.json`);
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
  if (state.phase !== "DONE") reasons.push(`PHASE_${state.phase || "MISSING"}`);
  const starts = [];
  const ends = [];
  const clientRows = [];
  let maxPose = 0;
  for (const client of clients) {
    const nested = path.join(wave, "evidence", runId, client, client);
    const flat = path.join(wave, "evidence", runId, client);
    const dir = fs.existsSync(path.join(nested, `${client}_evidence.json`)) ? nested : flat;
    const evidence = JSON.parse(fs.readFileSync(path.join(dir, `${client}_evidence.json`), "utf8"));
    const skew = Number(evidence.measurement_start_skew_ms);
    if (!Number.isFinite(skew) || Math.abs(skew) > 3000) reasons.push(`SKEW_${client}_${skew}`);
    const start = Date.parse(evidence.measurement_start);
    const end = Date.parse(evidence.measurement_end);
    if (Number.isFinite(start)) starts.push(start);
    if (Number.isFinite(end)) ends.push(end);
    const resources = await readJsonl(path.join(dir, `${client}_resource_1hz.jsonl`));
    const inWindowResources = resources.filter((row) => {
      const stamp = Number(row.timestamp);
      return stamp >= start && stamp <= end;
    });
    const gpu = inWindowResources.map((row) => Number(row.gpu_util_percent)).filter((value) => Number.isFinite(value));
    const cpu = inWindowResources.map((row) => Number(row.cpu_percent)).filter((value) => Number.isFinite(value));
    const vram = inWindowResources.map((row) => Number(row.gpu_memory_used_mb)).filter((value) => Number.isFinite(value));
    if (inWindowResources.length < 60 || gpu.length < 50) reasons.push(`RESOURCE_${client}_${inWindowResources.length}`);
    let matched = 0;
    for (const checkpoint of CHECKS) {
      const file = path.join(dir, `canvas_t${checkpoint}.json`);
      if (!fs.existsSync(file)) {
        reasons.push(`MISSING_CHECKPOINT_${client}_t${checkpoint}`);
        continue;
      }
      const frame = JSON.parse(fs.readFileSync(file, "utf8"));
      const target = Number(frame.trace_origin_ms) + checkpoint * 1000;
      const embedded = frame.playback && frame.playback.camera;
      const sample = frame.playback ? Number(frame.playback.sample_t_ms) : NaN;
      if (!(Number.isFinite(sample) && Math.abs(sample / 1000 - checkpoint) <= 0.25)) reasons.push(`CHECKPOINT_CLOCK_${client}_t${checkpoint}`);
      let camera = null;
      if (embedded && Number.isFinite(embedded.x) && Math.abs(Number(frame.timestamp || target) - target) <= 250 && Number.isFinite(sample) && Math.abs(sample / 1000 - checkpoint) <= 0.25) camera = [embedded.x, embedded.y, embedded.z];
      else {
        const view = await viewAt(path.join(dir, `${client}_visual_timeline.jsonl`), target);
        if (view) camera = view.camera;
      }
      const goal = intended(sceneFile, nearest(checkpoint).position);
      const error = camera && goal ? dist(camera, goal) : null;
      if (error == null || error > 0.5) reasons.push(`CAMERA_${client}_t${checkpoint}`);
      else matched += 1;
      if (error != null) maxPose = Math.max(maxPose, error);
    }
    if (matched !== CHECKS.length) reasons.push(`CAMERA_MATCH_${client}_${matched}/6`);
    const timeline = await readJsonl(path.join(dir, `${client}_visual_timeline.jsonl`));
    const hz = timeline.filter((row) => Number(row.timestamp) >= start && Number(row.timestamp) <= end && row.playback && row.playback.camera).length;
    if (hz < 60) reasons.push(`POSE_HZ_${client}_${hz}`);
    clientRows.push({
      attempt_id: attempt, client, start_skew_ms: skew, measurement_start_ms: start, measurement_end_ms: end,
      camera_checkpoints_valid: matched, gpu_samples: gpu.length, cpu_samples: cpu.length,
      gpu_p50: percentile(gpu, 50), cpu_p50: percentile(cpu, 50), nvidia_vram_p50: percentile(vram, 50),
      webgl_vram_status: "NOT_MEASURED",
    });
  }
  let originBytes = "";
  let requestRows = [];
  const ttfb = {};
  for (const client of clients) ttfb[client] = [];
  if (starts.length === clients.length && ends.length === clients.length && clients.length >= 2) {
    const windowStart = Math.max(...starts);
    const windowEnd = Math.min(...ends);
    const duration = windowEnd - windowStart;
    const minimum = regime === "staggered" ? 55000 : 65000;
    if (!(duration >= minimum)) reasons.push(`WINDOW_${duration}`);
    const proxy = await readJsonl(path.join(wave, "evidence", runId, "S_runtime", "proxy.jsonl"));
    originBytes = 0;
    for (const event of proxy) {
      const stamp = Number(event.timestamp || event.request_start_ms);
      requestRows.push(event);
      if (stamp < windowStart || stamp > windowEnd) continue;
      originBytes += Number(event.bytes_from_origin) || 0;
      const client = String(event.user_id || "").includes("C4") ? "C4" : String(event.user_id || "").includes("C5") ? "C5" : "C3";
      if (Number.isFinite(Number(event.origin_ttfb_ms))) ttfb[client].push(Number(event.origin_ttfb_ms));
    }
    for (const row of clientRows) {
      row.ttfb_p50_ms = percentile(ttfb[row.client], 50);
      row.ttfb_p95_ms = percentile(ttfb[row.client], 95);
      row.common_start_ms = windowStart;
      row.common_end_ms = windowEnd;
    }
  } else reasons.push("COMMON_WINDOW");
  const unique = [...new Set(reasons)];
  const report = {
    pass: unique.length === 0,
    attempt_id: attempt,
    run_id: runId,
    scene_file: sceneFile,
    regime,
    reasons: unique,
    common_window_origin_bytes: originBytes,
    max_pose_error: Number(maxPose.toFixed(4)),
    webgl_vram_status: "NOT_MEASURED",
    psnr_ssim_reference_status: "UNVERIFIED_NOT_REFERENCE_FIDELITY",
  };
  fs.mkdirSync(path.join(ROOT, "CELL_RAW_MANIFESTS"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "CELL_RAW_MANIFESTS", `${attempt}.json`), JSON.stringify({ report, clientRows }, null, 2));
  appendCsv(path.join(ROOT, "PER_CLIENT_MASTER.csv"), Object.keys(clientRows[0] || { attempt_id: "" }), clientRows);
  appendCsv(path.join(ROOT, "PER_REQUEST_MASTER.csv"), ["attempt_id", "request_id", "user_id", "cache_key", "decision", "bytes_from_origin", "request_start_ms", "timestamp", "origin_ttfb_ms", "etag", "range_start", "range_end"], requestRows.map((row) => ({ attempt_id: attempt, ...row })));
  const master = {
    attempt_id: attempt, run_id: runId, method: spec.method, scene_file: sceneFile, regime, seed: spec.seed,
    pass: report.pass, reasons: unique.join("|"), common_origin_completion_bytes: originBytes, max_pose_error: report.max_pose_error,
    start_residual_max_ms: Math.max(...clientRows.map((row) => Math.abs(Number(row.start_skew_ms) || 0))),
    webgl_vram_status: "NOT_MEASURED", psnr_ssim_reference_status: report.psnr_ssim_reference_status,
  };
  appendCsv(path.join(ROOT, "MASTER_ALL_CELLS.csv"), Object.keys(master), [master]);
  console.log(JSON.stringify(report));
  process.exit(report.pass ? 0 : 2);
}

function appendCsv(file, header, rows) {
  const exists = fs.existsSync(file);
  const lines = [];
  if (!exists) lines.push(header.join(","));
  for (const row of rows) lines.push(header.map((key) => JSON.stringify(row[key] == null ? "" : row[key])).join(","));
  fs.appendFileSync(file, (exists ? "" : "") + lines.join("\n") + "\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
