/**
 * VRC Experiment Runner — REAL MODE ONLY
 * No smoke mode. No simulation fallback. Requires real Playwright/Chromium.
 * Orchestrates multi-client Playwright sessions for all methods and scenarios.
 * Runs 4 browser clients simultaneously per experiment trial.
 *
 * Hard requirements enforced by this file:
 *   - Real Playwright/Chromium browser only (no --smoke, no synthetic data)
 *   - 4 visible avatars/users per trial
 *   - Real Spark2.0/Web3DGS scene opened by URL (streaming-lod)
 *   - Each run saves: config, client logs, server logs, screenshot, status JSONL
 *   - Never fabricate values; if logs missing → status = FAIL
 *
 * Usage: node experiments/run_experiment.mjs [--full]
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { execSync, spawn } from "node:child_process";
let _visualValidator = null;
async function getVisualValidator() {
  if (!_visualValidator) _visualValidator = await import("./visual_validator.mjs");
  return _visualValidator;
}
async function buildVisualCheck(...args) { return (await getVisualValidator()).buildVisualCheck(...args); }
async function validatePngFile(...args) { return (await getVisualValidator()).validatePngFile(...args); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(ROOT, "..");
// VRC_RESULTS_ROOT lets the orchestrator redirect outputs to a clean tree
// (e.g. vrc-paper\results_260512) without moving files after the run.
// Absolute paths honored as-is; relative paths resolved under vrc-paper/.
const RESULTS_ROOT = process.env.VRC_RESULTS_ROOT
  ? (path.isAbsolute(process.env.VRC_RESULTS_ROOT)
      ? process.env.VRC_RESULTS_ROOT
      : path.resolve(ROOT, process.env.VRC_RESULTS_ROOT))
  : path.join(ROOT, "results");
const RESULTS_RAW = path.join(RESULTS_ROOT, "raw");
const RESULTS_SUMMARY = path.join(RESULTS_ROOT, "summary");
const SCREENSHOTS_DIR = path.join(RESULTS_ROOT, "screenshots");

fs.mkdirSync(RESULTS_RAW, { recursive: true });
fs.mkdirSync(RESULTS_SUMMARY, { recursive: true });
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// ── Config ────────────────────────────────────────────────────────────────────
const ARGS = process.argv.slice(2);

// HARD BLOCK: No smoke mode, no simulation, always full browser
if (ARGS.includes("--smoke") || ARGS.includes("--skip-browser") ||
    process.env.VRC_SMOKE === "1" || process.env.VRC_SMOKE === "true") {
  console.error("[runner] FATAL: --smoke / skip-browser / VRC_SMOKE are disabled in real-experiment mode.");
  console.error("[runner] This pipeline requires real Playwright/Chromium. Remove smoke flags and retry.");
  process.exit(2);
}

const VITE_PORT = Number(process.env.VITE_PORT ?? 9200);
const SYNC_PORT = Number(process.env.VRC_SYNC_PORT ?? 9201);
const NUM_USERS = 4;

/** Which logical users (0..3) this process launches. Default all four on one OS. */
function parseUserIndices() {
  const raw = process.env.VRC_USER_INDICES;
  if (!raw || !String(raw).trim()) return [0, 1, 2, 3];
  const xs = String(raw).split(/[,\s]+/)
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isInteger(n) && n >= 0 && n < NUM_USERS);
  return [...new Set(xs)].sort((a, b) => a - b);
}
const USER_INDICES = parseUserIndices();
const VRC_SHARD_PARTIAL = USER_INDICES.length < NUM_USERS;
/** When set, page URL for browsers (distributed worker2 must use controller LAN, not localhost). */
const VRC_PUBLIC_PAGE_BASE = (process.env.VRC_PUBLIC_PAGE_BASE ?? "").trim().replace(/\/+$/, "");
/** Base URL for vrc_scene (worker2 must use controller LAN IP, e.g. http://10.4.158.143:9200). */
const BROWSER_ORIGIN = (() => {
  if (VRC_PUBLIC_PAGE_BASE) return VRC_PUBLIC_PAGE_BASE;
  const o = (process.env.VRC_BROWSER_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (o) return o;
  return `http://localhost:${VITE_PORT}`;
})();
/** Hostname for sync HTTP/WS from browser + runner configureSession (worker2: controller IP). */
const SYNC_HTTP_HOST = (process.env.VRC_SYNC_HTTP_HOST ?? "localhost").trim() || "localhost";
const VRC_DISTRIBUTED = process.env.VRC_DISTRIBUTED === "true";
const VRC_WORKER_ID = (process.env.VRC_WORKER_ID ?? "").trim();
const VRC_HOST_IP = (process.env.VRC_HOST_IP ?? "").trim();
if (VRC_DISTRIBUTED) {
  if (!VRC_WORKER_ID || !VRC_HOST_IP) {
    console.error("[runner] FATAL: VRC_DISTRIBUTED=true requires VRC_WORKER_ID and VRC_HOST_IP (no silent fallback).");
    process.exit(2);
  }
  if (VRC_WORKER_ID === "worker1" && USER_INDICES.some((i) => i >= 2)) {
    console.error("[runner] FATAL: distributed worker1 must not launch u2/u3 — use VRC_USER_INDICES=0,1 only.");
    process.exit(2);
  }
  if (VRC_WORKER_ID === "worker2" && USER_INDICES.some((i) => i < 2)) {
    console.error("[runner] FATAL: distributed worker2 must not launch u0/u1 — use VRC_USER_INDICES=2,3 only.");
    process.exit(2);
  }
}
const VRC_SKIP_LOCAL_SERVERS = process.env.VRC_SKIP_LOCAL_SERVERS === "1";
const VRC_SKIP_SESSION_CONFIGURE = process.env.VRC_SKIP_SESSION_CONFIGURE === "1";
const TRIAL_DURATION_MS = Number(process.env.VRC_TRIAL_DURATION_MS ?? 30000);
const HEADLESS = process.env.VRC_HEADLESS !== "false";
// VRC_CAPTURE_MODE = "parallel" (default), "sequential", or "metrics_only".
const CAPTURE_MODE = (process.env.VRC_CAPTURE_MODE ?? "parallel").toLowerCase();
const _seqHeavy = CAPTURE_MODE === "sequential";
// Initial wait after navigation (sequential: 4 users × screenshots + GPU — needs more warm-up than parallel).
const SCREENSHOT_DELAY_MS = Number(
  process.env.VRC_SCREENSHOT_DELAY_MS ?? (_seqHeavy ? 28000 : 10000),
);
const SEQUENTIAL_FPS_WAIT_MS = Number(process.env.VRC_SEQ_FPS_WAIT_MS ?? (_seqHeavy ? 22000 : 15000));
// Per-attempt screenshot timeouts — sequential uses highest; parallel still needs >5s on Win/ANGLE when 4 WebGL pages compete.
const CDP_CAPTURE_TIMEOUT_MS = Number(process.env.VRC_CDP_CAPTURE_TIMEOUT_MS ?? (_seqHeavy ? 18000 : 16000));
const VIEWPORT_CAPTURE_TIMEOUT_MS = Number(process.env.VRC_VIEWPORT_CAPTURE_TIMEOUT_MS ?? (_seqHeavy ? 28000 : 22000));
const DATAURL_CAPTURE_TIMEOUT_MS = Number(process.env.VRC_DATAURL_CAPTURE_TIMEOUT_MS ?? (_seqHeavy ? 14000 : 14000));
// Hard per-user outer safety net — must exceed worst-case inner work (CDP+viewport+dataURL+retries).
const PER_USER_CAPTURE_MS = Number(process.env.VRC_PER_USER_CAPTURE_MS ?? (_seqHeavy ? 240000 : 120000));
// After PER_USER_CAPTURE_MS fires, still allow this much time for in-flight CDP/screenshot to finish;
// then stop awaiting so the runner cannot hang indefinitely (u3-style GPU stalls).
const CAPTURE_DRAIN_AFTER_BUDGET_MS = Number(process.env.VRC_CAPTURE_DRAIN_AFTER_BUDGET_MS ?? 90000);
// Visual-ready: chunk / asset traffic (Spark-MU uses stricter defaults).
const MIN_CHUNKS_READY_DEFAULT = Number(process.env.VRC_MIN_CHUNKS_READY ?? 8);
const MIN_ASSET_OK_READY_DEFAULT = Number(process.env.VRC_MIN_ASSET_OK_READY ?? 4);
const SPARK_MU_MIN_CHUNKS = Number(process.env.VRC_SPARK_MU_MIN_CHUNKS ?? 25);
const SPARK_MU_MIN_ASSET_OK = Number(process.env.VRC_SPARK_MU_MIN_ASSET_OK ?? 6);
// Canvas copy variance (luma std) must exceed this before "content" is non-flat.
const MIN_READY_LUMA_STD = Number(process.env.VRC_MIN_READY_LUMA_STD ?? 6);
// Minimum FPS to even attempt screenshot capture. If FPS is below this after
// a short visual-ready probe, mark the user FAIL_VISUAL_LOW_FPS and move on.
const MIN_CAPTURE_FPS = Number(process.env.VRC_MIN_CAPTURE_FPS ?? 5);
const LOW_FPS_PROBE_BUDGET_MS = Number(process.env.VRC_LOW_FPS_PROBE_MS ?? (_seqHeavy ? 60000 : 30000));
// page.goto: serial launch + short commit timeout caused u0/u3 to hit 15s while Vite was busy;
// navigation may still complete in the browser after Playwright rejects the waiter — do not treat
// goto failure as "skip loading". See parallel goto + longer budget below.
// Cap browser log capture so Playwright/node IPC and memory cannot blow up on noisy pages.
const CLIENT_LOGS_MAX_ENTRIES = Number(process.env.VRC_CLIENT_LOGS_MAX ?? 800);
const REQUEST_LOG_MAX_ENTRIES = Number(process.env.VRC_REQUEST_LOG_MAX ?? 3500);
const GOTO_WAIT_UNTIL_RAW = (process.env.VRC_GOTO_WAIT_UNTIL ?? "commit").trim().toLowerCase();
const GOTO_WAIT_ALLOWED = new Set(["commit", "domcontentloaded", "load", "networkidle"]);
const GOTO_WAIT_UNTIL = GOTO_WAIT_ALLOWED.has(GOTO_WAIT_UNTIL_RAW) ? GOTO_WAIT_UNTIL_RAW : "commit";
const GOTO_TIMEOUT_MS = Number(process.env.VRC_GOTO_TIMEOUT_MS ?? 30000);
// CDN (Cloudflare R2 r2.dev). VRC_USE_GCS_ONLY=1 → skip CDN, use Google public .rad only.
// Default object keys match a flat layout under streaming-lod/ (see spark-assets bucket); legacy nested GCS paths are probed second.
const VRC_USE_GCS_ONLY = process.env.VRC_USE_GCS_ONLY === "1";
const VRC_RAD_PUB_DEFAULT = "https://pub-0429777a95db48e192b4c665413f8eb2.r2.dev";
const VRC_RAD_ASSET_BASE_RAW = VRC_USE_GCS_ONLY
  ? ""
  : (process.env.VRC_RAD_ASSET_BASE ?? VRC_RAD_PUB_DEFAULT).trim().replace(/\/+$/, "");
const VRC_RAD_KEY_COIT_FLAT = "streaming-lod/coit-40m-sh1-lod.rad";
const VRC_RAD_KEY_COIT_LEGACY = "streaming-lod/asundqui/rad/260217/coit-40m-sh1-lod.rad";
const VRC_RAD_KEY_HOBBITON_FLAT = "streaming-lod/tijerin_w6_hobbiton-lod.rad";
const VRC_RAD_KEY_HOBBITON_LEGACY = "streaming-lod/asundqui/rad/260219/tijerin_w6_hobbiton-lod.rad";

/** Delivery: empty = legacy (no per-chunk hybrid). See sync_server + vrc_scheduler. */
const VRC_DELIVERY_PROFILE = (process.env.VRC_DELIVERY_PROFILE ?? "").trim();
const VRC_HPC_ASSET_BASE = (process.env.VRC_HPC_ASSET_BASE ?? "http://10.120.17.176:8090").trim().replace(/\/+$/, "");
const VRC_CDN_ASSET_BASE = (process.env.VRC_CDN_ASSET_BASE ?? VRC_RAD_PUB_DEFAULT).trim().replace(/\/+$/, "");
const VRC_CDN2_ASSET_BASE = (process.env.VRC_CDN2_ASSET_BASE ?? "").trim().replace(/\/+$/, "");
/** Optional: when CDN2 uses different keys than flat `streaming-lod/…` (e.g. GCS nested paths under forge-dev-public). */
const VRC_CDN2_OBJECT_PATH = (process.env.VRC_CDN2_OBJECT_PATH ?? "").trim().replace(/^\/+/, "");
const VRC_CDN2_OBJECT_PATH_HOBBITON = (process.env.VRC_CDN2_OBJECT_PATH_HOBBITON ?? "").trim().replace(/^\/+/, "");
/** cdn1 (default) | cdn2 — selects source_selected cdn_r2 vs cdn2 for static_cdn / hybrid hot chunks. */
const VRC_CDN_LABEL = (process.env.VRC_CDN_LABEL ?? "").trim().toLowerCase();
const VRC_HOT_THRESHOLD = Number(process.env.VRC_HOT_THRESHOLD ?? 2);
const VRC_CDN_FALLBACK_TO_HPC = process.env.VRC_CDN_FALLBACK_TO_HPC !== "false";

const METHODS = (process.env.VRC_METHODS ?? "Full,Spark-MU,VP-S,NET-S,VRC-V,VRC-N,VRC-O,VRC")
  .split(",").map(s => s.trim()).filter(Boolean);
const SCENARIOS = (process.env.VRC_SCENARIOS ?? "nearby,burst_turn,divergent")
  .split(",").map(s => s.trim()).filter(Boolean);
const TRIALS = Number(process.env.VRC_TRIALS ?? 3);

// Deduplicate methods list
const UNIQUE_METHODS = [...new Set(METHODS)];

const EXPECTED_RUNS = UNIQUE_METHODS.length * SCENARIOS.length * TRIALS;

function readyThresholdsForMethod(method) {
  if (method === "Spark-MU") {
    return { minChunks: SPARK_MU_MIN_CHUNKS, minAssetOk: SPARK_MU_MIN_ASSET_OK };
  }
  return { minChunks: MIN_CHUNKS_READY_DEFAULT, minAssetOk: MIN_ASSET_OK_READY_DEFAULT };
}

// ── Utility ───────────────────────────────────────────────────────────────────
function waitHttp(url, maxMs = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + maxMs;
    function poll() {
      http.get(url, (res) => {
        if (res.statusCode < 500) resolve();
        else setTimeout(poll, 500);
      }).on("error", () => {
        if (Date.now() > deadline) reject(new Error(`Timeout waiting for ${url}`));
        else setTimeout(poll, 500);
      });
    }
    poll();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg) { console.log(`[runner] ${new Date().toISOString()} ${msg}`); }

function joinRadCdnUrl(base, objectKey) {
  return `${base.replace(/\/+$/, "")}/${String(objectKey).replace(/^\/+/, "")}`;
}

/** Coarse CDN reachability (Range GET); uses browser-like Origin so R2 CORS can be exercised from Node too. */
async function probeRadCdnUrl(fullUrl) {
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(fullUrl, {
      method: "GET",
      headers: {
        Range: "bytes=0-0",
        Origin: `http://localhost:${VITE_PORT}`,
      },
      redirect: "follow",
      signal: ac.signal,
    });
    clearTimeout(tid);
    return res.status;
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

/** Pick first Coit .rad URL that returns 200/206; derive Hobbiton key in same layout. Returns null → use GCS in vrc_scene. */
async function resolveRadCdnForTrial() {
  if (VRC_USE_GCS_ONLY || !VRC_RAD_ASSET_BASE_RAW) return null;
  const base = VRC_RAD_ASSET_BASE_RAW;
  const coitCandidates = [
    process.env.VRC_RAD_KEY_COIT,
    VRC_RAD_KEY_COIT_FLAT,
    VRC_RAD_KEY_COIT_LEGACY,
  ]
    .filter((k) => k && String(k).trim())
    .map((k) => String(k).trim().replace(/^\/+/, ""))
    .filter((k, i, a) => a.indexOf(k) === i);

  for (const keyCoit of coitCandidates) {
    const url = joinRadCdnUrl(base, keyCoit);
    try {
      const st = await probeRadCdnUrl(url);
      if (st === 200 || st === 206) {
        let keyHob = process.env.VRC_RAD_KEY_HOBBITON?.trim().replace(/^\/+/, "");
        if (!keyHob) {
          if (keyCoit.includes("260217/coit-40m-sh1-lod.rad")) {
            keyHob = keyCoit.replace("260217/coit-40m-sh1-lod.rad", "260219/tijerin_w6_hobbiton-lod.rad");
          } else {
            keyHob = keyCoit.replace(/coit-40m-sh1-lod\.rad$/i, "tijerin_w6_hobbiton-lod.rad");
          }
        }
        log(`[rad-cdn] using ${url} (status ${st})`);
        return { base, keyCoit, keyHobbiton: keyHob };
      }
    } catch {
      /* try next candidate */
    }
  }
  log("WARNING: [rad-cdn] no Coit .rad on CDN returned 200/206 — falling back to Google storage for this trial (upload .rad under streaming-lod/ or set VRC_RAD_KEY_COIT)");
  return null;
}

function vrcNavParamsFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return {
      user_id: u.searchParams.get("user_id"),
      method: u.searchParams.get("method"),
      session_id: u.searchParams.get("session_id"),
      scenario_id: u.searchParams.get("scenario_id"),
      sync_port: u.searchParams.get("sync_port"),
      world: u.searchParams.get("world"),
    };
  } catch {
    return null;
  }
}

