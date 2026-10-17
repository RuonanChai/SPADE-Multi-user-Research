import * as THREE from "three";
import { SplatMesh, SparkRenderer } from "@sparkjsdev/spark";
import { TraceRecorder } from "/src/trace/TraceRecorder.ts";
import { TracePlayer } from "/src/trace/TracePlayer.ts";
import { PoseController } from "/src/experiment/PoseController.ts";
import { FetchRangeLogger } from "/src/logging/FetchRangeLogger.ts";

// --- perf attribution (all marks on main-thread clock) ---
const _t0 = performance.now();
window._marks = {};
function _mark(name) {
  if (window._marks[name] != null) return;
  window._marks[name] = performance.now() - _t0;
  performance.mark(name);
}
let _interactiveDone = false;
const _params = new URLSearchParams(window.location.search);
const _benchQuality = _params.get("bench_quality") || "normal";
const _mode = _params.get("mode") || "idle"; // idle | record | replay | pose-driven
const _userId = _params.get("user_id") || "user0";
const _traceId = _params.get("trace_id") || `trace-${Date.now()}`;
const _replayTraceUrl = _params.get("trace_url") || "";
const _poseScriptUrl = _params.get("pose_script_url") || "";
const _startOffsetMs = Number.parseInt(_params.get("start_offset_ms") || "0", 10) || 0;
const _runId = _params.get("run_id") || "";
const _scenarioId = _params.get("scenario_id") || "";
const _cacheMode = _params.get("cache_mode") || "";
const _clientId = _params.get("client_id") || _userId;
const _experimentId = _params.get("experiment_id") || "";
const _cdnBaseUrl = (_params.get("cdn_base_url") || "").replace(/\/$/, "");
const _workload = _params.get("workload") || "";
const _cacheKeyVersion = _params.get("cache_key_version") || "";
const _timingWindowMs = 120000;
const _resourceEvents = [];
const _schedulerEvents = [];
const _appMarks = [];
const _poseTrace = [];
const _timingWarnings = [];

// Spark 调度相关事件通过 window hook 回传；要在创建 SparkRenderer 之前挂载，
// 避免初始化期间的事件丢失。
window.__sparkExpEvent = (evt) => {
  _schedulerEvents.push({
    run_id: _runId,
    scenario_id: _scenarioId,
    cache_mode: _cacheMode,
    client_id: _clientId,
    timestamp_ms: performance.now(),
    decision_step: _schedulerEvents.length,
    pose_id: _poseTrace.length ? _poseTrace[_poseTrace.length - 1].pose_id : null,
    ...evt,
  });
};

// Worker _perf events arrive via SplatWorker → window message (register BEFORE SparkRenderer)
window.addEventListener("message", (e) => {
  if (e.data?._perf) _mark(e.data._perf);
});

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 0, 3);
const renderer = new THREE.WebGLRenderer();
renderer.setPixelRatio(_benchQuality === "low" ? 0.5 : Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const spark = new SparkRenderer({
  renderer,
  // Use less detail in the low-quality control group.
  lodSplatScale: _benchQuality === "low" ? 0.6 : 1.0,
  // 为了让 Spark2.0 的 LoD fetcher 工作并产生 scheduler 事件，
  //（用于 scheduler-decisions / t-ready-mark 统计），需要显式打开 LoD 驱动。
  enableLod: true,
  enableDriveLod: true,
  enableLodFetching: true,
});
scene.add(spark);

window.addEventListener('resize', onWindowResize, false);
function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

const splatURLBase = _cdnBaseUrl ? `${_cdnBaseUrl}/butterfly.spz` : "/assets/splats/butterfly.spz";
const splatURL = _cacheKeyVersion ? `${splatURLBase}?v=${encodeURIComponent(_cacheKeyVersion)}` : splatURLBase;
_mark("first-spz-request");
const butterfly = new SplatMesh({
  url: splatURL,
  // 显式开启 LoD（Spark2.0 scheduler 事件来自 LoD fetcher）。
  enableLod: true,
  lodScale: _benchQuality === "low" ? 0.6 : 1.0,
  // 使用分页 LoD（会触发 LoD chunk fetcher，从而产生 scheduler_decision 事件）。
  paged: true,
});
butterfly.quaternion.set(1, 0, 0, 0);
butterfly.position.set(0, 0, -3);
scene.add(butterfly);
const _markFirstInteraction = () => _mark("first-interaction");
window.addEventListener("pointerdown", _markFirstInteraction, { once: true, passive: true });
window.addEventListener("keydown", _markFirstInteraction, { once: true });

const fetchLogger = new FetchRangeLogger({
  userId: _userId,
  traceId: _traceId,
  runId: _runId || undefined,
  endpoint: _params.get("client_log_endpoint") || undefined,
});
fetchLogger.install();
const _longTasks = [];
try {
  const longTaskObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      _longTasks.push(entry.duration);
    }
  });
  longTaskObserver.observe({ type: "longtask", buffered: true });
} catch {
  // some browsers may not support longtask observer
}

