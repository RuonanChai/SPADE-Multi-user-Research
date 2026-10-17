#!/usr/bin/env node
/**
 * remote_worker_bundle.js - Remote Client Worker
 * Authority: command41_master_final.txt
 *
 * This command51 worker MUST run ONLY on client machines C3/C4/C5.
 * It is the ONLY component allowed to call chromium.launch().
 *
 * FIXED (crash-recovery 2026-08-13):
 *   - Inject camera trace via __P5TraceBridge.loadTrace() + startReplay()
 *   - VISUAL_READY gate: framesReplayed > 0 required before accepting measurement
 *   - RAD streaming minimum: rad_206_count >= 3 required (not just > 0)
 *   - Screenshot checkpoints: 30s and 60s (not 5s/10s/30s/60s)
 *   - verdict: requires rad_206_count >= 3 && framesReplayed > 0
 *
 * Flow:
 * 1. Read RunId config from file (must include tracePath field)
 * 2. Launch headed Chromium with Playwright
 * 3. Load Spark page via S proxy (?p5_test=1 required for __P5TraceBridge)
 * 4. Wait for __P5TraceBridge.ready (up to VISUAL_READY_MAX_MS=20000ms)
 * 5. Inject trace via loadTrace + startReplay
 * 6. Verify VISUAL_READY: framesReplayed > 0 within 20s
 * 7. Write READY file
 * 8. Collect CDP network traces during measurement window
 * 9. Take screenshots at checkpoints
 * 10. Write DONE file + evidence JSON
 */

const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {execFileSync} = require('child_process');
const {validateBarrierRelease} = require(path.join(__dirname, 'runtime_actuation_contract'));
const {writeReadyAtomic} = require(path.join(__dirname, 'ready_protocol'));
const {buildGpuPathEvidence} = require(path.join(__dirname, 'render_diagnostic_contract'));
const VisualGuard = require(path.join(__dirname, 'cleanroom_visual_guard'));

// command41 Section I timing constants
const VISUAL_READY_MAX_MS = 60000;
const VISUAL_STABLE_CONFIRM_MS = 3000;
const IN_MEASUREMENT_RENDER_STALL_MAX_MS = 3000;
const REPLAY_WARMUP_MS = 5000;
const RAD_206_MIN = 3; // Minimum streaming requests for valid measurement
const MAX_EVIDENCE_FILES = 128;
const MAX_EVIDENCE_FILE_BYTES = 256 * 1024 * 1024;
const MAX_EVIDENCE_TOTAL_BYTES = 1024 * 1024 * 1024;

// This script MUST be invoked with config path
const CONFIG_PATH = process.argv[2];
const EXPECTED_CONFIG_SHA256 = process.argv[3];
if (!CONFIG_PATH || !fs.existsSync(CONFIG_PATH)) {
  console.error('ERROR: Missing or invalid config path');
  console.error('Usage: node remote_worker_bundle.js <config.json>');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const {
  runId, clientId, cellId, expectedClientIp, method, runtimeMethod, scene, trace, duration, viteUrl,
  evidenceDir, tracePath, traceSha256, workerSha256, phaseOffset, seed, capacity,
  runtimeSemantics, scientificEpoch, matrixSha256, topologySha256, fullConfigHash,
  actuationContractSha256, schedulerContractSha256, screenshotSampled, clockOffsetMs
} = config;
if (typeof screenshotSampled !== 'boolean') {
  throw new Error('SCREENSHOT_SAMPLING_BINDING_INVALID');
}
const actualConfigSha256 = crypto.createHash('sha256').update(fs.readFileSync(CONFIG_PATH)).digest('hex');
const actualActuationContractSha256 = crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(__dirname, 'runtime_actuation_contract.js'))).digest('hex');
const userDataDir = path.join(os.tmpdir(), 'p5-3dgs-profiles', `stable-${clientId}`);
let evidenceDirectoryOwned = false;

function cleanupProfile() {}

async function boundedAwait(promise, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

// Resource sampler for command227 PHASE 3 metrics
let resourceSamplerInterval = null;
let resourceSamples = [];
let lastCpuMeasure = null;

function startResourceSampler() {
  resourceSamples = [];
  lastCpuMeasure = null;

  resourceSamplerInterval = setInterval(() => {
    try {
      const sample = {
        timestamp: Date.now(),
        hostname: os.hostname(),
        cpu_percent: null,
        gpu_util_percent: null,
        gpu_memory_used_mb: null,
        gpu_memory_total_mb: null,
        rss_mb: process.memoryUsage().rss / (1024 * 1024)
      };

      // CPU sampling using os.cpus() delta
      const cpus = os.cpus();
      let totalIdle = 0, totalTick = 0;
      for (const cpu of cpus) {
        for (const type in cpu.times) {
          totalTick += cpu.times[type];
        }
        totalIdle += cpu.times.idle;
      }

      if (lastCpuMeasure) {
        const idleDiff = totalIdle - lastCpuMeasure.idle;
        const totalDiff = totalTick - lastCpuMeasure.total;
        if (totalDiff > 0) {
          sample.cpu_percent = 100 - (100 * idleDiff / totalDiff);
        }
      }
      lastCpuMeasure = { idle: totalIdle, total: totalTick };

      // GPU sampling using nvidia-smi
      try {
        const gpuOutput = execFileSync('nvidia-smi', [
          '--query-gpu=utilization.gpu,memory.used,memory.total',
          '--format=csv,noheader,nounits'
        ], { encoding: 'utf8', timeout: 2000 });

        const parts = gpuOutput.trim().split(',').map(s => s.trim());
        if (parts.length >= 3) {
          sample.gpu_util_percent = parseFloat(parts[0]);
          sample.gpu_memory_used_mb = parseFloat(parts[1]);
          sample.gpu_memory_total_mb = parseFloat(parts[2]);
        }
      } catch (gpuErr) {
        // GPU sampling optional, may fail on non-NVIDIA machines
      }

      resourceSamples.push(sample);
    } catch (err) {
      console.error('[ResourceSampler] Sample error:', err.message);
    }
  }, 1000);

  console.log('[ResourceSampler] Started 1Hz sampling');
}

function stopResourceSampler() {
  if (resourceSamplerInterval) {
    clearInterval(resourceSamplerInterval);
    resourceSamplerInterval = null;
    console.log(`[ResourceSampler] Stopped. Collected ${resourceSamples.length} samples`);
  }
  return resourceSamples;
}

function hashEvidenceFile(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_EVIDENCE_FILE_BYTES) {
    throw new Error(`EVIDENCE_FILE_BOUND_EXCEEDED:${path.basename(file)}`);
  }
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return {size_bytes: stat.size, sha256: hash.digest('hex')};
}