/** Diagnostics when visual-ready fails with almost no chunk traffic / flat canvas (not SOFT_READY). */
async function logVisualReadyLowChunkDiags(userId, page, requestLog, clientLogs, startUrl, sessionId, method, scenario) {
  const lines = [];
  lines.push(`=== VISUAL_READY_LOW_3D_SIGNAL ${userId} ===`);
  lines.push(`runner_session_id=${sessionId} runner_method=${method} runner_scenario=${scenario}`);
  lines.push(`expected_start_url=${startUrl ?? "n/a"}`);
  let exp = null;
  try {
    exp = startUrl ? vrcNavParamsFromUrl(startUrl) : null;
    if (exp) lines.push(`expected_query=${JSON.stringify(exp)}`);
  } catch (e) {
    lines.push(`expected_query_parse_err=${e.message}`);
  }
  try {
    const live = await page.evaluate(() => ({
      href: location.href,
      readyState: document.readyState,
      visibilityState: document.visibilityState,
    })).catch((e) => ({ eval_error: String(e.message) }));
    lines.push(`document_live=${JSON.stringify(live)}`);
    if (live && live.href && !live.eval_error) {
      const act = vrcNavParamsFromUrl(live.href);
      lines.push(`live_query=${JSON.stringify(act)}`);
      if (exp && act) {
        for (const k of ["method", "session_id", "scenario_id", "sync_port", "world"]) {
          if ((exp[k] || "") !== (act[k] || "")) {
            lines.push(`query_mismatch:${k} expected=${exp[k]} actual=${act[k]}`);
          }
        }
      }
    }
  } catch (e) {
    lines.push(`document_live_error=${e.message}`);
  }
  try {
    const cs = await page.evaluate(() => {
      const c = document.querySelector("canvas");
      if (!c) return { canvas: "missing" };
      const chunks = (window.__vrcRawMetrics && window.__vrcRawMetrics.seen_chunks)
        ? (window.__vrcRawMetrics.seen_chunks.size ?? 0) : 0;
      return { canvas: "ok", w: c.width, h: c.height, chunks };
    }).catch((e) => ({ canvas_eval_error: String(e.message) }));
    lines.push(`canvas_state=${JSON.stringify(cs)}`);
  } catch (e) {
    lines.push(`canvas_state_error=${e.message}`);
  }
  try {
    const nw = requestLog;
    const withSt = nw.filter((r) => r.status != null).length;
    const byHost = {};
    for (const r of nw) {
      if (!r.url) continue;
      let h = "?";
      try {
        h = new URL(r.url).hostname;
      } catch { /* ignore */ }
      byHost[h] = (byHost[h] || 0) + 1;
    }
    lines.push(`network: total_requests=${nw.length} with_status=${withSt} by_host=${JSON.stringify(byHost)}`);
    const tail = nw.filter((r) => r.status != null).slice(-24);
    for (const r of tail) {
      lines.push(`  resp ${r.status} ${String(r.url).slice(0, 160)}`);
    }
  } catch (e) {
    lines.push(`network_summary_error=${e.message}`);
  }
  const recent = clientLogs.filter((l) => l.user_id === userId).slice(-40);
  lines.push(`console_tail(${recent.length}):`);
  for (const l of recent) lines.push(`  [${l.type}] ${String(l.text).slice(0, 500)}`);
  for (const ln of lines) log(`[visual-low-chunks:${userId}] ${ln}`);
}

// Centralized teardown: invoked from the main() success path, the FATAL branches,
// and signal/unhandled-rejection handlers so Vite/sync/any lingering browser
// child trees are never left running. On Windows, proc.kill() does not cascade
// to the child tree — use taskkill /T /F to clean up npx/vite/node descendants.
let teardownDone = false;
export async function teardown(reason = "normal") {
  if (teardownDone) return;
  teardownDone = true;
  log(`Teardown start (${reason})`);
  const isWin = process.platform === "win32";
  function killTree(proc, label) {
    if (!proc || proc.killed) return;
    try {
      if (isWin && proc.pid) {
        execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" });
      } else {
        proc.kill("SIGTERM");
      }
      log(`Killed ${label} (pid=${proc.pid ?? "?"})`);
    } catch (e) {
      log(`Teardown: failed to kill ${label}: ${e.message}`);
    }
  }
  killTree(viteProc, "vite");
  killTree(syncProc, "sync_server");
  // Give OS a moment to release ports before the process exits.
  await sleep(500);
  log(`Teardown done (${reason})`);
}

process.on("SIGINT",  () => { teardown("SIGINT").finally(() => process.exit(130)); });
process.on("SIGTERM", () => { teardown("SIGTERM").finally(() => process.exit(143)); });
process.on("unhandledRejection", (err) => {
  console.error("[runner] unhandledRejection:", err);
  teardown("unhandledRejection").finally(() => process.exit(1));
});
process.on("uncaughtException", (err) => {
  console.error("[runner] uncaughtException:", err);
  teardown("uncaughtException").finally(() => process.exit(1));
});

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}

function writeRunStatus(runDir, status, info) {
  const statusFile = path.join(runDir, "status.json");
  fs.writeFileSync(statusFile, JSON.stringify({ ...info, status, timestamp: new Date().toISOString() }, null, 2));
}

function writeRunConfig(runDir, config) {
  fs.writeFileSync(path.join(runDir, "config.json"), JSON.stringify(config, null, 2));
}

// ── Vite dev server ───────────────────────────────────────────────────────────
let viteProc = null;

export async function startVite() {
  try {
    await waitHttp(`http://localhost:${VITE_PORT}`, 1000);
    log(`Vite already running on port ${VITE_PORT}`);
    return true;
  } catch {}

  log(`Starting Vite on port ${VITE_PORT}...`);
  try { execSync("npm list vite", { cwd: REPO_ROOT, stdio: "ignore" }); } catch {
    log("Installing npm deps...");
    execSync("npm install", { cwd: REPO_ROOT, stdio: "inherit" });
  }

  viteProc = spawn("npx", ["vite", "--port", String(VITE_PORT), "--host", "0.0.0.0"], {
    cwd: REPO_ROOT, stdio: "pipe",
    shell: process.platform === "win32",
  });
  viteProc.stderr?.on("data", (d) => { if (d.toString().includes("error")) log(`[vite] ${d}`); });
  viteProc.stdout?.on("data", (d) => { if (d.toString().includes("Local")) log(`[vite] ${d.toString().trim()}`); });
  try {
    await waitHttp(`http://localhost:${VITE_PORT}`, 60000);
    log("Vite running");
    return true;
  } catch {
    log("FATAL: Vite failed to start within 60s. Cannot run real experiments.");
    return false;
  }
}

// ── Sync server ───────────────────────────────────────────────────────────────
let syncProc = null;