let recorder = null;
let player = null;
let poseController = null;
let _replayStartWallclock = null;
if (_mode === "record") {
  recorder = new TraceRecorder(camera, {
    userId: _userId,
    traceId: _traceId,
    sampleIntervalMs: 100,
    includeFov: true,
  });
  recorder.start();
} else if (_mode === "replay" && _replayTraceUrl) {
  const traceResponse = await fetch(_replayTraceUrl, { cache: "no-store" });
  const trace = await traceResponse.json();
  player = new TracePlayer(camera, trace, { deterministic: true });
  player.start(_startOffsetMs);
  _replayStartWallclock = Date.now();
} else if (_mode === "pose-driven" && _poseScriptUrl) {
  const poseResponse = await fetch(_poseScriptUrl, { cache: "no-store" });
  const poseScript = await poseResponse.json();
  poseController = new PoseController(camera, poseScript);
  poseController.start(_startOffsetMs);
  _replayStartWallclock = Date.now();
}

function _recordAppMark(name, extra = {}) {
  const entry = {
    run_id: _runId,
    scenario_id: _scenarioId,
    cache_mode: _cacheMode,
    client_id: _clientId,
    ts_ms: performance.now(),
    name,
    ...extra,
  };
  _appMarks.push(entry);
  performance.mark(name);
}

function _snapshotResourceTiming() {
  const now = performance.now();
  const rows = performance.getEntriesByType("resource")
    .filter((e) => e.startTime >= now - _timingWindowMs)
    .filter((e) => (_cdnBaseUrl ? String(e.name || "").startsWith(_cdnBaseUrl) : true));
  _resourceEvents.length = 0;
  for (const e of rows) {
    const dnsMs = e.domainLookupEnd - e.domainLookupStart;
    const tcpMs = e.connectEnd - e.connectStart;
    const tlsMs = e.secureConnectionStart > 0 ? e.connectEnd - e.secureConnectionStart : null;
    const requestToTtfbMs = e.responseStart - e.requestStart;
    const bodyDownloadMs = e.responseEnd - e.responseStart;
    _resourceEvents.push({
      run_id: _runId,
      scenario_id: _scenarioId,
      cache_mode: _cacheMode,
      client_id: _clientId,
      object_url: e.name,
      request_start_ms: e.requestStart,
      response_start_ms: e.responseStart,
      response_end_ms: e.responseEnd,
      ttfb_ms: requestToTtfbMs,
      body_download_ms: bodyDownloadMs,
      ttlb_ms: e.responseEnd - e.requestStart,
      dns_ms: dnsMs,
      tcp_ms: tcpMs,
      tls_ms: tlsMs,
      request_to_ttfb_ms: requestToTtfbMs,
      total_resource_ms: e.responseEnd - e.startTime,
      transfer_size: e.transferSize,
      encoded_body_size: e.encodedBodySize,
      decoded_body_size: e.decodedBodySize,
      next_hop_protocol: e.nextHopProtocol || "unknown",
      connection_reused: dnsMs === 0 && tcpMs === 0,
    });
  }
  if (_resourceEvents.length === 0 && _cdnBaseUrl) {
    _timingWarnings.push("resource_timing_empty_or_cross_origin_restricted");
  }
}

function _download(name, payload, contentType = "application/json") {
  const blob = new Blob([payload], { type: contentType });
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
  URL.revokeObjectURL(href);
}

function _persistClientLogs() {
  const jsonl = fetchLogger.toJsonl();
  if (jsonl.length > 0) {
    _download(`client-fetch-${_userId}-${_traceId}.jsonl`, `${jsonl}\n`, "application/x-ndjson");
  }
  if (recorder) {
    const trace = recorder.stop();
    _download(`trace-${_userId}-${_traceId}.json`, JSON.stringify(trace, null, 2));
  }
}

window.addEventListener("beforeunload", () => {
  _persistClientLogs();
});