function writeEvidenceManifest() {
  const entries = fs.readdirSync(evidenceDir, {withFileTypes: true});
  if (entries.some(entry => !entry.isFile())) {
    throw new Error('EVIDENCE_MANIFEST_REJECTS_NESTED_DIRECTORY');
  }
  const evidenceEntries = entries
    .filter(entry => entry.name !== 'evidence_manifest.json')
    .map(entry => entry.name).sort();
  if (evidenceEntries.length === 0 || evidenceEntries.length > MAX_EVIDENCE_FILES) {
    throw new Error('EVIDENCE_MANIFEST_FILE_COUNT_INVALID');
  }
  let totalBytes = 0;
  const files = evidenceEntries.map(relative_path => {
      const file = path.join(evidenceDir, relative_path);
      const metadata = hashEvidenceFile(file);
      totalBytes += metadata.size_bytes;
      return {
        relative_path,
        size_bytes: metadata.size_bytes,
        sha256: metadata.sha256
      };
    });
  if (totalBytes > MAX_EVIDENCE_TOTAL_BYTES) {
    throw new Error('EVIDENCE_MANIFEST_TOTAL_SIZE_EXCEEDED');
  }
  const manifest = {schema_version: 1, run_id: runId, client_id: clientId, files};
  const target = path.join(evidenceDir, 'evidence_manifest.json');
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {flag: 'wx'});
  fs.renameSync(temporary, target);
  return manifest;
}

console.log(`[RemoteWorker] Starting on ${os.hostname()}`);
console.log(`[RemoteWorker] RunId: ${runId}`);
console.log(`[RemoteWorker] ClientId: ${clientId}`);
console.log(`[RemoteWorker] Method: ${method}, Scene: ${scene}, Trace: ${trace}`);
console.log(`[RemoteWorker] TracePath: ${tracePath || 'NOT_PROVIDED'}`);

// SAFETY GATE: Refuse to run on S
const hostname = os.hostname().toLowerCase();
const localIPs = Object.values(require('os').networkInterfaces())
  .flat()
  .filter(i => i.family === 'IPv4')
  .map(i => i.address);

if (hostname.includes('iot-desktop') || localIPs.includes('192.168.0.200') || localIPs.includes('192.168.1.200')) {
  console.error('FATAL: Attempted to launch experiment browser on S (192.168.1.200)');
  console.error('This violates command25 remote-only execution requirement');
  process.exit(99);
}
if (!['C3', 'C4', 'C5'].includes(clientId) || !localIPs.includes(expectedClientIp) ||
    ![scientificEpoch, matrixSha256, topologySha256, fullConfigHash, traceSha256, workerSha256,
      actuationContractSha256, schedulerContractSha256, EXPECTED_CONFIG_SHA256]
      .every(value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) ||
    !Number.isInteger(seed) || !Number.isFinite(duration) || duration <= 0 ||
    !Number.isFinite(phaseOffset) || !Number.isFinite(clockOffsetMs) || runtimeSemantics === null ||
    typeof runtimeSemantics !== 'object' || runtimeMethod !== runtimeSemantics.key ||
    cellId !== `cell_${fullConfigHash}` ||
    actualConfigSha256 !== EXPECTED_CONFIG_SHA256 ||
    actualActuationContractSha256 !== actuationContractSha256) {
  console.error('FATAL: canonical worker configuration binding invalid');
  process.exit(98);
}
const actualWorkerSha256 = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
if (actualWorkerSha256 !== workerSha256) {
  console.error(`FATAL: worker SHA mismatch: ${actualWorkerSha256}`);
  process.exit(97);
}

// Load trace data (required for scientific measurement)
let traceData = null;
if (tracePath && fs.existsSync(tracePath)) {
  const traceBytes = fs.readFileSync(tracePath);
  const actualTraceSha256 = crypto.createHash('sha256').update(traceBytes).digest('hex');
  if (actualTraceSha256 !== traceSha256) {
    console.error(`FATAL: trace SHA mismatch: ${actualTraceSha256}`);
    process.exit(96);
  }
  traceData = JSON.parse(traceBytes.toString('utf8'));
  console.log(`[RemoteWorker] Loaded trace: ${traceData.name}, ${traceData.frame_count} frames, ${traceData.duration_sec}s`);
} else {
  console.error(`[RemoteWorker] FATAL: tracePath not provided or not found: ${tracePath}`);
  process.exit(3);
}