export async function startSyncServer() {
  try {
    await waitHttp(`http://localhost:${SYNC_PORT}/health`, 1000);
    log(`Sync server already running on port ${SYNC_PORT}`);
    return true;
  } catch {}

  log(`Starting sync server on port ${SYNC_PORT}...`);
  const serverDir = path.join(ROOT, "server");

  try { execSync("npm list ws", { cwd: serverDir, stdio: "ignore" }); } catch {
    execSync("npm install", { cwd: serverDir, stdio: "inherit" });
  }

  syncProc = spawn("node", ["sync_server.mjs"], {
    cwd: serverDir,
    stdio: "pipe",
    env: {
      ...process.env,
      VRC_SYNC_PORT: String(SYNC_PORT),
      VRC_SYNC_BIND: process.env.VRC_SYNC_BIND || "0.0.0.0",
      VRC_LOG_DIR: RESULTS_RAW,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=4096`.trim(),
      VRC_DELIVERY_PROFILE: VRC_DELIVERY_PROFILE || process.env.VRC_DELIVERY_PROFILE || "",
      VRC_HPC_ASSET_BASE: VRC_HPC_ASSET_BASE || "",
      VRC_CDN_ASSET_BASE: VRC_CDN_ASSET_BASE || "",
      VRC_CDN2_ASSET_BASE: VRC_CDN2_ASSET_BASE || "",
      VRC_CDN_LABEL: VRC_CDN_LABEL || "",
      VRC_HOT_THRESHOLD: String(VRC_HOT_THRESHOLD),
      VRC_CDN_FALLBACK_TO_HPC: VRC_CDN_FALLBACK_TO_HPC ? "true" : "false",
    },
    shell: process.platform === "win32",
  });
  syncProc.stderr?.on("data", (d) => log(`[sync] ${d}`));
  syncProc.stdout?.on("data", (d) => log(`[sync] ${d}`));
  try {
    await waitHttp(`http://localhost:${SYNC_PORT}/health`, 15000);
    log("Sync server running");
    return true;
  } catch {
    log("WARNING: Sync server failed to start — continuing without it (some metrics may be missing)");
    return false;
  }
}

// ── Configure session ─────────────────────────────────────────────────────────
async function configureSession(sessionId, method, extra = {}) {
  if (VRC_SKIP_SESSION_CONFIGURE) {
    log(`[sync] skip configureSession (VRC_SKIP_SESSION_CONFIGURE=1)`);
    return;
  }
  return new Promise((resolve) => {
    const bodyObj = Object.fromEntries(
      Object.entries({
        session_id: sessionId,
        method,
        scenario: extra.scenario,
        trial: extra.trial,
        delivery_profile: extra.delivery_profile,
        hot_threshold: extra.hot_threshold,
        hpc_asset_base: extra.hpc_asset_base,
        cdn_asset_base: extra.cdn_asset_base,
        cdn2_asset_base: extra.cdn2_asset_base,
        cdn_label: extra.cdn_label,
      }).filter(([, v]) => v !== undefined && v !== ""),
    );
    const body = JSON.stringify(bodyObj);
    const req = http.request({
      hostname: SYNC_HTTP_HOST, port: SYNC_PORT, path: "/session/new",
      method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => { res.resume(); resolve(); });
    req.on("error", () => resolve()); // sync server may be absent
    req.write(body);
    req.end();
  });
}

function isChunkAssetUrl(u) {
  return !!(u && /\.(rad|spz|splat)(\?|#|$)/i.test(String(u)));
}

function normalizeRangeHeader(h) {
  if (h == null) return "";
  const s = String(h).trim();
  return s;
}

/**
 * Merge Playwright request rows with browser-side __vrcSourceEvents (same user + final URL + Range).
 */
function enrichRequestLogsWithSourceEvents(requestLogs, sourceEventsFlat, trialIdx, deliveryProfile, sessionId, method, scenario) {
  const map = new Map();
  const cLab = VRC_CDN_LABEL || "";
  for (const e of sourceEventsFlat) {
    const rangeK = normalizeRangeHeader(e.range_key);
    const key = `${e.user_id}\t${e.final_url}\t${rangeK}`;
    map.set(key, e);
  }
  return requestLogs.map((r) => {
    const rangeK = normalizeRangeHeader(r.range ?? r.req_range);
    const lookupKey = `${r.user_id}\t${r.url}\t${rangeK}`;
    const ev = map.get(lookupKey);
    const base = {
      ...r,
      delivery_profile: deliveryProfile,
      cdn_label: cLab,
      method,
      scenario,
      trial: trialIdx,
      session_id: sessionId,
    };
    if (ev) {
      return {
        ...base,
        original_url: ev.original_url,
        final_url: ev.final_url,
        source_url: ev.final_url,
        source_selected: ev.source_selected,
        source_base: ev.source_base,
        source_reason: ev.source_reason,
        fallback_used: !!ev.fallback_used,
        fetch_plan_version: ev.fetch_plan_version ?? null,
        chunk_key: ev.chunk_key ?? null,
        object_key: ev.object_key ?? null,
        range_key: (ev.range_key != null && String(ev.range_key).length) ? ev.range_key : (rangeK || null),
        object_or_range_completion_ms: ev.object_or_range_completion_ms,
      };
    }
    if (isChunkAssetUrl(r.url) && deliveryProfile !== "legacy") {
      return {
        ...base,
        original_url: r.url,
        final_url: r.url,
        source_url: r.url,
        source_selected: "unmatched",
        source_reason: "no_browser_source_event",
        fallback_used: false,
        fetch_plan_version: null,
        chunk_key: null,
        object_key: null,
        range_key: rangeK || null,
      };
    }
    return {
      ...base,
      original_url: r.url,
      final_url: r.url,
      source_url: r.url,
      source_selected: "non_chunk_asset",
      source_reason: "exempt",
      fallback_used: false,
      fetch_plan_version: null,
      chunk_key: null,
      object_key: null,
      range_key: rangeK || null,
    };
  });
}

export function computeSourceBreakdownFromChunkLogs(chunkLogs) {
  let hpc_request_count = 0;
  let cdn_request_count = 0;
  let cdn2_request_count = 0;
  let hpc_bytes = 0;
  let cdn_bytes = 0;
  let cdn2_bytes = 0;
  let fallback_count = 0;
  let fallback_bytes = 0;
  let shared_hot_cdn_hits = 0;
  let personalized_hpc_hits = 0;
  const n = chunkLogs.length;
  for (const r of chunkLogs) {
    const bytes = Number(r.bytes_sent ?? r.bytes ?? 0) || 0;
    const sel = r.source_selected;
    const fb = !!r.fallback_used;
    if (sel === "hpc_server") {
      hpc_request_count++;
      hpc_bytes += bytes;
      if (fb) {
        fallback_count++;
        fallback_bytes += bytes;
      }
      if (!fb && (r.source_reason === "personalized" || r.source_reason === "cold" || r.source_reason === "origin_only")) {
        personalized_hpc_hits++;
      }
    } else if (sel === "cdn_r2") {
      cdn_request_count++;
      cdn_bytes += bytes;
      if (r.source_reason === "shared_hot") shared_hot_cdn_hits++;
    } else if (sel === "cdn2") {
      cdn2_request_count++;
      cdn2_bytes += bytes;
    }
  }
  const total = Math.max(1, n);
  return {
    hpc_request_count,
    cdn_request_count,
    cdn2_request_count,
    hpc_bytes,
    cdn_bytes,
    cdn2_bytes,
    fallback_count,
    fallback_bytes,
    shared_hot_cdn_ratio: shared_hot_cdn_hits / total,
    personalized_origin_ratio: personalized_hpc_hits / total,
  };
}

export function validateSourceConsistency(deliveryProfile, chunkLogs, vrcDecisions, meta = {}) {
  const errors = [];
  const cdnLabel = String(meta.cdn_label ?? "").trim().toLowerCase();
  if (!deliveryProfile || deliveryProfile === "legacy") {
    return { valid: true, errors, mixed_source_valid: true, INVALID_MIXED_SOURCE: false };
  }
  const chunkRows = chunkLogs.filter((r) =>
    isChunkAssetUrl(r.url)
    && r.service_time_ms !== undefined
    && r.service_time_ms > 0
    && r.service_time_ms < 120000,
  );
  let INVALID_MIXED_SOURCE = false;
  const hasCdnChunk = chunkRows.some((r) => (r.source_selected === "cdn_r2" || r.source_selected === "cdn2") && !r.fallback_used);
  const hasHpcChunk = chunkRows.some((r) => r.source_selected === "hpc_server" && !r.fallback_used);

  if (deliveryProfile === "origin_only") {
    for (const r of chunkRows) {
      if ((r.source_selected === "cdn_r2" || r.source_selected === "cdn2") && !r.fallback_used) {
        errors.push(`origin_only:unexpected_cdn:${r.url}`);
        INVALID_MIXED_SOURCE = true;
      }
    }
  } else if (deliveryProfile === "static_cdn") {
    for (const r of chunkRows) {
      if (r.source_selected === "hpc_server" && !r.fallback_used) {
        errors.push(`static_cdn:unexpected_hpc:${r.url}`);
        INVALID_MIXED_SOURCE = true;
      }
      if (!r.fallback_used) {
        if (cdnLabel === "cdn2") {
          if (r.source_selected !== "cdn2") {
            errors.push(`static_cdn2:expected_cdn2_got_${r.source_selected}:${r.url}`);
            INVALID_MIXED_SOURCE = true;
          }
        } else {
          if (r.source_selected === "cdn2") {
            errors.push(`static_cdn1:unexpected_cdn2:${r.url}`);
            INVALID_MIXED_SOURCE = true;
          }
          if (!r.fallback_used && r.source_selected !== "cdn_r2" && r.source_selected !== "cdn1") {
            errors.push(`static_cdn1:expected_cdn_r2_or_cdn1_got_${r.source_selected}:${r.url}`);
            INVALID_MIXED_SOURCE = true;
          }
        }
      }
    }
  } else if (deliveryProfile === "vrc_guided_hybrid") {
    const last = vrcDecisions?.length ? vrcDecisions[vrcDecisions.length - 1] : null;
    if (!last?.chunk_delivery || typeof last.chunk_delivery !== "object" || !Object.keys(last.chunk_delivery).length) {
      errors.push("hybrid:MISSING_CHUNK_DELIVERY");
    }
    for (const r of chunkRows) {
      if (!r.source_reason && r.source_selected !== "unmatched") {
        errors.push(`hybrid:missing_source_reason:${r.url}`);
      }
      if (r.fetch_plan_version == null && (r.source_selected === "cdn_r2" || r.source_selected === "hpc_server" || r.source_selected === "cdn2")) {
        errors.push(`hybrid:missing_fetch_plan_version:${r.url}`);
      }
      const sel = r.source_selected;
      if (sel === "cdn_r2" || sel === "hpc_server" || sel === "cdn2") {
        if (!String(r.original_url ?? "").trim()) errors.push(`hybrid:missing_original_url:${r.url}`);
        if (!String(r.final_url ?? "").trim()) errors.push(`hybrid:missing_final_url:${r.url}`);
      }
    }
  }

  if ((deliveryProfile === "origin_only" || deliveryProfile === "static_cdn") && hasCdnChunk && hasHpcChunk) {
    INVALID_MIXED_SOURCE = true;
    errors.push("INVALID_MIXED_SOURCE:origin_or_static_profile_has_both_hpc_and_cdn_chunks");
  }

  const mixed_source_valid = deliveryProfile === "vrc_guided_hybrid"
    ? !errors.some((e) => e.startsWith("hybrid:MISSING"))
    : !INVALID_MIXED_SOURCE;

  const valid = errors.length === 0 && !INVALID_MIXED_SOURCE;
  return { valid, errors, mixed_source_valid, INVALID_MIXED_SOURCE };
}

// ── Run a single trial (REAL BROWSER) ─────────────────────────────────────────
export async function runTrial({ chromium, method, scenario, trialIdx, runIdx }) {
  const sessionId = (process.env.VRC_SESSION_ID_OVERRIDE ?? "").trim()
    || `${method}_${scenario}_t${trialIdx}_${Date.now()}`;
  const deliveryProfileResolved = (VRC_DELIVERY_PROFILE || "").trim() || "legacy";
  const runDir = (process.env.VRC_RUN_DIR_OVERRIDE ?? "").trim()
    ? path.resolve(process.env.VRC_RUN_DIR_OVERRIDE)
    : path.join(RESULTS_RAW, sessionId);
  fs.mkdirSync(runDir, { recursive: true });
  const trialScreenshotDir = (process.env.VRC_RUN_DIR_OVERRIDE ?? "").trim()
    ? path.join(runDir, "screenshots")
    : SCREENSHOTS_DIR;
  fs.mkdirSync(trialScreenshotDir, { recursive: true });

  if (VRC_SKIP_LOCAL_SERVERS) {
    log(`[distributed] waiting for upstream Vite at ${BROWSER_ORIGIN} (skip local Vite/sync)...`);
    try {
      await waitHttp(BROWSER_ORIGIN, 120000);
    } catch (e) {
      log(`FATAL: upstream ${BROWSER_ORIGIN} not reachable: ${e.message}`);
      writeRunStatus(runDir, "FAIL_DISTRIBUTED_NO_UPSTREAM", { session_id: sessionId, method, scenario, trial: trialIdx });
      return { sessionId, status: "FAIL_DISTRIBUTED_NO_UPSTREAM", method, scenario, trial: trialIdx, metrics: [], sourceBreakdownRow: null, perClientMetricRows: [] };
    }
  }

  const runConfig = {
    method, scenario, trial: trialIdx, session_id: sessionId,
    num_users: NUM_USERS,
    user_indices: USER_INDICES,
    distributed_shard: VRC_SHARD_PARTIAL,
    browser_origin: BROWSER_ORIGIN,
    sync_http_host: SYNC_HTTP_HOST,
    trial_duration_ms: TRIAL_DURATION_MS,
    vite_port: VITE_PORT, sync_port: SYNC_PORT,
    headless: HEADLESS, run_index: runIdx,
    expected_total_runs: EXPECTED_RUNS,
    timestamp_start: new Date().toISOString(),
    delivery_profile: deliveryProfileResolved,
    cdn_label: VRC_CDN_LABEL || null,
    vrc_distributed: VRC_DISTRIBUTED,
    worker_id: VRC_DISTRIBUTED ? VRC_WORKER_ID : null,
    host_ip: VRC_DISTRIBUTED ? VRC_HOST_IP : null,
  };
  let radCdn = await resolveRadCdnForTrial();
  // For origin_only, force HPC as rad_asset_base (CDN may lack CORS for this origin)
  if (deliveryProfileResolved === "origin_only" && VRC_HPC_ASSET_BASE) {
    radCdn = { base: VRC_HPC_ASSET_BASE, keyCoit: "streaming-lod/coit-40m-sh1-lod.rad", keyHobbiton: "streaming-lod/tijerin_w6_hobbiton-lod.rad" };
    log(`[rad-cdn] origin_only: using HPC as rad_asset_base=${VRC_HPC_ASSET_BASE}`);
  }
  if (radCdn) {
    runConfig.rad_cdn = { base: radCdn.base, key_coit: radCdn.keyCoit, key_hobbiton: radCdn.keyHobbiton };
    log(`[rad-cdn] inject query: rad_asset_base + rad_key_coit=${radCdn.keyCoit} (hobbiton=${radCdn.keyHobbiton})`);
  } else {
    runConfig.rad_cdn = { mode: VRC_USE_GCS_ONLY ? "gcs_only" : "gcs_fallback_no_cdn_hit" };
    log(`[rad-cdn] inject query: use_gcs_rad=1 (${VRC_USE_GCS_ONLY ? "VRC_USE_GCS_ONLY" : "no CDN 200/206 for Coit candidates"})`);
  }
  if (deliveryProfileResolved !== "legacy") {
    runConfig.vrc_hybrid_config = {
      hpc_asset_base: VRC_HPC_ASSET_BASE,
      cdn_asset_base: VRC_CDN_ASSET_BASE,
      cdn2_asset_base: VRC_CDN2_ASSET_BASE || "",
      cdn2_object_path: VRC_CDN2_OBJECT_PATH || "",
      cdn2_object_path_hobbiton: VRC_CDN2_OBJECT_PATH_HOBBITON || "",
      hot_threshold: VRC_HOT_THRESHOLD,
      cdn_fallback_to_hpc: VRC_CDN_FALLBACK_TO_HPC,
    };
  }
  writeRunConfig(runDir, runConfig);
  log(`[${runIdx}/${EXPECTED_RUNS}] Trial: method=${method} scenario=${scenario} trial=${trialIdx} session=${sessionId}`);

  await configureSession(sessionId, method, {
    scenario,
    trial: trialIdx,
    ...(deliveryProfileResolved !== "legacy"
      ? {
        delivery_profile: deliveryProfileResolved,
        hot_threshold: VRC_HOT_THRESHOLD,
        hpc_asset_base: VRC_HPC_ASSET_BASE,
        cdn_asset_base: VRC_CDN_ASSET_BASE,
        ...(VRC_CDN2_ASSET_BASE ? { cdn2_asset_base: VRC_CDN2_ASSET_BASE } : {}),
        ...(VRC_CDN_LABEL ? { cdn_label: VRC_CDN_LABEL } : {}),
      }
      : {}),
  });

  const shardMeta = {
    worker_id: VRC_DISTRIBUTED ? VRC_WORKER_ID : "local",
    host_ip: VRC_DISTRIBUTED ? VRC_HOST_IP : "",
    cdn_label: VRC_CDN_LABEL || "",
  };

  // Per-user fresh userDataDir + WebGL/cert-tolerant flags.
  // Minimal flag set validated by debug_visual_single_user.ps1 (headful+headless both pass).
  // Do NOT add: --disable-web-security, --disable-features=IsolateOrigins,
  // --enable-unsafe-webgpu, --disable-setuid-sandbox, --disable-gpu-sandbox.
  // These caused ERR_ABORTED + blank WebGL on this Windows/ANGLE/D3D11 host.
  const CHROME_FLAGS = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--ignore-certificate-errors",
    "--use-gl=angle",
    "--use-angle=d3d11",
    "--enable-webgl",
    "--allow-running-insecure-content",
    "--disable-backgrounding-occluded-windows",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    ...(HEADLESS ? [
      "--enable-unsafe-swiftshader",
    ] : []),
  ];

  const pages = [];
  const clientLogs = [];
  const perUserContexts = [];

  for (const i of USER_INDICES) {
    const userId = `u${i}`;
    const traceFile = `${scenario}_u${i}.json`;
    const traceUrl = `${BROWSER_ORIGIN}/vrc-paper/experiments/traces/${traceFile}`;
    let url = `${BROWSER_ORIGIN}/vrc-paper/client_instrument/vrc_scene.html` +
      `?user_id=${encodeURIComponent(userId)}` +
      `&method=${encodeURIComponent(method)}` +
      `&session_id=${encodeURIComponent(sessionId)}` +
      `&scenario_id=${encodeURIComponent(scenario)}` +
      `&sync_port=${SYNC_PORT}` +
      `&sync_host=${encodeURIComponent(SYNC_HTTP_HOST)}` +
      `&world=Coit+Tower%2C+SF` +
      `&trial_index=${trialIdx}` +
      `&trace_url=${encodeURIComponent(traceUrl)}`;
    if (radCdn) {
      url += `&rad_asset_base=${encodeURIComponent(radCdn.base)}`;
      url += `&rad_key_coit=${encodeURIComponent(radCdn.keyCoit)}`;
      url += `&rad_key_hobbiton=${encodeURIComponent(radCdn.keyHobbiton)}`;
    } else {
      url += "&use_gcs_rad=1";
    }
    if (deliveryProfileResolved !== "legacy") {
      url += `&vrc_delivery_profile=${encodeURIComponent(deliveryProfileResolved)}`;
      if (VRC_CDN_LABEL) url += `&vrc_cdn_label=${encodeURIComponent(VRC_CDN_LABEL)}`;
      url += `&vrc_hpc_base=${encodeURIComponent(VRC_HPC_ASSET_BASE)}`;
      url += `&vrc_cdn_base=${encodeURIComponent(VRC_CDN_ASSET_BASE)}`;
      if (VRC_CDN2_ASSET_BASE) url += `&vrc_cdn2_base=${encodeURIComponent(VRC_CDN2_ASSET_BASE)}`;
      if (VRC_CDN2_OBJECT_PATH) url += `&vrc_cdn2_object_path=${encodeURIComponent(VRC_CDN2_OBJECT_PATH)}`;
      if (VRC_CDN2_OBJECT_PATH_HOBBITON) url += `&vrc_cdn2_object_path_hobbiton=${encodeURIComponent(VRC_CDN2_OBJECT_PATH_HOBBITON)}`;
      url += `&vrc_hot_threshold=${encodeURIComponent(String(VRC_HOT_THRESHOLD))}`;
      url += `&vrc_cdn_fallback=${VRC_CDN_FALLBACK_TO_HPC ? "true" : "false"}`;
    }

    const userDataDir = path.join(os.tmpdir(), `vrc_${sessionId}_${userId}`);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(userDataDir, { recursive: true });

    let ctx;
    const launchOpts = {
      headless: HEADLESS,
      args: CHROME_FLAGS,
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
    };
    if (process.env.VRC_CHROME_PATH) {
      launchOpts.executablePath = process.env.VRC_CHROME_PATH;
      launchOpts.channel = undefined;
      if (HEADLESS) launchOpts.args = [...CHROME_FLAGS, "--headless=new"];
    }
    try {
      ctx = await chromium.launchPersistentContext(userDataDir, launchOpts);
    } catch (err) {
      const msg = `Browser launch failed for ${userId}: ${err.message}`;
      log(`ERROR: ${msg}`);
      writeRunStatus(runDir, "FAIL", { reason: msg });
      appendJsonl(path.join(RESULTS_RAW, "errors.jsonl"), { session_id: sessionId, method, scenario, trial: trialIdx, error: msg });
      // close any contexts already opened
      for (const c of perUserContexts) { try { await c.close(); } catch {} }
      return { sessionId, status: "FAIL", method, scenario, trial: trialIdx, sourceBreakdownRow: null, perClientMetricRows: [] };
    }
    perUserContexts.push(ctx);
    const page = ctx.pages()[0] ?? await ctx.newPage();
    let browserPid = null;
    try {
      const br = ctx.browser();
      const proc = br && typeof br.process === "function" ? br.process() : null;
      browserPid = proc?.pid ?? null;
    } catch {}

    // Collect all browser console messages
    page.on("console", msg => {
      const entry = {
        user_id: userId, type: msg.type(), text: msg.text(), t: Date.now(),
        worker_id: VRC_DISTRIBUTED ? VRC_WORKER_ID : "local",
        host_ip: VRC_DISTRIBUTED ? VRC_HOST_IP : "",
        browser_pid: browserPid,
        delivery_profile: deliveryProfileResolved,
        session_id: sessionId, method, scenario, trial: trialIdx,
      };
      clientLogs.push(entry);
      if (msg.type() === "error") log(`[browser:${userId}] ${msg.text()}`);
    });

    // Intercept network requests for request log
    const requestLog = [];
    page.on("request", req => {
      const hdr = req.headers();
      requestLog.push({
        user_id: userId, method, scenario, session_id: sessionId,
        worker_id: VRC_DISTRIBUTED ? VRC_WORKER_ID : "local",
        host_ip: VRC_DISTRIBUTED ? VRC_HOST_IP : "",
        browser_pid: browserPid,
        delivery_profile: deliveryProfileResolved,
        cdn_label: VRC_CDN_LABEL || "",
        trial: trialIdx,
        url: req.url(), resource_type: req.resourceType(),
        request_start: Date.now(),
        req_range: hdr["range"] ?? hdr["Range"] ?? null,
      });
    });
    page.on("response", async res => {
      const entry = requestLog.find(r => r.url === res.url() && r.user_id === userId && !r.status);
      if (entry) {
        entry.status = res.status();
        entry.response_end = Date.now();
        entry.service_time_ms = entry.response_end - entry.request_start;
        // PROTOCOL: do NOT consume body — that blocks the response and starves the renderer,
        // causing blank/blue screenshots and screenshot timeouts. Use Content-Length header.
        try {
          const cl = res.headers()["content-length"];
          entry.bytes_sent = cl ? Number(cl) : 0;
        } catch {}
        // Capture Range header from the request for chunk de-duplication keys
        try {
          const reqHeaders = res.request().headers();
          if (reqHeaders["range"]) entry.range = reqHeaders["range"];
        } catch {}
        // Diagnostic response headers (CDN / cache provenance; does not affect experiment logic)
        try {
          const rh = res.headers();
          entry.resp_content_range = rh["content-range"] ?? null;
          entry.resp_cf_ray = rh["cf-ray"] ?? null;
          entry.resp_cf_cache_status = rh["cf-cache-status"] ?? null;
          entry.resp_age = rh["age"] ?? null;
          entry.resp_server = rh["server"] ?? null;
        } catch {}
      }
    });
    pages.push({ page, userId, ctx, requestLog, startUrl: url, browserPid });
  }

  log(`Parallel goto for ${USER_INDICES.length} clients (${USER_INDICES.map(i => `u${i}`).join(",")}) (timeout_ms=${GOTO_TIMEOUT_MS} waitUntil=${GOTO_WAIT_UNTIL}) — avoids serial head-of-line delay across persistent contexts.`);
  await Promise.all(pages.map(async ({ page, userId, startUrl, browserPid }) => {
    const doNav = async () => {
      await page.goto(startUrl, { waitUntil: GOTO_WAIT_UNTIL, timeout: GOTO_TIMEOUT_MS });
    };
    const pushNavAudit = () => {
      const syncWs = `ws://${SYNC_HTTP_HOST}:${SYNC_PORT}`;
      clientLogs.push({
        user_id: userId, type: "nav_audit", t: Date.now(),
        page_url: startUrl, sync_host: SYNC_HTTP_HOST, sync_port: SYNC_PORT, sync_ws_url: syncWs,
        worker_id: VRC_DISTRIBUTED ? VRC_WORKER_ID : "local",
        host_ip: VRC_DISTRIBUTED ? VRC_HOST_IP : "",
        browser_pid: browserPid,
        delivery_profile: deliveryProfileResolved,
        cdn_label: VRC_CDN_LABEL || "",
        session_id: sessionId, method, scenario, trial: trialIdx,
      });
    };
    let navigated = false;
    try {
      await doNav();
      navigated = true;
    } catch (err) {
      log(`WARNING: page.goto failed for ${userId}: ${err.message}`);
      clientLogs.push({ user_id: userId, type: "error", text: `goto failed: ${err.message}`, t: Date.now() });
      try {
        log(`[goto-retry] ${userId} same URL once after failure`);
        await doNav();
        navigated = true;
        log(`[goto-retry] ${userId} ok`);
      } catch (e2) {
        clientLogs.push({ user_id: userId, type: "error", text: `goto retry failed: ${e2.message}`, t: Date.now() });
        log(`WARNING: page.goto retry failed for ${userId}: ${e2.message}`);
      }
    }
    if (navigated) pushNavAudit();
    try {
      await page.setViewportSize({ width: 1280, height: 720 });
    } catch (e) {
      log(`WARNING: setViewportSize failed for ${userId}: ${e.message}`);
    }
  }));

  if (!HEADLESS) {
    for (const { page, userId } of pages) {
      try {
        await page.bringToFront();
        await sleep(120);
      } catch (e) {
        log(`WARNING: bringToFront failed for ${userId}: ${e.message}`);
      }
    }
  }

  if (pages[0]?.startUrl) {
    const ref = vrcNavParamsFromUrl(pages[0].startUrl);
    for (const p of pages) {
      const q = vrcNavParamsFromUrl(p.startUrl);
      if (!ref || !q) continue;
      for (const k of ["method", "session_id", "scenario_id", "sync_port", "world"]) {
        if ((ref[k] || "") !== (q[k] || "")) {
          log(`[nav-query-mismatch] ${p.userId} field ${k}: u0=${ref[k]} ${p.userId}=${q[k]}`);
        }
      }
    }
    if (ref) {
      log(`[nav-check] shared_query(method,session,scenario,sync_port,world)=${JSON.stringify(ref)} (user_id differs per client)`);
    }
  }

  log(`Waiting ${SCREENSHOT_DELAY_MS}ms for scene to load splats... capture_mode=${CAPTURE_MODE}`);
  await sleep(SCREENSHOT_DELAY_MS);

  // Per-user capture record: timing + outcome for every u0..u3.
  // Written to screenshot_timing.jsonl regardless of success so failures are explicit.
  const captureRecords = new Map();
  const timingFile = path.join(runDir, "screenshot_timing.jsonl");
  function recordCapture(userId, patch) {
    const prev = captureRecords.get(userId) ?? {
      user_id: userId, session_id: sessionId, method, scenario, trial: trialIdx,
      page_ready: null, visual_ready: null, screenshot_start: null,
      screenshot_saved: null, screenshot_valid: null, failure_reason: null,
      strategy: null, page_crashed: false,
    };
    captureRecords.set(userId, { ...prev, ...patch });
  }

  // Detect crashes/closes so FILE_MISSING can be attributed to the right cause.
  for (const { page, ctx, userId } of pages) {
    page.on("crash", () => { recordCapture(userId, { page_crashed: true }); log(`[page:${userId}] crash`); });
    page.on("close", () => { recordCapture(userId, { page_crashed: captureRecords.get(userId)?.page_crashed || !captureRecords.get(userId)?.screenshot_saved }); });
    ctx.on("close", () => { /* noop; logged by page */ });
  }
  // Mark page_ready for every user that made it past goto() above.
  for (const { userId } of pages) {
    recordCapture(userId, { page_ready: Date.now() });
  }

  // Visual-ready gate: metrics_only uses a lighter bar (except Spark-MU, always strict).
  // When screenshots run, require FPS + chunks + asset traffic + non-flat canvas (luma std).
  for (const { page, userId, requestLog, startUrl } of pages) {
    const { minChunks, minAssetOk } = readyThresholdsForMethod(method);
    const sparkStrict = method === "Spark-MU";
    const visualScreenshots = CAPTURE_MODE !== "metrics_only";
    const effMinChunks = visualScreenshots ? minChunks : (sparkStrict ? minChunks : Math.min(3, minChunks));
    const effMinAsset = visualScreenshots ? minAssetOk : (sparkStrict ? minAssetOk : 1);
    const requireVariance = visualScreenshots;

    const deadline = Date.now() + LOW_FPS_PROBE_BUDGET_MS;
    let ready = { ok: false, reason: "TIMEOUT", fps: 0, chunks: 0, asset_ok: 0, luma_std: null };
    while (Date.now() < deadline) {
      const probe = await page.evaluate(async (needVar) => {
        const c = document.querySelector("canvas");
        if (!c || c.width === 0 || c.height === 0) return { ok: false, reason: "NO_CANVAS" };
        const start = performance.now();
        let frames = 0;
        await new Promise(resolve => {
          const d = start + 500;
          function tick() {
            frames++;
            if (performance.now() >= d) resolve();
            else requestAnimationFrame(tick);
          }
          requestAnimationFrame(tick);
        });
        const elapsed = performance.now() - start;
        const fps = frames / (elapsed / 1000);
        const chunks = (window.__vrcRawMetrics && window.__vrcRawMetrics.seen_chunks)
          ? (window.__vrcRawMetrics.seen_chunks.size ?? 0) : 0;
        let luma_std = null;
        if (needVar) {
          const w = Math.min(256, c.width), h = Math.min(256, c.height);
          const oc = document.createElement("canvas");
          oc.width = w; oc.height = h;
          const octx = oc.getContext("2d", { willReadFrequently: true });
          if (!octx) return { ok: false, reason: "NO_2D_CONTEXT", fps, chunks, luma_std };
          try {
            octx.drawImage(c, 0, 0, c.width, c.height, 0, 0, w, h);
          } catch (e) {
            return { ok: false, reason: `DRAW_FAIL:${e?.message ?? e}`, fps, chunks, luma_std };
          }
          const id = octx.getImageData(0, 0, w, h).data;
          let sum = 0, sum2 = 0, n = 0;
          for (let i = 0; i < id.length; i += 16) {
            const r = id[i], g = id[i + 1], b = id[i + 2];
            const Y = 0.299 * r + 0.587 * g + 0.114 * b;
            sum += Y; sum2 += Y * Y; n++;
          }
          const mean = sum / Math.max(1, n);
          const variance = Math.max(0, sum2 / Math.max(1, n) - mean * mean);
          luma_std = Math.sqrt(variance);
        }
        return { ok: true, w: c.width, h: c.height, fps, chunks, luma_std };
      }, requireVariance).catch(e => ({ ok: false, reason: `EVAL_${e.message}`, fps: 0, chunks: 0, luma_std: null }));

      const assetOkCount = requestLog.filter(r => r.status >= 200 && r.status < 400 &&
        (r.url.includes(".rad") || r.url.includes(".spz") || r.url.includes(".splat") ||
         r.url.includes("forge-dev-public") || r.url.includes(".r2.dev"))).length;

      const fpsOk = probe.ok && probe.fps > MIN_CAPTURE_FPS;
      const chunkOk = probe.ok && probe.chunks >= effMinChunks;
      const assetOk = assetOkCount >= effMinAsset;
      const varianceOk = !requireVariance || (probe.luma_std != null && probe.luma_std >= MIN_READY_LUMA_STD);

      // Throttled tabs (sequential multi-page / headless): rAF can report fps≈0 while chunks+luma prove real content.
      if (!fpsOk && chunkOk && assetOk && varianceOk && probe.ok) {
        ready = {
          ok: true,
          w: probe.w,
          h: probe.h,
          fps: probe.fps,
          chunks: probe.chunks,
          luma_std: probe.luma_std,
          asset_ok: assetOkCount,
          fps_throttled: true,
        };
        break;
      }
      if (fpsOk && chunkOk && assetOk && varianceOk) {
        ready = {
          ok: true, ...probe, asset_ok: assetOkCount,
        };
        break;
      }
      const parts = [];
      if (!fpsOk) parts.push(`fps=${probe.fps?.toFixed?.(2) ?? probe.fps}`);
      if (!chunkOk) parts.push(`chunks=${probe.chunks ?? 0}/${effMinChunks}`);
      if (!assetOk) parts.push(`asset_ok=${assetOkCount}/${effMinAsset}`);
      if (!varianceOk) parts.push(`luma_std=${probe.luma_std ?? "na"}<${MIN_READY_LUMA_STD}`);
      ready = {
        ok: false,
        reason: probe.ok ? parts.join(";") : (probe.reason ?? "BAD_PROBE"),
        fps: probe.fps ?? 0,
        chunks: probe.chunks ?? 0,
        asset_ok: assetOkCount,
        luma_std: probe.luma_std ?? null,
      };
      await sleep(500);
    }
    // u0 / first tabs sometimes stay at chunks=1 while R2 is fine — one reload + short re-probe
    // avoids false VISUAL_READY_NOT_MET when siblings already streamed (Vite/GPU scheduling).
    if (!ready.ok && visualScreenshots && !sparkStrict && (ready.chunks ?? 0) < effMinChunks) {
      log(`[visual-ready ${userId}] reload retry (chunks=${ready.chunks} < ${effMinChunks})`);
      try {
        await page.reload({ waitUntil: GOTO_WAIT_UNTIL, timeout: GOTO_TIMEOUT_MS });
        await sleep(6000);
        const tEnd = Date.now() + 22000;
        while (Date.now() < tEnd && !ready.ok) {
          const probe = await page.evaluate(async (needVar) => {
            const c = document.querySelector("canvas");
            if (!c || c.width === 0 || c.height === 0) return { ok: false, reason: "NO_CANVAS" };
            const start = performance.now();
            let frames = 0;
            await new Promise(resolve => {
              const d = start + 500;
              function tick() {
                frames++;
                if (performance.now() >= d) resolve();
                else requestAnimationFrame(tick);
              }
              requestAnimationFrame(tick);
            });
            const elapsed = performance.now() - start;
            const fps = frames / (elapsed / 1000);
            const chunks = (window.__vrcRawMetrics && window.__vrcRawMetrics.seen_chunks)
              ? (window.__vrcRawMetrics.seen_chunks.size ?? 0) : 0;
            let luma_std = null;
            if (needVar) {
              const w = Math.min(256, c.width), h = Math.min(256, c.height);
              const oc = document.createElement("canvas");
              oc.width = w; oc.height = h;
              const octx = oc.getContext("2d", { willReadFrequently: true });
              if (!octx) return { ok: false, reason: "NO_2D_CONTEXT", fps, chunks, luma_std };
              try {
                octx.drawImage(c, 0, 0, c.width, c.height, 0, 0, w, h);
              } catch (e) {
                return { ok: false, reason: `DRAW_FAIL:${e?.message ?? e}`, fps, chunks, luma_std };
              }
              const id = octx.getImageData(0, 0, w, h).data;
              let sum = 0, sum2 = 0, n = 0;
              for (let i = 0; i < id.length; i += 16) {
                const r = id[i], g = id[i + 1], b = id[i + 2];
                const Y = 0.299 * r + 0.587 * g + 0.114 * b;
                sum += Y; sum2 += Y * Y; n++;
              }
              const mean = sum / Math.max(1, n);
              const variance = Math.max(0, sum2 / Math.max(1, n) - mean * mean);
              luma_std = Math.sqrt(variance);
            }
            return { ok: true, w: c.width, h: c.height, fps, chunks, luma_std };
          }, requireVariance).catch(e => ({ ok: false, reason: `EVAL_${e.message}`, fps: 0, chunks: 0, luma_std: null }));
          const assetOkCount = requestLog.filter(r => r.status >= 200 && r.status < 400 &&
            (r.url.includes(".rad") || r.url.includes(".spz") || r.url.includes(".splat") ||
             r.url.includes("forge-dev-public") || r.url.includes(".r2.dev"))).length;
          const fpsOk = probe.ok && probe.fps > MIN_CAPTURE_FPS;
          const chunkOk = probe.ok && probe.chunks >= effMinChunks;
          const assetOk = assetOkCount >= effMinAsset;
          const varianceOk = !requireVariance || (probe.luma_std != null && probe.luma_std >= MIN_READY_LUMA_STD);
          if (!fpsOk && chunkOk && assetOk && varianceOk && probe.ok) {
            ready = {
              ok: true, w: probe.w, h: probe.h, fps: probe.fps, chunks: probe.chunks,
              luma_std: probe.luma_std, asset_ok: assetOkCount, fps_throttled: true,
            };
            break;
          }
          if (fpsOk && chunkOk && assetOk && varianceOk) {
            ready = { ok: true, ...probe, asset_ok: assetOkCount };
            break;
          }
          const parts = [];
          if (!fpsOk) parts.push(`fps=${probe.fps?.toFixed?.(2) ?? probe.fps}`);
          if (!chunkOk) parts.push(`chunks=${probe.chunks ?? 0}/${effMinChunks}`);
          if (!assetOk) parts.push(`asset_ok=${assetOkCount}/${effMinAsset}`);
          if (!varianceOk) parts.push(`luma_std=${probe.luma_std ?? "na"}<${MIN_READY_LUMA_STD}`);
          ready = {
            ok: false,
            reason: probe.ok ? parts.join(";") : (probe.reason ?? "BAD_PROBE"),
            fps: probe.fps ?? 0,
            chunks: probe.chunks ?? 0,
            asset_ok: assetOkCount,
            luma_std: probe.luma_std ?? null,
          };
          await sleep(500);
        }
      } catch (e) {
        log(`[visual-ready ${userId}] reload retry error: ${e.message}`);
      }
    }
    if (!ready.ok && sparkStrict) {
      ready = {
        ...ready,
        ok: false,
        reason: "LOAD_INCOMPLETE",
        detail: JSON.stringify({ chunks: ready.chunks, asset_ok: ready.asset_ok, prior_reason: ready.reason }),
      };
    } else if (!ready.ok && visualScreenshots && !sparkStrict) {
      ready = {
        ...ready,
        ok: false,
        reason: "VISUAL_READY_NOT_MET",
        detail: ready.reason,
      };
    }
    log(`[visual-ready ${userId}] ${JSON.stringify(ready)}`);
    if (!ready.ok && Number(ready.chunks) <= 1 && (ready.luma_std === 0 || ready.luma_std == null)) {
      await logVisualReadyLowChunkDiags(userId, page, requestLog, clientLogs, startUrl, sessionId, method, scenario);
    }
    recordCapture(userId, {
      visual_ready: Date.now(),
      visual_ready_ok: ready.ok,
      visual_ready_reason: ready.ok
        ? (ready.fps_throttled ? "FPS_THROTTLED_AT_READY" : null)
        : ready.reason,
      fps_at_ready: ready.fps ?? null,
      chunks_at_ready: ready.chunks ?? null,
      asset_ok_at_ready: ready.asset_ok ?? null,
      luma_std_at_ready: ready.luma_std ?? null,
    });
  }

  // Sequential capture: process users one-by-one (for loop order) with bringToFront +
  // CDP Page.captureScreenshot (fromSurface reads compositor output). We intentionally
  // do NOT override document.visibilityState — that caused Chrome to throttle rAF and
  // false FAIL_VISUAL_LOW_FPS:0.00 on sibling tabs.
  async function waitForFpsRecovery(page, userId, deadlineMs) {
    const tEnd = Date.now() + deadlineMs;
    while (Date.now() < tEnd) {
      const probe = await page.evaluate(async () => {
        const c = document.querySelector("canvas");
        if (!c) return { ok: false, fps: 0, vis: "no_canvas" };
        const vis = document.visibilityState;
        if (vis !== "visible") return { ok: false, fps: 0, vis };
        const start = performance.now();
        let frames = 0;
        await new Promise(r => {
          const d = start + 900;
          function tick() { frames++; if (performance.now() >= d) r(); else requestAnimationFrame(tick); }
          requestAnimationFrame(tick);
        });
        return { ok: true, fps: frames / ((performance.now() - start) / 1000), vis };
      }).catch(() => ({ ok: false, fps: 0, vis: "eval_err" }));
      if (probe.ok && probe.fps > 5) {
        log(`[seq:${userId}] fps recovered to ${probe.fps.toFixed(1)} (vis=${probe.vis ?? "?"})`);
        return { ok: true, fps: probe.fps };
      }
      await sleep(400);
    }
    return { ok: false, fps: 0 };
  }

  // metrics_only mode: skip screenshot entirely; mark every user as not-captured
  // so the rest of the pipeline (status.json, capture_records) still has rows.
  if (CAPTURE_MODE === "metrics_only") {
    log(`[capture] metrics_only mode — skipping screenshot for ${USER_INDICES.length} local users`);
    for (const { userId } of pages) {
      recordCapture(userId, {
        screenshot_start: Date.now(),
        screenshot_saved: null,
        screenshot_valid: false,
        failure_reason: "SKIPPED_METRICS_ONLY",
        strategy: "metrics_only",
      });
    }
  } else {
  async function logCaptureHardTimeoutDiags(page, userId, requestLog, ssPath, lastCdpErr) {
    const lines = [];
    lines.push(`=== CAPTURE HARD TIMEOUT DEBUG ${userId} ===`);
    lines.push(`screenshot_path=${ssPath}`);
    lines.push(`last_cdp_error=${lastCdpErr ?? "none"}`);
    try {
      const nw = requestLog;
      const withSt = nw.filter(r => r.status != null).length;
      const rad = nw.filter(r => r.url && /\.(rad|spz|splat)/i.test(r.url)).length;
      lines.push(`network: total_requests=${nw.length} with_status=${withSt} chunk_like=${rad}`);
    } catch (e) { lines.push(`network_summary_error=${e.message}`); }
    try {
      const canvasState = await page.evaluate(() => {
        const c = document.querySelector("canvas");
        if (!c) return { canvas: "missing" };
        return {
          canvas: "ok",
          w: c.width,
          h: c.height,
          chunks: (window.__vrcRawMetrics && window.__vrcRawMetrics.seen_chunks)
            ? (window.__vrcRawMetrics.seen_chunks.size ?? 0) : 0,
        };
      }).catch(e => ({ canvas_eval_error: String(e.message) }));
      lines.push(`canvas_state=${JSON.stringify(canvasState)}`);
    } catch (e) { lines.push(`canvas_state_error=${e.message}`); }
    const recent = clientLogs.filter(l => l.user_id === userId).slice(-35);
    lines.push(`console_tail(${recent.length}):`);
    for (const l of recent) lines.push(`  [${l.type}] ${String(l.text).slice(0, 500)}`);
    for (const ln of lines) log(`[capture-timeout:${userId}] ${ln}`);
  }

  // Screenshot ALL 4 user pages with a hard PER_USER_CAPTURE_MS budget each.
  // Strategy A: raw CDP Page.captureScreenshot (with retries). Strategy B: page.screenshot.
  async function captureOneUser(i, cdpErrOut) {
    const { page, userId, requestLog } = pages[i];
    const ssPath = path.join(trialScreenshotDir, `${sessionId}_${userId}.png`);
    recordCapture(userId, { screenshot_start: Date.now() });

    try { await page.bringToFront(); } catch {}
    // Restore visibility so compositor produces fresh frames for CDP capture.
    try { await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); }); } catch {}
    await sleep(600);

    const gateRec = captureRecords.get(userId);
    if (gateRec && gateRec.visual_ready_ok === false) {
      // Soft-ready override: if chunks and luma_std indicate real scene content
      // is loaded, proceed with capture despite FPS throttling or minor asset_ok
      // shortfall. Background tabs on Windows ANGLE/D3D11 report fps≈0 due to
      // rAF throttling, but the compositor surface still has valid content.
      const chunks = gateRec.chunks_at_ready ?? 0;
      const lumaStd = gateRec.luma_std_at_ready ?? 0;
      const contentLoaded = chunks >= 20 && lumaStd >= MIN_READY_LUMA_STD;
      if (!contentLoaded) {
        log(`[capture:${userId}] skip — visual_ready_ok=false, content not loaded (chunks=${chunks} luma_std=${lumaStd}) reason=${gateRec.visual_ready_reason}`);
        recordCapture(userId, {
          screenshot_saved: null,
          screenshot_valid: false,
          failure_reason: gateRec.visual_ready_reason ?? "NOT_VISUALLY_READY",
          strategy: "skipped_not_ready",
        });
        return;
      }
      log(`[capture:${userId}] SOFT_READY — visual_ready_ok=false but content loaded (chunks=${chunks} luma_std=${lumaStd.toFixed(1)}). Proceeding with capture.`);
      recordCapture(userId, { soft_ready: true, soft_ready_reason: `chunks=${chunks},luma_std=${lumaStd.toFixed(1)},fps_throttled` });
    }

    if (CAPTURE_MODE === "sequential") {
      await sleep(Number(process.env.VRC_SEQ_INTER_USER_MS ?? 800));
      const probeMs = Math.min(8000, SEQUENTIAL_FPS_WAIT_MS);
      const fpsRec = await waitForFpsRecovery(page, userId, probeMs);
      if (fpsRec.ok) {
        log(`[seq:${userId}] fps probe ${fpsRec.fps.toFixed(1)}`);
      } else {
        log(`[seq:${userId}] fps probe ${fpsRec.fps.toFixed(2)} (non-blocking; CDP uses compositor surface)`);
      }
      recordCapture(userId, {
        sequential_fps_ok: true,
        fps_after_suspend: fpsRec.ok ? fpsRec.fps : (gateRec?.fps_at_ready ?? null),
        seq_fps_probe_ok: fpsRec.ok,
      });
    }
    try { await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); } catch {}

    function userContentReadyForDataUrl(rec) {
      if (!rec) return false;
      if (rec.visual_ready_ok === true) return true;
      if (rec.soft_ready === true) return true;
      const chunks = rec.chunks_at_ready ?? 0;
      const luma = rec.luma_std_at_ready ?? 0;
      return chunks >= 20 && luma >= MIN_READY_LUMA_STD;
    }

    async function canvasSurfaceOk() {
      if (page.isClosed()) return false;
      try {
        const ok = await Promise.race([
          page.evaluate(() => {
            const c = document.querySelector("canvas");
            return !!(c && c.width > 0 && c.height > 0);
          }),
          sleep(3000).then(() => false),
        ]);
        return !!ok;
      } catch {
        return false;
      }
    }

    let saved = false, strategy = null, lastCdpErr = null, viewportErr = null, dataUrlErr = null;

    async function tryCdpOnce() {
      if (page.isClosed()) {
        lastCdpErr = "page_closed_before_cdp";
        if (cdpErrOut) cdpErrOut.last = lastCdpErr;
        return false;
      }
      let client;
      try {
        client = await page.context().newCDPSession(page);
      } catch (err) {
        lastCdpErr = err.message;
        if (cdpErrOut) cdpErrOut.last = err.message;
        return false;
      }
      try {
        const res = await Promise.race([
          client.send("Page.captureScreenshot", {
            format: "png",
            clip: { x: 0, y: 0, width: 1280, height: 720, scale: 1 },
            captureBeyondViewport: false,
            fromSurface: true,
          }),
          sleep(CDP_CAPTURE_TIMEOUT_MS).then(() => null),
        ]);
        if (!res) {
          const tlab = `CDP_TIMEOUT_${CDP_CAPTURE_TIMEOUT_MS}ms`;
          lastCdpErr = tlab;
          if (cdpErrOut) cdpErrOut.last = tlab;
          log(`WARNING: cdp screenshot timed out (${CDP_CAPTURE_TIMEOUT_MS}ms) for ${userId}`);
          return false;
        }
        fs.writeFileSync(ssPath, Buffer.from(res.data, "base64"));
        return true;
      } catch (err) {
        lastCdpErr = err.message;
        if (cdpErrOut) cdpErrOut.last = err.message;
        log(`WARNING: cdp screenshot failed for ${userId}: ${err.message}`);
        return false;
      } finally {
        try { await client.detach(); } catch {}
      }
    }

    async function tryViewportScreenshot(label) {
      if (page.isClosed()) {
        viewportErr = [viewportErr, `${label}:page_closed`].filter(Boolean).join(";");
        return false;
      }
      try {
        await Promise.race([
          page.screenshot({
            path: ssPath, fullPage: false, type: "png",
            timeout: VIEWPORT_CAPTURE_TIMEOUT_MS, animations: "disabled", caret: "hide",
            clip: { x: 0, y: 0, width: 1280, height: 720 },
          }),
          sleep(VIEWPORT_CAPTURE_TIMEOUT_MS + 750).then(() => {
            throw new Error(`VIEWPORT_RACE_TIMEOUT_${VIEWPORT_CAPTURE_TIMEOUT_MS}ms`);
          }),
        ]);
        return true;
      } catch (err) {
        viewportErr = [viewportErr, `${label}:${err.message}`].filter(Boolean).join(";");
        log(`WARNING: viewport screenshot (${label}) failed for ${userId}: ${err.message}`);
        return false;
      }
    }

    async function tryCanvasDataUrl() {
      if (page.isClosed()) {
        dataUrlErr = "page_closed";
        return false;
      }
      try {
        const dataUrl = await Promise.race([
          page.evaluate(() => {
            const c = document.querySelector("canvas");
            if (!c || c.width === 0 || c.height === 0) return "";
            try {
              return c.toDataURL("image/png");
            } catch (e) {
              return `ERR:${e?.message ?? e}`;
            }
          }),
          sleep(DATAURL_CAPTURE_TIMEOUT_MS).then(() => null),
        ]);
        if (dataUrl == null) {
          dataUrlErr = `DATAURL_TIMEOUT_${DATAURL_CAPTURE_TIMEOUT_MS}ms`;
          return false;
        }
        if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png")) {
          dataUrlErr = dataUrl && String(dataUrl).startsWith("ERR:") ? String(dataUrl) : "DATAURL_EMPTY_OR_UNSUPPORTED";
          return false;
        }
        const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
        if (!b64) {
          dataUrlErr = "DATAURL_PARSE";
          return false;
        }
        fs.writeFileSync(ssPath, Buffer.from(b64, "base64"));
        return true;
      } catch (e) {
        dataUrlErr = e.message;
        return false;
      }
    }

    // Primary: CDP once → viewport page.screenshot → canvas toDataURL when content-ready (protocol order).
    saved = await tryCdpOnce();
    if (saved) {
      strategy = "cdp";
      log(`Screenshot saved (cdp): ${ssPath}`);
    } else {
      saved = await tryViewportScreenshot("viewport_after_cdp");
      if (saved) {
        strategy = "viewport";
        log(`Screenshot saved (viewport fallback): ${ssPath}`);
      }
    }
    if (!saved) {
      const capRec = captureRecords.get(userId);
      const canvasOk = await canvasSurfaceOk();
      if (userContentReadyForDataUrl(capRec) && canvasOk && !page.isClosed()) {
        saved = await tryCanvasDataUrl();
        if (saved) {
          strategy = "canvas_dataurl";
          log(`Screenshot saved (canvas toDataURL): ${ssPath}`);
        }
      } else if (!userContentReadyForDataUrl(capRec)) {
        dataUrlErr = "skipped_not_content_ready";
      } else if (!canvasOk) {
        dataUrlErr = "skipped_canvas_not_ok";
      }
    }

    let result = saved ? validatePngFile(ssPath) : { screenshot_valid: false, failure_reason: "CAPTURE_FAILED" };
    const flatLike = (r) => {
      const fr = String(r.failure_reason ?? "");
      return fr.includes("FLAT_COLOR") || fr.includes("FLAT_LOW_VARIANCE");
    };

    if (saved && !result.screenshot_valid && flatLike(result)) {
      log(`[capture:${userId}] FLAT/LOW_VARIANCE — retrying viewport capture once`);
      if (await tryViewportScreenshot("viewport_flat_retry")) {
        strategy = "viewport_flat_retry";
        result = validatePngFile(ssPath);
        log(`[capture:${userId}] flat retry validate screenshot_valid=${result.screenshot_valid}`);
      }
    }

    if (saved && !result.screenshot_valid && !flatLike(result)) {
      for (let attempt = 1; attempt <= 2 && !result.screenshot_valid; attempt++) {
        log(`[capture:${userId}] invalid PNG (${result.failure_reason}) — CDP retry ${attempt}`);
        saved = await tryCdpOnce();
        if (saved) {
          strategy = "cdp_revalidate";
          result = validatePngFile(ssPath);
        }
        await sleep(350);
      }
      if (!result.screenshot_valid) {
        if (await tryViewportScreenshot("viewport_after_invalid")) {
          strategy = "viewport_after_invalid";
          result = validatePngFile(ssPath);
        }
      }
    }

    if (saved && !result.screenshot_valid) log(`[visual] ${strategy} screenshot for ${userId} invalid: ${result.failure_reason}`);
    if (!saved) {
      log(`[visual] FAILED to produce screenshot for ${userId}: cdp=${lastCdpErr} viewport=${viewportErr} dataurl=${dataUrlErr ?? "n/a"}`);
    }

    recordCapture(userId, {
      screenshot_saved: saved ? Date.now() : null,
      screenshot_valid: !!result.screenshot_valid,
      failure_reason: saved
        ? (result.failure_reason ?? null)
        : `CAPTURE_ALL_METHODS_FAILED:cdp=${lastCdpErr ?? "n/a"};viewport=${viewportErr ?? "n/a"};dataurl=${dataUrlErr ?? "n/a"}`,
      strategy,
    });
  }

  for (let i = 0; i < pages.length; i++) {
    const { page, userId, requestLog } = pages[i];
    const ssPath = path.join(trialScreenshotDir, `${sessionId}_${userId}.png`);
    const t0 = Date.now();
    const cdpErrOut = { last: null };
    let captureFinished = false;
    const capPromise = captureOneUser(i, cdpErrOut)
      .catch((e) => log(`[capture:${userId}] error: ${e.message}`))
      .finally(() => { captureFinished = true; });
    await Promise.race([
      capPromise.then(() => {}),
      sleep(PER_USER_CAPTURE_MS).then(async () => {
        if (captureFinished) return;
        const rec = captureRecords.get(userId);
        if (!rec?.screenshot_saved && !String(rec?.failure_reason ?? "").startsWith("FAIL_VISUAL_LOW_FPS")
            && !String(rec?.failure_reason ?? "").includes("NOT_VISUALLY_READY")
            && !String(rec?.failure_reason ?? "").includes("LOAD_INCOMPLETE")) {
          recordCapture(userId, {
            screenshot_saved: null,
            screenshot_valid: false,
            failure_reason: `CAPTURE_TIMEOUT:${PER_USER_CAPTURE_MS}ms`,
            strategy: "timed_out",
          });
          log(`[capture:${userId}] HARD TIMEOUT after ${PER_USER_CAPTURE_MS}ms`);
          // Do not call page.evaluate / heavy diags here — captureOneUser may still hold
          // page.screenshot / CDP; concurrent evaluate can deadlock the renderer for minutes.
        }
      }),
    ]);
    if (_seqHeavy) {
      // Sequential: always drain the full capture promise — never start u{i+1} while u{i}
      // may still hold page.screenshot/CDP (GPU deadlock + cascading HARD TIMEOUTs).
      await capPromise;
    } else {
      await Promise.race([
        capPromise,
        sleep(CAPTURE_DRAIN_AFTER_BUDGET_MS).then(() => {}),
      ]);
      if (!captureFinished) {
        log(`[capture:${userId}] still in-flight after ${CAPTURE_DRAIN_AFTER_BUDGET_MS}ms drain — continuing (orphan capture may finish in background)`);
        const rec = captureRecords.get(userId);
        if (!page.isClosed() && String(rec?.failure_reason ?? "").includes("CAPTURE_TIMEOUT")) {
          try {
            await Promise.race([
              logCaptureHardTimeoutDiags(page, userId, requestLog, ssPath, cdpErrOut.last),
              sleep(8000),
            ]);
          } catch (e) {
            log(`[capture:${userId}] post-drain diags: ${e.message}`);
          }
        }
      }
    }
    log(`[capture:${userId}] done in ${Date.now() - t0}ms`);
  }
  } // end if (CAPTURE_MODE !== "metrics_only")

  // Gate: every launched user must have a capture record — success or explicit failure.
  for (const i of USER_INDICES) {
    const userId = `u${i}`;
    if (!captureRecords.has(userId)) {
      recordCapture(userId, {
        screenshot_valid: false,
        failure_reason: "NO_CAPTURE_ATTEMPT",
        strategy: null,
      });
    }
  }
  // If raw/<sessionId> was removed mid-trial (external cleanup / concurrent run), recreate
  // before first append — otherwise appendJsonl → ENOENT here (runDir was created at trial start).
  fs.mkdirSync(runDir, { recursive: true });
  for (const rec of captureRecords.values()) {
    appendJsonl(timingFile, rec);
  }

  // Collect metrics from each client (mid-trial)
  const trialMetrics = [];
  for (const { page, userId } of pages) {
    try {
      const metrics = await page.evaluate(() => {
        if (typeof window.__vrcGetMetrics === "function") return window.__vrcGetMetrics();
        return { error: "no_metrics_fn" };
      });
      trialMetrics.push({ ...metrics, ...shardMeta, user_id: userId, method, scenario, trial: trialIdx, session_id: sessionId, snapshot: "mid" });
    } catch (err) {
      trialMetrics.push({ error: String(err), ...shardMeta, user_id: userId, method, scenario, trial: trialIdx, snapshot: "mid" });
    }
  }

  // Let trial run to full duration
  const remaining = TRIAL_DURATION_MS - SCREENSHOT_DELAY_MS;
  if (remaining > 0) {
    log(`Running trial for ${remaining}ms more...`);
    await sleep(remaining);
  }

  // Final metrics snapshot
  const finalMetrics = [];
  for (const { page, userId } of pages) {
    try {
      const metrics = await page.evaluate(() =>
        typeof window.__vrcGetMetrics === "function" ? window.__vrcGetMetrics() : { error: "no_metrics_fn" }
      );
      finalMetrics.push({ ...metrics, ...shardMeta, user_id: userId, method, scenario, trial: trialIdx, session_id: sessionId, final: true, snapshot: "final" });
    } catch (err) {
      finalMetrics.push({ error: String(err), ...shardMeta, user_id: userId, method, scenario, trial: trialIdx, final: true, snapshot: "final" });
    }
  }

  // Collect VRC decisions + browser-side source events (before closing contexts).
  let vrcDecisions = [];
  try {
    vrcDecisions = await pages[0].page.evaluate(() => window.__vrcDecisionLog ?? []);
  } catch {}

  const sourceFlat = [];
  for (const { page } of pages) {
    try {
      const ev = await page.evaluate(() => window.__vrcSourceEvents ?? []);
      for (const e of ev) sourceFlat.push({ ...e, trial: trialIdx });
    } catch {}
  }

  const allRequestLogs = pages.flatMap(({ requestLog }) => requestLog);
  const enrichedRequestLogs = enrichRequestLogsWithSourceEvents(
    allRequestLogs,
    sourceFlat,
    trialIdx,
    deliveryProfileResolved,
    sessionId,
    method,
    scenario,
  );

  // Close all per-user persistent contexts in parallel, with a hard timeout each.
  await Promise.all(perUserContexts.map(async (c, idx) => {
    try {
      await Promise.race([
        c.close(),
        sleep(8000).then(() => { log(`[teardown] context u${idx} close timed out, abandoning`); }),
      ]);
    } catch {}
  }));
  for (const ui of USER_INDICES) {
    const userDataDir = path.join(os.tmpdir(), `vrc_${sessionId}_u${ui}`);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }

  // ── Compute latency metrics from request logs (real network data) ────────────
  const chunkRequests = enrichedRequestLogs.filter(r =>
    r.url && (r.url.includes(".rad") || r.url.includes(".spz") || r.url.includes(".splat")) &&
    r.service_time_ms !== undefined && r.service_time_ms > 0 && r.service_time_ms < 120000
  );

  const sourceBreakdown = computeSourceBreakdownFromChunkLogs(chunkRequests);
  const sourceValidation = validateSourceConsistency(deliveryProfileResolved, enrichedRequestLogs, vrcDecisions, { cdn_label: VRC_CDN_LABEL });
  const sourceBreakdownRow = {
    session_id: sessionId,
    method,
    scenario,
    trial: trialIdx,
    delivery_profile: deliveryProfileResolved,
    cdn_label: VRC_CDN_LABEL || "",
    ...sourceBreakdown,
    mixed_source_valid: sourceValidation.mixed_source_valid,
    source_validation_ok: sourceValidation.valid,
    INVALID_MIXED_SOURCE: sourceValidation.INVALID_MIXED_SOURCE,
    source_validation_errors: (sourceValidation.errors ?? []).join("|"),
  };
  if (deliveryProfileResolved === "vrc_guided_hybrid") {
    sourceBreakdownRow.cdn1_request_count = sourceBreakdown.cdn_request_count;
    sourceBreakdownRow.cdn2_request_count_labeled = sourceBreakdown.cdn2_request_count;
  }

  const perClientMetricRows = USER_INDICES.map((i) => {
    const uid = `u${i}`;
    const rows = chunkRequests.filter((r) => r.user_id === uid);
    return {
      session_id: sessionId,
      method,
      scenario,
      trial: trialIdx,
      delivery_profile: deliveryProfileResolved,
      user_id: uid,
      ...shardMeta,
      ...computeSourceBreakdownFromChunkLogs(rows),
    };
  });

  let networkMetrics = {};
  if (chunkRequests.length > 0) {
    const latencies = chunkRequests.map(r => r.service_time_ms).sort((a,b) => a-b);
    const n = latencies.length;
    const p50 = latencies[Math.floor(n * 0.5)];
    const p95 = latencies[Math.floor(n * 0.95)];
    const p99 = latencies[Math.min(n-1, Math.floor(n * 0.99))];
    const frac50 = latencies.filter(x => x > 50).length / n;
    const totalBytes = chunkRequests.reduce((s, r) => s + (r.bytes_sent || 0), 0);
    const dupUrls = chunkRequests.reduce((m, r) => { m[r.url] = (m[r.url]||0)+1; return m; }, {});
    const dupCount = Object.values(dupUrls).filter(v => v > 1).length;
    const dupRatio = dupCount / Math.max(1, Object.keys(dupUrls).length);

    networkMetrics = {
      p50_latency_ms: p50,
      p95_latency_ms: p95,
      p99_latency_ms: p99,
      p95_latency_source: "object_or_range_completion",
      fraction_over_50ms: frac50,
      fraction_over_50ms_source: "object_or_range_completion",
      viewport_to_visible_latency_ms: "NA",
      viewport_to_visible_latency_source: "not_independently_measured",
      object_or_range_completion_ms: p50,
      object_or_range_completion_p95_ms: p95,
      aggregate_client_bytes: totalBytes,
      unique_bytes: totalBytes,
      duplicate_request_ratio: dupRatio,
      chunk_request_count: n,
      delivery_profile: deliveryProfileResolved,
      ...sourceBreakdown,
      mixed_source_valid: sourceValidation.mixed_source_valid,
      _source: "playwright_network_log",
    };
    log(`Network metrics: n=${n} p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms frac50=${(frac50*100).toFixed(1)}%`);
  } else {
    log(`WARNING: No CDN chunk requests found in request log (${enrichedRequestLogs.length} total requests)`);
  }

  // Write per-run files
  const clientMetricsFile = path.join(runDir, "client_metrics.jsonl");
  for (const m of [...trialMetrics, ...finalMetrics]) {
    appendJsonl(clientMetricsFile, m);
  }

  // Write network-derived metrics as a separate record (authoritative latency source)
  if (Object.keys(networkMetrics).length > 0) {
    const networkRecord = {
      ...networkMetrics,
      user_id: "aggregate", method, scenario, trial: trialIdx, session_id: sessionId,
      final: true, snapshot: "network_log",
    };
    appendJsonl(clientMetricsFile, networkRecord);
    for (let i = 0; i < NUM_USERS; i++) {
      const userId = `u${i}`;
      const fm = finalMetrics.find(m => m.user_id === userId) ?? {};
      const merged = {
        ...fm, ...networkMetrics,
        user_id: userId, method, scenario, trial: trialIdx, session_id: sessionId,
        final: true, snapshot: "merged_network",
        fps: fm.fps || networkMetrics.fps,
      };
      appendJsonl(clientMetricsFile, merged);
    }
  }

  const clientLogFile = path.join(runDir, "client_logs.jsonl");
  for (const l of clientLogs) {
    appendJsonl(clientLogFile, l);
  }

  const requestLogFile = path.join(runDir, "request_logs.jsonl");
  for (const r of enrichedRequestLogs) {
    appendJsonl(requestLogFile, r);
  }

  const sourceDecisionsFile = path.join(runDir, "source_decisions.jsonl");
  for (const s of sourceFlat) {
    appendJsonl(sourceDecisionsFile, s);
  }
  try {
    fs.writeFileSync(path.join(runDir, "source_breakdown.json"), JSON.stringify(sourceBreakdownRow, null, 2));
    fs.writeFileSync(path.join(runDir, "source_validation.json"), JSON.stringify(sourceValidation, null, 2));
    writeCsv(perClientMetricRows, path.join(runDir, "per_client_metrics.csv"));
  } catch (e) {
    log(`WARNING: source breakdown write failed: ${e.message}`);
  }

  const metricsForExport = finalMetrics.map((fm) => {
    const base = { ...fm, delivery_profile: deliveryProfileResolved };
    if (!Object.keys(networkMetrics).length) return base;
    return {
      ...base,
      ...networkMetrics,
      user_id: fm.user_id,
      fps: fm.fps ?? networkMetrics.fps,
      error: fm.error,
    };
  });

  // Provenance: hash of code files used for this run
  try {
    const crypto = await import("node:crypto");
    const codeFiles = [
      path.join(ROOT, "experiments", "run_experiment.mjs"),
      path.join(ROOT, "client_instrument", "metric_collector.js"),
      path.join(ROOT, "client_instrument", "vrc_scheduler.js"),
      path.join(ROOT, "client_instrument", "vrc_scene.html"),
      path.join(ROOT, "server", "sync_server.mjs"),
      path.join(ROOT, "analysis", "analyze.py"),
    ];
    const hashes = {};
    for (const cf of codeFiles) {
      try {
        const content = fs.readFileSync(cf);
        hashes[path.relative(ROOT, cf).replace(/\\/g,"/")] = crypto.createHash("sha256").update(content).digest("hex");
      } catch {}
    }
    fs.writeFileSync(path.join(runDir, "code_version.json"), JSON.stringify({
      session_id: sessionId, hashes, captured_at: new Date().toISOString(),
    }, null, 2));
  } catch {}

  if (VRC_SHARD_PARTIAL) {
    fs.writeFileSync(path.join(runDir, "distributed_shard_manifest.json"), JSON.stringify({
      session_id: sessionId,
      user_indices: USER_INDICES,
      method, scenario, trial: trialIdx,
      browser_origin: BROWSER_ORIGIN,
      sync_http_host: SYNC_HTTP_HOST,
      run_dir: runDir,
      screenshots_dir: trialScreenshotDir,
    }, null, 2));
    log(`[distributed] shard complete users=${USER_INDICES.join(",")} — merge on controller (no final status.json in shard dir)`);
    return { sessionId, status: "SHARD_DONE", method, scenario, trial: trialIdx, metrics: metricsForExport, shardPartial: true, runDir, sourceBreakdownRow, perClientMetricRows };
  }

  // visual_check.json — pixel-level PNG validation per user.
  // In metrics_only mode, screenshots are intentionally skipped, so record
  // "skipped_for_metrics_only" instead of running pixel checks against
  // non-existent files (which would otherwise look like a visual failure).
  let visualCheck;
  if (CAPTURE_MODE === "metrics_only") {
    visualCheck = {
      session_id: sessionId,
      screenshots: {},
      summary: {
        users_total: NUM_USERS,
        users_valid: 0,
        users_missing: 0,
        users_invalid_pixels: 0,
        all_valid: true,
        overall_status: "skipped_for_metrics_only",
        failures: [],
      },
    };
    fs.writeFileSync(path.join(runDir, "visual_check.json"), JSON.stringify(visualCheck, null, 2));
    log(`[visual] ${sessionId} -> skipped_for_metrics_only`);
  } else try {
    visualCheck = buildVisualCheck(sessionId, trialScreenshotDir, NUM_USERS);
    fs.writeFileSync(path.join(runDir, "visual_check.json"), JSON.stringify(visualCheck, null, 2));
    log(`[visual] ${sessionId} -> ${visualCheck.summary.overall_status} (${visualCheck.summary.users_valid}/${NUM_USERS})`);
    if (!visualCheck.summary.all_valid) {
      log(`[visual] failures: ${visualCheck.summary.failures.join(" | ")}`);
    }
  } catch (e) {
    log(`WARNING: visual_check failed: ${e.message}`);
    visualCheck = { summary: { all_valid: false, overall_status: "FAIL_VISUAL_VALIDATOR_ERROR", failures: [String(e.message)] } };
  }

  // metric_source.json — explicit provenance of latency metric
  try {
    fs.writeFileSync(path.join(runDir, "metric_source.json"), JSON.stringify({
      session_id: sessionId,
      delivery_profile: deliveryProfileResolved,
      hybrid_source_selection: deliveryProfileResolved === "legacy"
        ? "N/A — legacy static rad_asset_base only (no per-chunk fetch_plan)"
        : `Per-chunk routing: ${deliveryProfileResolved}; HPC=${VRC_HPC_ASSET_BASE}; CDN1=${VRC_CDN_ASSET_BASE}; hot_threshold=${VRC_HOT_THRESHOLD}; cdn_fallback=${VRC_CDN_FALLBACK_TO_HPC}`,
      p95_latency_source: "object_or_range_completion",
      viewport_to_visible_latency: "NA — not independently measured",
      duplicate_request_ratio_source: "url_plus_range",
      aggregate_client_bytes_source: "playwright_response_content_length",
      source_logging: "browser __vrcSourceEvents merged into request_logs.jsonl by user_id+final_url+Range",
    }, null, 2));
  } catch {}

  // scenario.json — copy of scenario file used
  try {
    const scenarioFile = path.join(ROOT, "experiments", "scenarios", `${scenario}.json`);
    if (fs.existsSync(scenarioFile)) {
      fs.copyFileSync(scenarioFile, path.join(runDir, "scenario.json"));
    }
  } catch {}

  if (vrcDecisions.length > 0) {
    const decisionsFile = path.join(runDir, "vrc_decisions.jsonl");
    for (const d of vrcDecisions) {
      appendJsonl(decisionsFile, d);
    }
  }

  // Also write a flat metrics.jsonl for backward compat with analyze.py
  // Prefer merged_network rows (have real latency data)
  const flatMetricsFile = path.join(RESULTS_RAW, `${sessionId}_metrics.jsonl`);
  const allMetricRows = [...trialMetrics, ...finalMetrics];
  if (Object.keys(networkMetrics).length > 0) {
    for (let i = 0; i < NUM_USERS; i++) {
      const userId = `u${i}`;
      const fm = finalMetrics.find(m => m.user_id === userId) ?? {};
      allMetricRows.push({
        ...fm, ...networkMetrics,
        user_id: userId, method, scenario, trial: trialIdx, session_id: sessionId,
        final: true, snapshot: "merged_network",
      });
    }
  }
  for (const m of allMetricRows) {
    appendJsonl(flatMetricsFile, m);
  }

  // Determine status (metrics + visual gate combined).
  // Gate: status.json is only written after every u0..u3 has a capture record
  // (either a valid screenshot or an explicit failure row in screenshot_timing.jsonl).
  const hasRealMetrics = finalMetrics.some(m => !m.error && (m.fps !== undefined || m.p95_latency_ms !== undefined))
    || Object.keys(networkMetrics).length > 0;
  const visualOk = !!(visualCheck && visualCheck.summary && visualCheck.summary.all_valid);
  const visualOverall = visualCheck?.summary?.overall_status ?? "UNKNOWN";

  const allAccountedFor = [...Array(NUM_USERS).keys()].every(i => captureRecords.has(`u${i}`));
  if (!allAccountedFor) {
    log(`FATAL: capture record missing for some users — status.json NOT written for ${sessionId}`);
    return { sessionId, status: "FAIL_VISUAL_MISSING_SCREENSHOTS", method, scenario, trial: trialIdx, metrics: metricsForExport, sourceBreakdownRow, perClientMetricRows };
  }

  // Only a real page/browser crash is allowed to leave a FILE_MISSING.
  // Otherwise promote to FAIL_VISUAL_MISSING_SCREENSHOTS regardless of pixel-level visual gate.
  const missingUsers = [];
  const crashedUsers = [];
  for (let i = 0; i < NUM_USERS; i++) {
    const rec = captureRecords.get(`u${i}`);
    if (!rec.screenshot_saved) {
      missingUsers.push(`u${i}`);
      if (rec.page_crashed) crashedUsers.push(`u${i}`);
    }
  }

  // Metric-gate pass criteria for metrics_only mode: real metrics from all 4
  // clients, request logs, chunk count > 0, and object/range p95 > 0.
  const chunkCount = chunkRequests.length;
  const metricGatePass =
    hasRealMetrics &&
    finalMetrics.filter(m => !m.error).length === NUM_USERS &&
    allRequestLogs.length > 0 &&
    chunkCount > 0 &&
    (networkMetrics.p95_latency_ms ?? 0) > 0;

  const anyLoadIncomplete = [...captureRecords.values()].some(r =>
    r.visual_ready_reason === "LOAD_INCOMPLETE"
    || String(r.failure_reason ?? "").includes("LOAD_INCOMPLETE"));
  const anyCaptureTimeout = [...captureRecords.values()].some(r =>
    String(r.failure_reason ?? "").includes("CAPTURE_TIMEOUT"));

  let runStatus;
  if (CAPTURE_MODE === "metrics_only") {
    // Visual gate is N/A in metrics_only — never fail for missing/invalid screenshots.
    runStatus = metricGatePass ? "PASS" : "FAIL_METRICS_GATE";
  } else if (!hasRealMetrics) {
    runStatus = "WARN_NO_METRICS";
  } else if (anyLoadIncomplete) {
    runStatus = "FAIL_LOAD_INCOMPLETE";
  } else if (anyCaptureTimeout) {
    runStatus = "FAIL_CAPTURE_TIMEOUT";
  } else if (missingUsers.length === NUM_USERS) {
    runStatus = "FAIL_VISUAL_MISSING_SCREENSHOTS";
  } else if (missingUsers.length > 0) {
    runStatus = "FAIL_VISUAL_INCOMPLETE_USERS";
  } else if (!visualOk) {
    runStatus = visualOverall; // precise pixel reason from validator
  } else {
    runStatus = "PASS";
  }

  writeRunStatus(runDir, runStatus, {
    method, scenario, trial: trialIdx, session_id: sessionId,
    delivery_profile: deliveryProfileResolved,
    source_validation: sourceValidation,
    clients: finalMetrics.length, client_metrics_with_data: finalMetrics.filter(m => !m.error).length,
    client_log_entries: clientLogs.length, request_log_entries: allRequestLogs.length,
    visual_status: visualOverall,
    visual_failures: visualCheck?.summary?.failures ?? [],
    missing_users: missingUsers,
    crashed_users: crashedUsers,
    capture_records: [...captureRecords.values()],
    timestamp_end: new Date().toISOString(),
  });

  log(`Trial done: ${sessionId} — status=${runStatus} — ${finalMetrics.filter(m=>!m.error).length}/${NUM_USERS} clients with metrics, missing=${missingUsers.length}`);
  return { sessionId, status: runStatus, method, scenario, trial: trialIdx, metrics: metricsForExport, sourceBreakdownRow, perClientMetricRows };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log("=== VRC Experiment Runner — REAL MODE (no smoke, no simulation) ===");
  log(`Methods: ${UNIQUE_METHODS.join(", ")}`);
  log(`Scenarios: ${SCENARIOS.join(", ")}`);
  log(`Trials per cell: ${TRIALS}`);
  log(`Trial duration: ${TRIAL_DURATION_MS}ms`);
  log(`Expected runs: ${EXPECTED_RUNS}`);
  log(`Headless: ${HEADLESS}`);
  log(`[capture-tuning] splat_wait_ms=${SCREENSHOT_DELAY_MS} cdp_ms=${CDP_CAPTURE_TIMEOUT_MS} viewport_ms=${VIEWPORT_CAPTURE_TIMEOUT_MS} dataurl_ms=${DATAURL_CAPTURE_TIMEOUT_MS} per_user_cap_ms=${PER_USER_CAPTURE_MS} drain_after_budget_ms=${CAPTURE_DRAIN_AFTER_BUDGET_MS} seq_fps_wait_ms=${SEQUENTIAL_FPS_WAIT_MS} low_fps_probe_ms=${LOW_FPS_PROBE_BUDGET_MS} goto_ms=${GOTO_TIMEOUT_MS}`);

  // Install Playwright if needed
  let chromium;
  try {
    const pw = await import("playwright");
    chromium = pw.chromium;
    log("Playwright loaded.");
  } catch {
    log("Playwright not installed. Attempting install...");
    try {
      execSync("npm install -D playwright", { cwd: REPO_ROOT, stdio: "inherit", timeout: 120000 });
      execSync("npx playwright install chromium", { cwd: REPO_ROOT, stdio: "inherit", timeout: 180000 });
      const pw = await import("playwright");
      chromium = pw.chromium;
      log("Playwright installed and loaded.");
    } catch (e) {
      log(`FATAL: Playwright install failed: ${e.message}`);
      log("FATAL: Cannot run real experiments without Playwright. Install it and retry.");
      await teardown("playwright-install-failed");
      process.exit(1);
    }
  }

  // Start servers (worker shard skips — uses controller LAN origin)
  let viteOk = true;
  let syncOk = true;
  if (!VRC_SKIP_LOCAL_SERVERS) {
    viteOk = await startVite();
    if (!viteOk) {
      log("FATAL: Vite dev server is required for real browser experiments. Fix and retry.");
      await teardown("vite-start-failed");
      process.exit(1);
    }
    syncOk = await startSyncServer();
    if (!syncOk) {
      log("WARNING: Sync server not available — multi-user sync/avatar/VRC decisions will be limited");
    }
  } else {
    log("[distributed] VRC_SKIP_LOCAL_SERVERS=1 — not starting local Vite/sync (worker or pre-started controller)");
  }

  const SINGLE = process.env.VRC_SINGLE_TRIAL?.trim();
  if (SINGLE) {
    const parts = SINGLE.split(":").map(s => s.trim());
    if (parts.length !== 3) {
      log("FATAL: VRC_SINGLE_TRIAL must be method:scenario:trialIndex (e.g. Full:nearby:0)");
      await teardown("bad-single-trial");
      process.exit(2);
    }
    const [sm, sc, tStr] = parts;
    const t = parseInt(tStr, 10);
    if (!UNIQUE_METHODS.includes(sm) || !SCENARIOS.includes(sc) || !Number.isInteger(t) || t < 0 || t >= TRIALS) {
      log(`FATAL: invalid VRC_SINGLE_TRIAL=${SINGLE} (methods=${UNIQUE_METHODS.join(",")} scenarios=${SCENARIOS.join(",")} trials=0..${TRIALS - 1})`);
      await teardown("bad-single-trial");
      process.exit(2);
    }
    log(`=== Single trial mode: ${sm} ${sc} trial ${t} ===`);
    let result;
    try {
      result = await runTrial({ chromium, method: sm, scenario: sc, trialIdx: t, runIdx: 1 });
    } catch (err) {
      log(`ERROR in single trial: ${err.message}`);
      appendJsonl(path.join(RESULTS_RAW, "errors.jsonl"), {
        method: sm, scenario: sc, trial: t, error: err.message, stack: err.stack?.slice(0, 500),
      });
      result = { sessionId: `${sm}_${sc}_t${t}_err`, status: "FAIL", method: sm, scenario: sc, trial: t, sourceBreakdownRow: null, perClientMetricRows: [], metrics: [] };
    }
    if ((viteProc || syncProc) && process.env.VRC_SINGLE_TRIAL_NO_TEARDOWN !== "1") {
      await teardown("single-trial-complete");
    } else if (process.env.VRC_SINGLE_TRIAL_NO_TEARDOWN === "1") {
      log("[single-trial] skip teardown (VRC_SINGLE_TRIAL_NO_TEARDOWN=1 — distributed child or chained runs)");
    }
    const ok = result.status === "PASS" || result.status === "SHARD_DONE";
    log(`Single trial exit: status=${result.status} ok=${ok}`);
    const skipShardSummary = process.env.VRC_DISTRIBUTED_SHARD_SKIP_SUMMARY === "1";
    try {
      const sumAppend = process.env.VRC_SUMMARY_APPEND === "1";
      const sumDir = path.join(RESULTS_ROOT, "summary");
      const runSeq = Number(process.env.VRC_RUN_SEQ || 1);
      if (!skipShardSummary) {
        const pfRow = [{
          run: runSeq,
          method: sm,
          scenario: sc,
          trial: t,
          status: result.status,
          session_id: result.sessionId ?? "UNKNOWN",
          delivery_profile: (VRC_DELIVERY_PROFILE || "").trim() || "legacy",
        }];
        mergeOrWriteSummaryCsv(path.join(sumDir, "run_pass_fail.csv"), pfRow, sumAppend);
        if (result.metrics?.length) mergeOrWriteSummaryCsv(path.join(sumDir, "per_run_metrics.csv"), result.metrics, sumAppend);
        if (result.sourceBreakdownRow) mergeOrWriteSummaryCsv(path.join(sumDir, "source_breakdown.csv"), [result.sourceBreakdownRow], sumAppend);
        if (result.perClientMetricRows?.length) mergeOrWriteSummaryCsv(path.join(sumDir, "per_client_metrics.csv"), result.perClientMetricRows, sumAppend);
      } else {
        log("[distributed] VRC_DISTRIBUTED_SHARD_SKIP_SUMMARY=1 — controller will write summary after merge");
      }
    } catch (e) {
      log(`WARNING: single-trial summary CSV write: ${e.message}`);
    }
    process.exit(ok ? 0 : 1);
  }

  const allResults = [];
  const passFailTable = [];
  let runIdx = 0;

  for (const scenario of SCENARIOS) {
    for (const method of UNIQUE_METHODS) {
      for (let t = 0; t < TRIALS; t++) {
        runIdx++;
        let result;
        try {
          result = await runTrial({ chromium, method, scenario, trialIdx: t, runIdx });
          allResults.push(result);
        } catch (err) {
          log(`ERROR in trial method=${method} scenario=${scenario} t=${t}: ${err.message}`);
          result = { sessionId: `${method}_${scenario}_t${t}_err`, status: "FAIL", method, scenario, trial: t };
          appendJsonl(path.join(RESULTS_RAW, "errors.jsonl"), {
            method, scenario, trial: t, error: err.message, stack: err.stack?.slice(0, 500),
          });
        }
        passFailTable.push({
          run: (process.env.VRC_SUMMARY_APPEND === "1" && process.env.VRC_RUN_SEQ)
            ? Number(process.env.VRC_RUN_SEQ)
            : runIdx,
          method, scenario, trial: t,
          status: result.status,
          session_id: result.sessionId ?? "UNKNOWN",
          delivery_profile: (VRC_DELIVERY_PROFILE || "").trim() || "legacy",
        });
        await sleep(2000);  // cooldown between runs
      }
    }
  }

  // Write pass/fail + summary CSV (append-merge when VRC_SUMMARY_APPEND=1 for multi-invocation harnesses)
  const sumAppend = process.env.VRC_SUMMARY_APPEND === "1";
  mergeOrWriteSummaryCsv(path.join(RESULTS_SUMMARY, "run_pass_fail.csv"), passFailTable, sumAppend);
  log(`Pass/fail table: ${passFailTable.filter(r => r.status === "PASS" || r.status === "SHARD_DONE").length}/${passFailTable.length} PASS`);

  const allMetrics = allResults.flatMap(r => r.metrics ?? []);
  if (allMetrics.length > 0) {
    mergeOrWriteSummaryCsv(path.join(RESULTS_SUMMARY, "per_run_metrics.csv"), allMetrics, sumAppend);
    log(`Wrote per_run_metrics.csv with ${allMetrics.length} rows`);
  }

  const allSourceBreakdown = allResults.flatMap(r => (r.sourceBreakdownRow ? [r.sourceBreakdownRow] : []));
  if (allSourceBreakdown.length > 0) {
    mergeOrWriteSummaryCsv(path.join(RESULTS_SUMMARY, "source_breakdown.csv"), allSourceBreakdown, sumAppend);
    log(`Wrote source_breakdown.csv with ${allSourceBreakdown.length} rows`);
  }
  const allPerClient = allResults.flatMap(r => r.perClientMetricRows ?? []);
  if (allPerClient.length > 0) {
    mergeOrWriteSummaryCsv(path.join(RESULTS_SUMMARY, "per_client_metrics.csv"), allPerClient, sumAppend);
    log(`Wrote per_client_metrics.csv with ${allPerClient.length} rows`);
  }

  if (viteProc || syncProc) { await teardown("main-complete"); }

  // Treat any status != PASS as failure. FAIL_VISUAL_*, WARN_NO_METRICS, and FAIL
  // all count as non-PASS; the runner exits non-zero so the orchestrator,
  // run_pass_fail.csv, and CI signals all reflect the true state.
  const passCount = passFailTable.filter(r => r.status === "PASS" || r.status === "SHARD_DONE").length;
  const nonPassCount = passFailTable.length - passCount;
  log(`=== Experiment runner complete: ${runIdx} runs, ${passCount} PASS, ${nonPassCount} non-PASS ===`);

  if (nonPassCount > 0) {
    log(`${nonPassCount} runs did not PASS. Check ${RESULTS_RAW}/*/status.json and ${RESULTS_RAW}/errors.jsonl`);
  }
  process.exit(nonPassCount > 0 ? 1 : 0);
}