let lastTime;
renderer.setAnimationLoop(function animate(time) {
  const deltaTime = time - (lastTime || time);
  lastTime = time;
  if (player) {
    player.update();
  } else if (poseController) {
    _recordAppMark("pose_update_start");
    const pose = poseController.update();
    _recordAppMark("pose_update_end");
    if (pose) {
      _poseTrace.push({
        run_id: _runId,
        scenario_id: _scenarioId,
        cache_mode: _cacheMode,
        client_id: _clientId,
        pose_id: pose.pose_id,
        timestamp_ms: performance.now(),
        position: pose.position,
        rotation: pose.rotation || null,
        yaw: pose.yaw ?? null,
        pitch: pose.pitch ?? null,
        roll: pose.roll ?? null,
      });
      _recordAppMark("first_frame_after_pose_update", { pose_id: pose.pose_id });
    }
  } else {
    // Keep a deterministic idle camera movement in non-replay mode.
    camera.position.x = Math.sin(time / 2500) * 0.25;
    camera.lookAt(0, 0, -3);
  }
  renderer.render(scene, camera);
  butterfly.rotation.y += deltaTime / 2500;

  // first-nonempty-frame: SparkRenderer._perfFrameDone signals first render with frame>0
  if (!window._marks["first-nonempty-frame"] && spark._perfFrameDone) {
    _mark("first-nonempty-frame");
  }
  // interactive-ready: first nonempty frame is sufficient
  if (!_interactiveDone && window._marks["first-nonempty-frame"] && renderer.info.render.frame >= 1) {
    _interactiveDone = true;
    _mark("interactive-ready");
    _recordAppMark("first_acceptable_visible_render");
    setTimeout(_printPerfTable, 0);
  }
});

function _printPerfTable() {
  const keys = ["worker-init-start","worker-init-end","first-spz-request","first-spz-first-byte","decode-complete","first-nonempty-frame","first-interaction","interactive-ready"];
  const rows = keys.map(k => ({ mark: k, "ms from t0": window._marks[k] != null ? window._marks[k].toFixed(1) : "—" }));
  console.table(rows);
}

window.__clientTrace = {
  run_id: _runId,
  user_id: _userId,
  trace_id: _traceId,
  mode: _mode,
  replay_start_wallclock: _replayStartWallclock,
  save: _persistClientLogs,
  get_fetch_jsonl: () => fetchLogger.toJsonl(),
  get_fetch_logs: () => fetchLogger.getLogs(),
  get_pose_trace: () => [..._poseTrace],
  get_scheduler_decisions: () => [..._schedulerEvents],
  get_app_marks: () => [..._appMarks],
  get_resource_timing: () => {
    _snapshotResourceTiming();
    return [..._resourceEvents];
  },
  get_page_main_thread_summary: () => {
    const nav = performance.getEntriesByType("navigation")[0];
    const paints = performance.getEntriesByType("paint");
    const fp = paints.find((x) => x.name === "first-paint");
    const fcp = paints.find((x) => x.name === "first-contentful-paint");
    const sortedLong = [..._longTasks].sort((a, b) => a - b);
    const q = (p) =>
      sortedLong.length
        ? sortedLong[Math.min(sortedLong.length - 1, Math.max(0, Math.ceil(sortedLong.length * p) - 1))]
        : null;
    const totalBlockingTime = _longTasks.reduce((sum, d) => sum + Math.max(0, d - 50), 0);
    return {
      run_id: _runId,
      scenario_id: _scenarioId,
      cache_mode: _cacheMode,
      client_id: _clientId,
      navigationStart: nav?.startTime ?? 0,
      domInteractive: nav?.domInteractive ?? null,
      domContentLoadedEventStart: nav?.domContentLoadedEventStart ?? null,
      domContentLoadedEventEnd: nav?.domContentLoadedEventEnd ?? null,
      domComplete: nav?.domComplete ?? null,
      loadEventEnd: nav?.loadEventEnd ?? null,
      first_paint: fp?.startTime ?? null,
      first_contentful_paint: fcp?.startTime ?? null,
      long_task_count: _longTasks.length,
      long_task_total_ms: _longTasks.reduce((a, b) => a + b, 0),
      long_task_p50_ms: q(0.5),
      long_task_p95_ms: q(0.95),
      long_task_p99_ms: q(0.99),
      total_blocking_time_ms: totalBlockingTime,
      timing_warnings: [..._timingWarnings],
    };
  },
  experiment_context: {
    experiment_id: _experimentId,
    run_id: _runId,
    scenario_id: _scenarioId,
    cache_mode: _cacheMode,
    client_id: _clientId,
    workload: _workload,
    mode: _mode,
  },
};