async function runRemoteTrial() {
  const startTime = Date.now();

  // Acquire an exact fresh evidence directory. Existing bytes belong to a
  // prior attempt and must never be folded into this run's manifest.
  fs.mkdirSync(path.dirname(evidenceDir), {recursive: true});
  fs.mkdirSync(evidenceDir, {recursive: false});
  evidenceDirectoryOwned = true;

  const networkLog = [];
  const screenshots = [];
  let visualReadyMs = null;
  let framesReplayedAtReady = 0;
  let bridgeStateAtEnd = null;
  let measurementStart, measurementEnd, actualDuration;  // Declare at function scope for evidence serialization

  console.log('[RemoteWorker] Launching headed Chromium...');

  // Command244 Section 3.2: Write browser ownership artifact
  const ownership = {
    run_id: runId,
    client_id: clientId,
    worker_pid: process.pid,
    launch_timestamp: new Date().toISOString(),
    user_data_dir: userDataDir,
  };
  fs.writeFileSync(
    path.join(evidenceDir, 'BROWSER_OWNERSHIP.json'),
    JSON.stringify(ownership, null, 2)
  );

  let context = null;
  try {
  // Launch headed Chromium with hardware acceleration and persistent context
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--enable-webgl',
      '--use-gl=angle',
      '--use-angle=d3d11',
      '--force_high_performance_gpu',
    ],
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  });

  const page = context.pages()[0] || await context.newPage();

  // Enable CDP network tracking
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');

  // Command244 Section 3.6: Send run_id with every request for stale-run rejection
  await cdp.send('Network.setExtraHTTPHeaders', {
    headers: {
      'x-run-id': runId
    }
  });
  console.log(`[RemoteWorker] Set x-run-id header: ${runId.substring(0, 50)}...`);

  // Request lifecycle tracking (command227 PHASE 3 - BG1 fix)
  const requestLifecycle = new Map(); // requestId -> {requestSent, responseReceived, finished, url}

  cdp.on('Network.requestWillBeSent', ({ requestId, request, timestamp }) => {
    if (request.url.includes('.rad') || request.url.includes('/_p5rad/')) {
      requestLifecycle.set(requestId, {
        requestId,
        url: request.url,
        requestSent: timestamp,
        responseReceived: null,
        firstData: null,
        lastData: null,
        dataBytes: 0,
        finished: null,
        failed: false
      });
      // STUDY_V2 V-signal: observed at send, not a before-fetch pose. Off unless P5_V_SIGNAL=1.
      if (process.env.P5_V_SIGNAL === '1') {
        const range = (request.headers && (request.headers.Range || request.headers.range)) || null;
        let range_start = null, range_end = null;
        if (range && String(range).startsWith('bytes=')) {
          const parts = String(range).slice(6).split('-');
          range_start = Number(parts[0]);
          range_end = parts[1] === '' ? null : Number(parts[1]);
        }
        fs.appendFileSync(path.join(evidenceDir, `${clientId}_v_signal.jsonl`), JSON.stringify({
          ts_ms: Date.now(),
          cdp_ts: timestamp,
          run_id: runId,
          client_id: clientId,
          requestId,
          range_start,
          range_end,
          phase: 'AT_REQUEST_OBSERVED',
          signal_available_before_fetch: false
        }) + '\n');
      }
    }
  });

  cdp.on('Network.responseReceived', ({ requestId, response, timestamp }) => {
    const { url, status, headers } = response;
    if (url.includes('.rad') || url.includes('/_p5rad/')) {
      const lifecycle = requestLifecycle.get(requestId);
      if (lifecycle) {
        lifecycle.responseReceived = timestamp;
      }

      const contentRange = headers['content-range'] || headers['Content-Range'] || null;
      const rangeHeader = headers['range'] || headers['Range'] || null;
      const lowerHeaders = Object.fromEntries(Object.entries(headers || {})
        .map(([key, value]) => [key.toLowerCase(), value]));
      networkLog.push({
        timestamp: Date.now(), requestId, url, status, range: rangeHeader, contentRange,
        proxyRunId: lowerHeaders['x-p5-run-id'] || null,
        proxyMethod: lowerHeaders['x-p5-scheduler-method'] || null,
        proxyRequestId: lowerHeaders['x-p5-proxy-request-id'] || null,
        proxyOriginUrl: lowerHeaders['x-p5-origin-url'] || null,
        proxySourceSha256: lowerHeaders['x-p5-scheduler-source-sha256'] || null
      });
      console.log(`[Network] ${status} ${url.split('/').pop()} | Range:${rangeHeader} | CR:${contentRange}`);
    }
  });

  cdp.on('Network.dataReceived', ({ requestId, timestamp, encodedDataLength }) => {
    const lifecycle = requestLifecycle.get(requestId);
    if (!lifecycle) return;
    if (lifecycle.firstData == null) lifecycle.firstData = timestamp;
    lifecycle.lastData = timestamp;
    lifecycle.dataBytes += encodedDataLength || 0;
  });

  cdp.on('Network.loadingFinished', ({ requestId, timestamp }) => {
    const lifecycle = requestLifecycle.get(requestId);
    if (lifecycle) {
      lifecycle.finished = timestamp;
    }
  });

  cdp.on('Network.loadingFailed', ({ requestId, timestamp, errorText }) => {
    const lifecycle = requestLifecycle.get(requestId);
    if (lifecycle) {
      lifecycle.failed = true;
      lifecycle.errorText = errorText;
      lifecycle.finished = timestamp;
    }
  });

  // Navigate to Spark (120s timeout for N=4 concurrent load)
  // URL must include p5_test=1 for __P5TraceBridge to be injected
  const pageUrl = viteUrl.includes('p5_test=1') ? viteUrl
    : viteUrl + (viteUrl.includes('?') ? '&' : '?') + 'p5_test=1';
  page.on('console', (msg) => console.log(`[PageConsole] ${msg.type()} ${msg.text()}`));
  page.on('pageerror', (err) => console.error(`[PageError] ${err && err.message}`));
  page.on('requestfailed', (req) => console.error(`[RequestFailed] ${req.url()} ${req.failure() && req.failure().errorText}`));
  console.log(`[RemoteWorker] Loading: ${pageUrl}`);
  let firstRequestAt = null;
  let first206At = null;
  let diagnosticRad206Count = 0;
  page.on('request', request => { if (!firstRequestAt && /rad|p5|splat/i.test(request.url())) firstRequestAt = new Date().toISOString(); });
  page.on('response', response => { if (response.status() === 206) { diagnosticRad206Count += 1; if (!first206At) first206At = new Date().toISOString(); } });
  await page.exposeBinding('__p5ExpBind', (_source, evt) => {
    try {
      fs.appendFileSync(path.join(evidenceDir, `${clientId}_spark_events.jsonl`), JSON.stringify({logged_at_ms: Date.now(), ...evt}) + "\n");
    } catch (error) {
      console.warn('[RemoteWorker] spark event log failed', error && error.message);
    }
  });
  await page.addInitScript(() => {
    window.__sparkExpEvent = (evt) => {
      if (window.__p5ExpBind) window.__p5ExpBind(evt);
    };
  });
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });

  if (config.diagnosticOnly === true) {
    const navigation = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const canvas = document.querySelector('canvas');
      let gl = null;
      if (canvas) gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      const debug = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return {
        webgl2: !!(canvas && canvas.getContext('webgl2')),
        webgl: !!gl,
        unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
        vendor: gl ? gl.getParameter(gl.VENDOR) : null,
        renderer: gl ? gl.getParameter(gl.RENDERER) : null,
        antialias: gl ? gl.getContextAttributes()?.antialias ?? null : null,
        devicePixelRatio: window.devicePixelRatio,
        viewport: {width: window.innerWidth, height: window.innerHeight},
        userAgent: navigator.userAgent,
        navigationStart: nav ? new Date(performance.timeOrigin).toISOString() : null,
        domContentLoaded: nav ? nav.domContentLoadedEventEnd : null,
        sparkGlobals: Object.keys(window).filter(k => /spark|p5|splat|lod/i.test(k)).slice(0, 50)
      };
    });
    const measurementStartAt = new Date().toISOString();
    const diagnosticBridgeReady = await page.waitForFunction(
      () => typeof window.__P5TraceBridge !== 'undefined' && window.__P5TraceBridge.ready === true,
      {timeout: VISUAL_READY_MAX_MS}
    ).then(() => true).catch(() => false);
    if (!diagnosticBridgeReady) throw new Error('DIAGNOSTIC_TRACE_BRIDGE_NOT_READY');
    const diagnosticTraceLoaded = await page.evaluate(td => window.__P5TraceBridge.loadTrace(td), traceData);
    if (!diagnosticTraceLoaded) throw new Error('DIAGNOSTIC_TRACE_LOAD_FAILED');
    const diagnosticReplayStarted = await page.evaluate(() => window.__P5TraceBridge['startReplay']());
    if (!diagnosticReplayStarted) throw new Error('DIAGNOSTIC_TRACE_REPLAY_FAILED');
    const visualGuard = new VisualGuard(page, runId, {getRad206Count: () => diagnosticRad206Count});
    const visualReady = await visualGuard.waitForVisualReady();
    const stableQualityAt = visualReady.ready
      ? new Date(Date.parse(measurementStartAt) + visualReady.duration_ms).toISOString()
      : null;
    const visual = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const gl = canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'));
      return {canvas_present: !!canvas, canvas_width: canvas?.width || 0, canvas_height: canvas?.height || 0,
        meaningful_visual_observed: !!(canvas && canvas.width > 0 && canvas.height > 0),
        sampled_at: new Date().toISOString()};
    });
    const timing = {
      controller_launch_request: config.controllerLaunchRequest || null,
      browser_process_start: new Date().toISOString(),
      navigation_start: navigation.navigationStart,
      page_js_start: new Date().toISOString(),
      page_dom_content_loaded_ms: navigation.domContentLoaded,
      first_request_at: firstRequestAt,
      first_http_206_at: first206At,
      first_decode_at: navigation.domContentLoaded ? navigation.navigationStart : null,
      first_meaningful_visual_at: visual.meaningful_visual_observed ? visual.sampled_at : null,
      stable_quality_at: stableQualityAt,
      measurement_start_at: measurementStartAt,
      worker_ready: new Date().toISOString()
    };
    let windows = {};
    try {
      const ps = 'Get-CimInstance Win32_Process | Where-Object {$_.Name -match "chrome|node"} | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
      windows.processes = JSON.parse(execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command', ps], {encoding: 'utf8', timeout: 5000}));
      windows.adapters = execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command', 'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress'], {encoding: 'utf8', timeout: 5000}).trim();
      try {
        windows.nvidia_smi = execFileSync('nvidia-smi.exe', ['--query-gpu=index,name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], {encoding: 'utf8', timeout: 5000}).trim();
      } catch (error) {
        windows.nvidia_smi = `NOT_AVAILABLE:${error.code || error.message}`;
      }
    } catch (error) { windows.collection_error = error.message; }
    const gpuEvidence = buildGpuPathEvidence({
      clientId, runId, scientificEpoch: config.scientificEpoch,
      gpu: {unmaskedVendor: navigation.unmaskedVendor, unmaskedRenderer: navigation.unmaskedRenderer,
        vendor: navigation.vendor, renderer: navigation.renderer, browserPid: process.pid},
      page: navigation, timing, windows
    });
    fs.writeFileSync(path.join(evidenceDir, `HEADED_GPU_PATH_${clientId}.json`), JSON.stringify(gpuEvidence, null, 2));
    fs.writeFileSync(path.join(evidenceDir, `TIMING_WATERFALL_${clientId}.json`), JSON.stringify({schema_version: 1, diagnostic_only: true, run_id: runId, client_id: clientId, timing, stable_quality: {criterion: 'cleanroom_visual_guard.VISUAL_READY', result: visualReady}}, null, 2));
    fs.writeFileSync(path.join(evidenceDir, 'READY'), JSON.stringify({
      clientId, runId, timestamp: new Date().toISOString(), pid: process.pid,
      hostname: os.hostname(), visual_ready_ms: Math.max(1, Date.now() - startTime),
      trace_loaded: true, frames_replayed_at_ready: 0,
      config_sha256: actualConfigSha256,
      worker_sha256: config.workerSha256, trace_sha256: config.traceSha256,
      actuation_contract_sha256: config.actuationContractSha256,
      scheduler_contract_sha256: config.schedulerContractSha256
    }));
    fs.writeFileSync(path.join(evidenceDir, 'DONE'), JSON.stringify({
      clientId, runId, timestamp: new Date().toISOString(), rad_206_count: 0,
      frames_replayed: 0, verdict: 'DIAGNOSTIC_ONLY', invalid_reason: null
    }));
    fs.writeFileSync(path.join(evidenceDir, `${clientId}_evidence.json`), JSON.stringify({
      schema_version: 1, diagnostic_only: true, runId, clientId,
      verdict: 'DIAGNOSTIC_ONLY', visual_ready_ms: Math.max(1, Date.now() - startTime),
      timing_waterfall: timing
    }, null, 2));
    fs.writeFileSync(path.join(evidenceDir, `${clientId}_network.jsonl`), '');
    writeEvidenceManifest();
    try { await context.close(); } catch (_) {}
    cleanupProfile();
    return {diagnostic_only: true, verdict: 'DIAGNOSTIC_ONLY', gpuEvidence};
  }

  // --- VISUAL_READY GATE (command41 Section I) ---
  // Wait for __P5TraceBridge.ready
  console.log('[RemoteWorker] Waiting for __P5TraceBridge.ready...');
  const bridgeReady = await page.waitForFunction(
    () => typeof window.__P5TraceBridge !== 'undefined' && window.__P5TraceBridge.ready === true,
    null,
    { timeout: VISUAL_READY_MAX_MS }
  ).then(() => true).catch((err) => {
    console.error(`[RemoteWorker] bridge wait ended: ${err && err.message}`);
    return false;
  });

  if (!bridgeReady) {
    console.error('[RemoteWorker] VISUAL_READY FAIL: __P5TraceBridge not ready within 20s');
    try { await context.close(); } catch (_) {}
    cleanupProfile();
    fs.writeFileSync(path.join(evidenceDir, `${clientId}_error.json`), JSON.stringify({
      runId, clientId, hostname: os.hostname(),
      error: 'VISUAL_READY_FAIL: P5TraceBridge not ready',
      timestamp: new Date().toISOString(), verdict: 'INVALID_VISUAL_READY_FAIL',
    }, null, 2));
    process.exit(4);
  }
  console.log('[RemoteWorker] __P5TraceBridge.ready = true');

  // Load the trace but do not replay before the controller's exact barrier.
  console.log(`[RemoteWorker] Injecting trace: ${traceData.name} (${traceData.frame_count} frames)`);
  const loadOk = await page.evaluate((td) => {
    const ok = window.__P5TraceBridge.loadTrace(td);
    if (!ok) console.error('[P5TraceBridge] loadTrace failed:', window.__P5TraceBridge.traceError);
    return ok;
  }, traceData);

  if (!loadOk) {
    const traceErr = await page.evaluate(() => window.__P5TraceBridge.traceError || 'unknown').catch(() => 'eval_failed');
    console.error(`[RemoteWorker] VISUAL_READY FAIL: loadTrace failed: ${traceErr}`);
    try { await context.close(); } catch (_) {}
    cleanupProfile();
    fs.writeFileSync(path.join(evidenceDir, `${clientId}_error.json`), JSON.stringify({
      runId, clientId, hostname: os.hostname(),
      error: `VISUAL_READY_FAIL: loadTrace error: ${traceErr}`,
      timestamp: new Date().toISOString(), verdict: 'INVALID_TRACE_LOAD_FAIL',
    }, null, 2));
    process.exit(4);
  }

  visualReadyMs = Date.now() - startTime;
  console.log(`[RemoteWorker] PRE_BARRIER_READY in ${visualReadyMs}ms, trace loaded and replay stopped`);

  // Gate Closure Fix: Diagnostic - check what viewer actually exposes
  try {
    const viewerState = await page.evaluate(() => {
      return {
        hasWorld: typeof window.__world !== 'undefined',
        hasPager: typeof window.__world !== 'undefined' && typeof window.__world.pager !== 'undefined',
        hasVisibleSplats: typeof window.__visibleSplats !== 'undefined',
        worldKeys: typeof window.__world !== 'undefined' ? Object.keys(window.__world) : [],
        pagerKeys: typeof window.__world !== 'undefined' && window.__world.pager ? Object.keys(window.__world.pager) : []
      };
    });
    console.log('[RemoteWorker] Viewer state diagnostic:', JSON.stringify(viewerState));

    // Robust polling regardless of __world existence
    await page.evaluate(() => {
      if (!window.__splatPoller) {
        console.log('[GATE_CLOSURE_FIX] Starting robust visibleSplats polling');
        window.__visibleSplats = 0;
        window.__totalSplats = 0;

        window.__splatPoller = setInterval(() => {
          // Try multiple paths to find visibleSplats
          if (window.__world && window.__world.pager && typeof window.__world.pager.visibleSplats === 'number') {
            window.__visibleSplats = window.__world.pager.visibleSplats;
            window.__totalSplats = window.__world.pager.totalSplats || 0;
          }
          // Add additional paths if viewer uses different structure
        }, 100);
      }
    });
    console.log('[RemoteWorker] Robust visibleSplats polling injected');
  } catch (e) {
    console.warn(`[RemoteWorker] Polling injection failed: ${e.message}`);
  }

  // READY proves browser/bridge/trace/config readiness, not pre-barrier replay.
  writeReadyAtomic(fs, evidenceDir, {
    clientId, runId, timestamp: new Date().toISOString(),
    pid: process.pid, hostname: os.hostname(),
    visual_ready_ms: visualReadyMs,
    trace_loaded: true,
    frames_replayed_at_ready: 0,
    config_sha256: actualConfigSha256,
    worker_sha256: actualWorkerSha256,
    trace_sha256: traceSha256,
    actuation_contract_sha256: actualActuationContractSha256,
    scheduler_contract_sha256: schedulerContractSha256
  });
  console.log('[RemoteWorker] READY file written');

  const barrierPath = path.join(evidenceDir, 'BARRIER.json');
  const barrierDeadline = Date.now() + 240000; // Increased from 180s to 240s for N3 C5 initialization variance
  let barrier = null;
  while (Date.now() <= barrierDeadline) {
    if (fs.existsSync(barrierPath)) {
      try {
        const candidate = JSON.parse(fs.readFileSync(barrierPath, 'utf8'));
        const errors = validateBarrierRelease(candidate, {
          run_id: runId,
          client_id: clientId,
          cell_id: cellId,
          scientific_epoch: scientificEpoch,
          matrix_sha256: matrixSha256,
          topology_sha256: topologySha256,
          phase_offset_seconds: phaseOffset,
          seed,
          trace_sha256: traceSha256,
          config_sha256: actualConfigSha256,
          scheduler_contract_sha256: schedulerContractSha256
        });
        if (errors.length > 0) throw new Error(errors.join(','));
        barrier = candidate;
        break;
      } catch (error) {
        const message = String(error && error.message || error);
        if (message.includes("EBUSY") || error instanceof SyntaxError) {
          await new Promise(resolve => setTimeout(resolve, 200));
          continue;
        }
        console.error(`[RemoteWorker] Invalid barrier: ${message}`);
        throw new Error(`BARRIER_INVALID:${message}`);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!barrier) {
    console.error('[RemoteWorker] BARRIER timeout');
    throw new Error('BARRIER_TIMEOUT');
  }
  const serverNow = () => Date.now() + clockOffsetMs;
  const targetMeasurementStart = barrier.barrier_epoch_ms + phaseOffset * 1000;
  const replayReleaseAt = targetMeasurementStart - REPLAY_WARMUP_MS;
  const barrierWait = replayReleaseAt - serverNow();
  if (barrierWait > 0) await new Promise(resolve => setTimeout(resolve, barrierWait));
  const replayCommandAt = Date.now();
  const replayOk = await boundedAwait(
    page.evaluate(() => window.__P5TraceBridge.startReplay()),
    10000,
    'START_REPLAY_TIMEOUT'
  );
  if (!replayOk) {
    console.error('[RemoteWorker] startReplay rejected after barrier');
    throw new Error('START_REPLAY_REJECTED_AFTER_BARRIER');
  }
  const cameraMoving = await page.waitForFunction(
    () => window.__P5TraceBridge.framesReplayed > 0,
    { timeout: VISUAL_READY_MAX_MS }
  ).then(() => true).catch(() => false);
  if (!cameraMoving) {
    console.error('[RemoteWorker] camera did not move after barrier release');
    throw new Error('CAMERA_DID_NOT_MOVE_AFTER_BARRIER');
  }
  const measurementWait = targetMeasurementStart - serverNow();
  if (measurementWait > 0) {
    await new Promise(resolve => setTimeout(resolve, measurementWait));
  }

  // --- MEASUREMENT WINDOW ---
  // Capture start BEFORE screenshot so screenshot overhead excluded
  measurementStart = Date.now();  // Assign to function-scoped variable
  const measurementStartSkewMs = serverNow() - targetMeasurementStart;
  if (Math.abs(measurementStartSkewMs) > 3000) {
    console.error(`[RemoteWorker] measurement start skew invalid: ${measurementStartSkewMs}ms`);
    throw new Error(`MEASUREMENT_START_SKEW_INVALID:${measurementStartSkewMs}`);
  }
  console.log(`[RemoteWorker] Measurement started at ${new Date(measurementStart).toISOString()} (skew: ${measurementStartSkewMs}ms)`);

  // Start resource sampler (command227 PHASE 3)
  startResourceSampler();

  // Strict deadline: measurement must end at measurementStart + duration*1000
  const measurementDeadline = measurementStart + duration * 1000;

  // QoE timeline sampling (Command 215 Phase B)
  // Lightweight sampling for Q5/Q10/T1M/blank_ratio computation
  // Fixed per renderer API investigation: Use window.__visibleSplats (auto-updated by viewer)
  const visualTimeline = [];
  const sampleVisualQuality = async () => {
    try {
      const result = await page.evaluate(() => {
        const timestamp = Date.now();
        let visibleSplats = 0;

        // Primary path: viewer's auto-updated cache (updated every 100ms by viewer itself)
        if (typeof window.__visibleSplats === 'number') {
          visibleSplats = window.__visibleSplats;
        }
        // Fallback: direct pager access (may be null early)
        else if (window.__world && window.__world.pager && typeof window.__world.pager.visibleSplats === 'number') {
          visibleSplats = window.__world.pager.visibleSplats;
        }

        const framesReplayed = (window.__P5TraceBridge && window.__P5TraceBridge.framesReplayed) || 0;
        const playback = window.__P5TraceBridge && window.__P5TraceBridge.getPlayback
          ? window.__P5TraceBridge.getPlayback()
          : null;
        return { timestamp, visibleSplats, framesReplayed, playback };
      });
      visualTimeline.push(result);
    } catch (e) {
      // Non-fatal: sampling failed but don't abort measurement
      console.warn(`[RemoteWorker] Visual sampling failed: ${e.message}`);
    }
  };

  // Start background sampling at 100ms intervals (sufficient for 500ms Q5 window)
  const samplingInterval = setInterval(sampleVisualQuality, 100);
  const g0Path = path.join(evidenceDir, `${clientId}_g0.jsonl`);
  const g0Interval = setInterval(async () => {
    try {
      const batch = await page.evaluate(() => {
        const log = window.__P5G0Log || [];
        if (!log.length) return [];
        const out = log.splice(0, log.length);
        return out;
      });
      if (batch && batch.length) {
        fs.appendFileSync(g0Path, batch.map((row) => JSON.stringify(row)).join('\n') + '\n');
      }
    } catch (err) {
      console.error('[RemoteWorker] G0 drain:', err.message);
    }
  }, 500);

  // Take initial sample
  await sampleVisualQuality();

  // Canvas-only fidelity frames. Absent fidelity_sample_ms leaves this off.
  const fidelitySampleMs = Number(runtimeSemantics && runtimeSemantics.fidelity_sample_ms);
  const fidelityFrames = [];
  let fidelityBusy = false;
  let fidelityTimer = null;
  let fidelityPending = Promise.resolve();
  if (Number.isFinite(fidelitySampleMs) && fidelitySampleMs >= 500) {
    const captureFidelity = async () => {
      if (fidelityBusy) {
        fidelityFrames.push({ t_ms: Date.now() - measurementStart, ok: false, error: 'CAPTURE_OVERLAP' });
        return;
      }
      fidelityBusy = true;
      const tMs = Date.now() - measurementStart;
      const name = `fidelity_t_${String(Math.max(0, Math.round(tMs))).padStart(6, '0')}.png`;
      const started = Date.now();
      try {
        const pose = await page.evaluate(() => {
          const bridge = window.__P5TraceBridge;
          return bridge && bridge.getState ? bridge.getState() : null;
        });
        await page.locator('canvas').first().screenshot({
          path: path.join(evidenceDir, name),
          timeout: 1500,
          animations: 'disabled'
        });
        const bytes = fs.statSync(path.join(evidenceDir, name)).size;
        fidelityFrames.push({
          t_ms: tMs, file: name, bytes, ok: bytes > 0,
          capture_ms: Date.now() - started,
          frames_replayed: pose && pose.framesReplayed,
          camera: pose && pose.camera
        });
      } catch (e) {
        fidelityFrames.push({
          t_ms: tMs, file: name, ok: false, capture_ms: Date.now() - started,
          error: String(e && e.message || e).slice(0, 180)
        });
      } finally {
        fidelityBusy = false;
      }
    };
    const kick = () => { fidelityPending = captureFidelity().catch(() => {}); };
    fidelityTimer = setInterval(kick, fidelitySampleMs);
    kick();
  }

  // Screenshot at start of measurement (best-effort, non-blocking for timing)
  const takeScreenshot = async (name, nominal_time) => {
    try {
      const screenshotPath = path.join(evidenceDir, `screenshot_${name}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 30000 });
      screenshots.push({ time: nominal_time, path: `screenshot_${name}.png` });
      console.log(`[RemoteWorker] Screenshot: ${name}`);
    } catch (e) {
      console.error(`[RemoteWorker] Screenshot ${name} FAILED: ` + e.message);
      throw new Error(`SCREENSHOT_CAPTURE_FAILED:${name}:${e.message}`);
    }
  };

  if (screenshotSampled) {
    await takeScreenshot('start', 0);

    // Dense checkpoints are restricted to frozen acceptance/sentinel/representative samples.
    const checkpoints = [30, 60];
    for (const checkpoint of checkpoints) {
      if (checkpoint >= duration) break;
      const checkpointDeadline = measurementStart + checkpoint * 1000;
      const waitTime = checkpointDeadline - Date.now();
      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
      await takeScreenshot(`${checkpoint}s`, checkpoint);
    }
  }

  // Wait until measurement deadline
  // FIX: Use Node.js setTimeout instead of page.waitForTimeout to avoid Playwright drift
  const remainingTime = measurementDeadline - Date.now();
  if (remainingTime > 0) {
    await new Promise(resolve => setTimeout(resolve, remainingTime));
  }

  // Stop visual sampling
  clearInterval(samplingInterval);
  clearInterval(g0Interval);
  try {
    const tail = await page.evaluate(() => {
      const log = window.__P5G0Log || [];
      const out = log.splice(0, log.length);
      return out;
    });
    if (tail && tail.length) {
      fs.appendFileSync(g0Path, tail.map((row) => JSON.stringify(row)).join('\n') + '\n');
    }
  } catch (err) {
    console.error('[RemoteWorker] G0 final drain:', err.message);
  }
  if (fidelityTimer) clearInterval(fidelityTimer);
  await fidelityPending;
  await sampleVisualQuality(); // Final sample
  if (Number.isFinite(fidelitySampleMs) && fidelitySampleMs >= 500) {
    fs.writeFileSync(path.join(evidenceDir, 'fidelity_manifest.json'), JSON.stringify({
      interval_ms: fidelitySampleMs,
      measurement_start_ms: measurementStart,
      frame_count: fidelityFrames.length,
      frames: fidelityFrames
    }, null, 2));
  }

  // Stop resource sampler and collect samples (command227 PHASE 3)
  const finalResourceSamples = stopResourceSampler();

  // Bind measurement closure to the frozen deadline; screenshot overhead is outside the window.
  measurementEnd = measurementDeadline;
  actualDuration = duration;
  console.log(`[RemoteWorker] Measurement ended. Duration: ${actualDuration.toFixed(3)}s`);
  console.log(`[RemoteWorker] Visual timeline samples: ${visualTimeline.length}`);

  // Final screenshot (AFTER measurement end - overhead doesn't contaminate duration)
  if (screenshotSampled) await takeScreenshot('end', duration);

  // Get final bridge state
  bridgeStateAtEnd = await boundedAwait(
    page.evaluate(() => window.__P5TraceBridge.getState()),
    10000,
    'FINAL_BRIDGE_STATE_TIMEOUT'
  ).catch(() => null);

  // CoNEXT DLS: persist idle-gate / lookahead counters for binding proof (SPADE K=4).
  const sdlStatsAtEnd = await boundedAwait(
    page.evaluate(() => ({
      spark_sdl_k: window.__sparkSdlK || 0,
      sdl: window.__sdlStats || null,
      spade_v2: window.__spadeV2 ? {
        version: window.__spadeV2.version,
        headers_pending_cap: window.__spadeV2.headers_pending_cap,
        body_active_cap: window.__spadeV2.body_active_cap,
        peaks: window.__spadeV2.peaks || null,
      } : null,
      light_draw: window.__lightDraw ? {
        submitted_draws: window.__lightDraw.submitted_draws,
        sample_count: (window.__lightDraw.samples || []).length,
        samples: window.__lightDraw.samples || [],
      } : null,
      draw_inclusion: window.__drawInclusion ? {
        t0: window.__drawInclusion.t0 || null,
        sample_count: (window.__drawInclusion.samples || []).length,
        samples: window.__drawInclusion.samples || [],
        first_draw_elapsed_ms: window.__drawInclusion.first_draw_elapsed_ms || {},
      } : null,
    })),
    5000,
    'SDL_STATS_TIMEOUT'
  ).catch(() => null);
  if (sdlStatsAtEnd) {
    fs.writeFileSync(
      path.join(evidenceDir, 'SDL_STATS.json'),
      JSON.stringify(sdlStatsAtEnd, null, 2)
    );
  }

  // Command244: context.close() moved to guaranteed finally block

  const endTime = Date.now();

  const measurementNetworkLog = networkLog.filter(
    entry => entry.timestamp >= measurementStart && entry.timestamp <= measurementEnd
  );
  // Count .rad 206 responses during the exact measurement window.
  const rad206Count = measurementNetworkLog.filter(
    n => n.status === 206 && (n.url.includes('.rad') || n.url.includes('/_p5rad/'))
  ).length;
  const rad304Count = measurementNetworkLog.filter(
    n => n.status === 304 && (n.url.includes('.rad') || n.url.includes('/_p5rad/'))
  ).length;
  const radOtherCount = measurementNetworkLog.filter(
    n => (n.url.includes('.rad') || n.url.includes('/_p5rad/')) && n.status !== 206 && n.status !== 304
  ).length;

  // Determine validity per command41 Section I/J
  const endFrames = bridgeStateAtEnd && typeof bridgeStateAtEnd.framesReplayed === 'number'
    ? bridgeStateAtEnd.framesReplayed : 0;
  const sampledFrames = visualTimeline.reduce((max, sample) => Math.max(max, sample.framesReplayed || 0), 0);
  const finalFramesReplayed = Math.max(endFrames, sampledFrames);
  const isValid = rad206Count >= RAD_206_MIN && finalFramesReplayed > 0 && rad304Count === 0;
  const invalidReason = !isValid ? (
    rad206Count < RAD_206_MIN ? `rad_206_count=${rad206Count} < minimum ${RAD_206_MIN}` :
    finalFramesReplayed === 0 ? 'framesReplayed=0 (camera not moving during measurement)' :
    rad304Count > 0 ? `rad_304_count=${rad304Count} (cache hit 200/304 regression)` : 'unknown'
  ) : null;

  // Write evidence
  const evidence = {
    runId, clientId,
    hostname: os.hostname(),
    local_ipv4: localIPs,
    pid: process.pid,
    method, runtime_method: runtimeMethod, scene, trace,
    phase_offset: phaseOffset,
    seed,
    capacity,
    runtime_semantics: runtimeSemantics,
    scientific_epoch: scientificEpoch,
    matrix_sha256: matrixSha256,
    topology_sha256: topologySha256,
    full_config_hash: fullConfigHash,
    worker_sha256: workerSha256,
    trace_sha256: traceSha256,
    config_sha256: actualConfigSha256,
    actuation_contract_sha256: actualActuationContractSha256,
    scheduler_contract_sha256: schedulerContractSha256,
    barrier_id: barrier.barrier_id,
    barrier_epoch_ms: barrier.barrier_epoch_ms,
    replay_command_at: new Date(replayCommandAt).toISOString(),
    target_measurement_start: new Date(targetMeasurementStart).toISOString(),
    measurement_start_skew_ms: measurementStartSkewMs,
    duration_requested: duration,
    duration_actual: actualDuration,
    measurement_start: new Date(measurementStart).toISOString(),
    measurement_end: new Date(measurementEnd).toISOString(),
    start_time: new Date(startTime).toISOString(),
    end_time: new Date(endTime).toISOString(),
    visual_ready_ms: visualReadyMs,
    network: {
      rad_206_count: rad206Count,
      rad_304_count: rad304Count,
      rad_other_count: radOtherCount,
      total_rad_requests: measurementNetworkLog.length,
    },
    trace_replay: {
      frames_replayed_at_ready: framesReplayedAtReady,
      frames_replayed_final: finalFramesReplayed,
      camera_changed: bridgeStateAtEnd ? bridgeStateAtEnd.cameraChanged : false,
    },
    visual_sampling: {
      sampled: true, // Always true with QoE timeline
      mode: screenshotSampled ? 'DENSE_CHECKPOINTS' : 'LIGHTWEIGHT_TIMELINE',
      renderer_frames: finalFramesReplayed,
      camera_changed: bridgeStateAtEnd ? bridgeStateAtEnd.cameraChanged : false,
      timeline_samples: visualTimeline.length
    },
    screenshots,
    stage: isValid ? 'done' : 'incomplete',
    verdict: isValid ? 'VALID' : 'INVALID',
    invalid_reason: invalidReason,
  };

  fs.writeFileSync(
    path.join(evidenceDir, `${clientId}_evidence.json`),
    JSON.stringify(evidence, null, 2)
  );

  // Write detailed network log
  fs.writeFileSync(
    path.join(evidenceDir, `${clientId}_network.jsonl`),
    measurementNetworkLog.map(n => JSON.stringify(n)).join('\n') + '\n'
  );

  // Write request lifecycle timings (command227 PHASE 3 - BG1)
  const lifecycleData = Array.from(requestLifecycle.values()).filter(lc =>
    lc.requestSent && (lc.responseReceived || lc.failed)
  );
  if (lifecycleData.length > 0) {
    fs.writeFileSync(
      path.join(evidenceDir, `${clientId}_request_lifecycle.jsonl`),
      lifecycleData.map(lc => JSON.stringify(lc)).join('\n') + '\n'
    );
  }

  // Write visual quality timeline (Command 215 Phase B)
  if (visualTimeline.length > 0) {
    fs.writeFileSync(
      path.join(evidenceDir, `${clientId}_visual_timeline.jsonl`),
      visualTimeline.map(v => JSON.stringify(v)).join('\n') + '\n'
    );
    console.log(`[RemoteWorker] Visual timeline written: ${visualTimeline.length} samples`);
  }

  // Write resource samples (command227 PHASE 3)
  if (finalResourceSamples && finalResourceSamples.length > 0) {
    fs.writeFileSync(
      path.join(evidenceDir, `${clientId}_resource_1hz.jsonl`),
      finalResourceSamples.map(r => JSON.stringify(r)).join('\n') + '\n'
    );
    console.log(`[RemoteWorker] Resource samples written: ${finalResourceSamples.length} samples`);
  }

  // Write DONE file
  const donePath = path.join(evidenceDir, 'DONE');
  fs.writeFileSync(donePath, JSON.stringify({
    clientId, runId,
    timestamp: new Date().toISOString(),
    rad_206_count: rad206Count,
    frames_replayed: finalFramesReplayed,
    verdict: evidence.verdict,
    invalid_reason: invalidReason,
    spark_sdl_k: sdlStatsAtEnd?.spark_sdl_k ?? null,
    sdl_stats: sdlStatsAtEnd?.sdl ?? null,
  }));

  writeEvidenceManifest();

  console.log('[RemoteWorker] DONE file and evidence manifest written');
  console.log(`[RemoteWorker] Summary: rad_206=${rad206Count}, framesReplayed=${finalFramesReplayed}, verdict=${evidence.verdict}`);
  if (!isValid) console.log(`[RemoteWorker] INVALID reason: ${invalidReason}`);

  return evidence;

  } finally {
    // Command244 Section 3.3: Guaranteed browser teardown
    console.log('[RemoteWorker] Entering guaranteed finally teardown');
    const teardownStart = Date.now();
    let graceful_context_close = false;

    if (context) {
      try {
        await context.close();
        graceful_context_close = true;
        console.log('[RemoteWorker] Context closed gracefully');
      } catch (e) {
        console.error('[RemoteWorker] context.close() failed:', e.message);
      }
    }

    try {
      cleanupProfile();
      console.log('[RemoteWorker] Profile cleanup complete');
    } catch (e) {
      console.error('[RemoteWorker] Profile cleanup failed:', e.message);
    }

    // Command244 Section 3.3: Write teardown evidence
    const teardown = {
      run_id: runId,
      client_id: clientId,
      graceful_context_close,
      teardown_duration_ms: Date.now() - teardownStart,
      timestamp: new Date().toISOString(),
    };

    try {
      if (evidenceDirectoryOwned) {
        fs.writeFileSync(
          path.join(evidenceDir, 'BROWSER_TEARDOWN.json'),
          JSON.stringify(teardown, null, 2)
        );
        console.log('[RemoteWorker] BROWSER_TEARDOWN.json written');
      }
    } catch (e) {
      console.error('[RemoteWorker] Failed to write teardown evidence:', e.message);
    }

    console.log('[RemoteWorker] Finally teardown complete');
  }
}

// Main execution
runRemoteTrial()
  .then(evidence => {
    console.log(`[RemoteWorker] Trial complete: ${evidence.verdict}`);
    process.exit(evidence.diagnostic_only === true || evidence.verdict === 'VALID' ? 0 : 1);
  })
  .catch(error => {
    console.error('[RemoteWorker] FATAL ERROR:', error);
    try { cleanupProfile(); } catch (_) {}
    const errorEvidence = {
      runId, clientId, hostname: os.hostname(),
      error: error.message, stack: error.stack,
      timestamp: new Date().toISOString(), verdict: 'ERROR',
    };
    try {
      if (!evidenceDirectoryOwned) throw new Error('EVIDENCE_DIRECTORY_NOT_OWNED');
      fs.writeFileSync(
        path.join(evidenceDir, `${clientId}_error.json`),
        JSON.stringify(errorEvidence, null, 2)
      );
    } catch (_) {}
    process.exit(2);
  });

// TEST MODIFICATION

// TEST MODIFICATION