function writeCsv(rows, file) {
  if (!rows.length) return;
  const keys = [...new Set(rows.flatMap(Object.keys))];
  const header = keys.join(",");
  const lines = rows.map(r => keys.map(k => {
    const v = r[k];
    if (v == null) return "";
    if (typeof v === "string" && (v.includes(",") || v.includes('"'))) return `"${v.replace(/"/g, '""')}"`;
    return String(v);
  }).join(","));
  fs.writeFileSync(file, [header, ...lines].join("\n"));
}

/** Merge new rows into an existing summary CSV (same as writeCsv when append=false). */
function mergeOrWriteSummaryCsv(file, newRows, append) {
  if (!newRows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!append || !fs.existsSync(file) || fs.statSync(file).size === 0) {
    writeCsv(newRows, file);
    return;
  }
  const prev = readSummaryCsvLoose(file);
  writeCsv([...prev, ...newRows], file);
}

/** Best-effort CSV read for summary tables (no embedded commas in values). */
function readSummaryCsvLoose(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) return [];
  const lines = text.split(/\n/).filter(Boolean);
  const header = lines[0].split(",").map((h) => h.replace(/^"|"$/g, ""));
  return lines.slice(1).map((line) => {
    const cols = line.split(",").map((c) => c.replace(/^"|"$/g, ""));
    const o = {};
    header.forEach((k, i) => { o[k] = cols[i] ?? ""; });
    return o;
  });
}

function isMainModule() {
  try {
    const here = path.resolve(fileURLToPath(import.meta.url));
    const arg1 = path.resolve(process.argv[1] ?? "");
    return here === arg1;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    console.error("[runner] FATAL:", err);
    process.exit(1);
  });
}
