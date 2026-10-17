// debug_single_user_driver.mjs
// Launch ONE Playwright Chromium against the VRC Spark scene and capture
// deep diagnostics to root-cause blank/white/black screenshots.
//
// Env (set by debug_visual_single_user.ps1):
//   VRC_HEADLESS                  "true"|"false"
//   VITE_PORT                     "9200"
//   VRC_SYNC_PORT                 "9201"
//   VRC_DEBUG_OUT_DIR             absolute path to artifact dir
//   VRC_DEBUG_METHOD              e.g. "Full"
//   VRC_DEBUG_SCENARIO            e.g. "nearby"
//   VRC_DEBUG_HOLD_MS             how long to let scene run total
//   VRC_DEBUG_FIRST_SHOT_DELAY_MS delay before first screenshot

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { validatePngFile } from "./visual_validator.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const HEADLESS      = (process.env.VRC_HEADLESS ?? "false") === "true";
const VITE_PORT     = Number(process.env.VITE_PORT ?? 9200);
const SYNC_PORT     = Number(process.env.VRC_SYNC_PORT ?? 9201);
const OUT_DIR       = process.env.VRC_DEBUG_OUT_DIR;
const METHOD        = process.env.VRC_DEBUG_METHOD   ?? "Full";
const SCENARIO      = process.env.VRC_DEBUG_SCENARIO ?? "nearby";
const HOLD_MS       = Number(process.env.VRC_DEBUG_HOLD_MS ?? 25000);
const FIRST_SHOT_MS = Number(process.env.VRC_DEBUG_FIRST_SHOT_DELAY_MS ?? 8000);

if (!OUT_DIR) { console.error("VRC_DEBUG_OUT_DIR not set"); process.exit(2); }
fs.mkdirSync(OUT_DIR, { recursive: true });

const SESSION_ID = path.basename(OUT_DIR);
const USER_ID    = "u0";

const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(OUT_DIR, "driver.log"), line + "\n");
};

function jsonl(file, obj) {
  fs.appendFileSync(path.join(OUT_DIR, file), JSON.stringify(obj) + "\n");
}

async function main() {
  log(`headless=${HEADLESS} vitePort=${VITE_PORT} method=${METHOD} scenario=${SCENARIO}`);
  log(`out=${OUT_DIR}`);

  const { chromium } = await import("playwright");

  const url = `http://localhost:${VITE_PORT}/vrc-paper/client_instrument/vrc_scene.html` +
    `?user_id=${USER_ID}` +
    `&method=${encodeURIComponent(METHOD)}` +
    `&session_id=${encodeURIComponent(SESSION_ID)}` +
    `&scenario_id=${encodeURIComponent(SCENARIO)}` +
    `&sync_port=${SYNC_PORT}` +
    `&world=Coit+Tower%2C+SF`;

  // Fresh userDataDir per run.
  const userDataDir = path.join(os.tmpdir(), `vrc_debug_${SESSION_ID}_${USER_ID}`);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(userDataDir, { recursive: true });

  const CHROME_FLAGS = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--ignore-certificate-errors",
    "--use-gl=angle",
    "--use-angle=d3d11",
    "--enable-webgl",
    "--force-high-performance-gpu",
    "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization",
    "--allow-running-insecure-content",
    ...(HEADLESS ? [
      "--enable-unsafe-swiftshader",
      "--disable-backgrounding-occluded-windows",
      "--disable-background-timer-throttling",
    ] : []),
  ];

  log("launching chromium with flags: " + CHROME_FLAGS.join(" "));
  const t0 = Date.now();
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: HEADLESS,
    args: CHROME_FLAGS,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  });
  log(`chromium launched in ${Date.now()-t0}ms`);

  const page = ctx.pages()[0] ?? await ctx.newPage();

  page.on("console", msg => {
    const entry = { t: Date.now(), type: msg.type(), text: msg.text() };
    jsonl("console.jsonl", entry);
    if (msg.type() === "error" || msg.type() === "warning") {
      log(`[console:${msg.type()}] ${msg.text()}`);
    }
  });

  page.on("pageerror", err => {
    const entry = { t: Date.now(), type: "pageerror", text: String(err.message), stack: err.stack };
    jsonl("console.jsonl", entry);
    log(`[pageerror] ${err.message}`);
  });

  page.on("requestfailed", req => {
    const entry = {
      t: Date.now(), url: req.url(), failure: req.failure()?.errorText,
      method: req.method(), resource_type: req.resourceType(),
    };
    jsonl("request_failed.jsonl", entry);
    log(`[requestfailed] ${req.url()} -> ${entry.failure}`);
  });

  const requests = new Map();
  page.on("request", req => {
    const u = req.url();
    requests.set(req, { t_start: Date.now(), url: u, resource_type: req.resourceType() });
    if (u.includes(".rad") || u.includes(".spz") || u.includes(".splat") || u.includes("forge-dev-public") || u.includes(".r2.dev")) {
      jsonl("asset_requests.jsonl", { t: Date.now(), event: "start", url: u, type: req.resourceType() });
    }
  });
  page.on("response", async res => {
    const req = res.request();
    const entry = requests.get(req);
    if (!entry) return;
    entry.t_end = Date.now();
    entry.status = res.status();
    entry.service_time_ms = entry.t_end - entry.t_start;
    try {
      const cl = res.headers()["content-length"];
      entry.bytes = cl ? Number(cl) : 0;
      const h = req.headers();
      if (h["range"]) entry.range = h["range"];
    } catch {}
    const u = entry.url;
    if (u.includes(".rad") || u.includes(".spz") || u.includes(".splat") || u.includes("forge-dev-public") || u.includes(".r2.dev")) {
      jsonl("asset_requests.jsonl", {
        t: Date.now(), event: "end", url: u, status: entry.status,
        service_time_ms: entry.service_time_ms, bytes: entry.bytes, range: entry.range,
      });
    }
  });

  // ── page.goto timing ────────────────────────────────────────────────────────
  const gotoStart = Date.now();
  let gotoStatus = "ok", gotoErr = null;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  } catch (err) {
    gotoStatus = "fail"; gotoErr = err.message;
    log(`goto failed: ${err.message}`);
  }
  const gotoEnd = Date.now();
  log(`page.goto status=${gotoStatus} ms=${gotoEnd-gotoStart}`);
  fs.writeFileSync(path.join(OUT_DIR, "goto.json"), JSON.stringify({
    url, status: gotoStatus, error: gotoErr, ms: gotoEnd - gotoStart,
  }, null, 2));

  // Let the scene start.
  log(`waiting ${FIRST_SHOT_MS}ms for scene bootstrap...`);
  await page.waitForTimeout(FIRST_SHOT_MS);

  // ── WebGL + canvas inspection ──────────────────────────────────────────────
  const webglInfo = await page.evaluate(() => {
    const result = { canvas: null, gl_attrs: null, gl_ctx: null, vendor: null, renderer: null,
                     gl_errors: [], has_spark: !!window.__slDiagCam, gl_ctx_lost: null };
    const c = document.querySelector("canvas");
    if (!c) return { error: "NO_CANVAS", ...result };
    result.canvas = { width: c.width, height: c.height,
                      clientWidth: c.clientWidth, clientHeight: c.clientHeight,
                      devicePixelRatio: window.devicePixelRatio };
    let gl = c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl");
    if (!gl) return { error: "NO_WEBGL_CTX", ...result };
    try { result.gl_ctx = gl.getParameter(gl.VERSION); } catch {}
    try { result.vendor = gl.getParameter(gl.VENDOR); } catch {}
    try { result.renderer = gl.getParameter(gl.RENDERER); } catch {}
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    if (dbg) {
      try { result.unmasked_vendor   = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL); } catch {}
      try { result.unmasked_renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL); } catch {}
    }
    try { result.gl_attrs = gl.getContextAttributes(); } catch {}
    try { result.gl_ctx_lost = gl.isContextLost(); } catch {}
    try {
      let e;
      for (let i = 0; i < 5; i++) { e = gl.getError(); if (e === gl.NO_ERROR) break; result.gl_errors.push(e); }
    } catch {}
    try {
      result.maxTextureSize     = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      result.maxCubeMapTextureSize = gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE);
    } catch {}
    result.camera = window.__slDiagCam ? {
      position: window.__slDiagCam.position.toArray(),
      quaternion: window.__slDiagCam.quaternion.toArray(),
      fov: window.__slDiagCam.fov,
    } : null;
    return result;
  }).catch(err => ({ error: `EVAL:${err.message}` }));
  fs.writeFileSync(path.join(OUT_DIR, "webgl_info.json"), JSON.stringify(webglInfo, null, 2));
  log("webgl_info: " + JSON.stringify({
    canvas: webglInfo?.canvas,
    vendor: webglInfo?.vendor,
    renderer: webglInfo?.renderer,
    unmasked_renderer: webglInfo?.unmasked_renderer,
    gl_ctx_lost: webglInfo?.gl_ctx_lost,
    gl_errors: webglInfo?.gl_errors,
    err: webglInfo?.error,
  }));

  // ── FPS probe (sample RAFs over ~1s) ───────────────────────────────────────
  const fpsProbe = await page.evaluate(async () => {
    const start = performance.now();
    let frames = 0;
    await new Promise(resolve => {
      const deadline = start + 1000;
      function tick() {
        frames++;
        if (performance.now() >= deadline) resolve();
        else requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
    const elapsed = performance.now() - start;
    return { frames, elapsed_ms: elapsed, fps: frames / (elapsed / 1000) };
  }).catch(err => ({ error: err.message }));
  fs.writeFileSync(path.join(OUT_DIR, "fps_probe.json"), JSON.stringify(fpsProbe, null, 2));
  log(`fps_probe: ${JSON.stringify(fpsProbe)}`);

  // ── First screenshot ────────────────────────────────────────────────────────
  const shot1 = path.join(OUT_DIR, `shot1_${USER_ID}.png`);
  try {
    await page.screenshot({ path: shot1, fullPage: false, type: "png",
      clip: { x: 0, y: 0, width: 1280, height: 720 }, timeout: 12000 });
    log(`shot1 saved: ${shot1}`);
  } catch (err) {
    log(`shot1 failed: ${err.message}`);
  }
  const shot1Val = fs.existsSync(shot1) ? validatePngFile(shot1) : { exists: false };
  log(`shot1 validation: ${JSON.stringify(shot1Val)}`);

  // ── Wait the rest of HOLD_MS, then final screenshot ────────────────────────
  const remaining = Math.max(0, HOLD_MS - FIRST_SHOT_MS);
  if (remaining > 0) { log(`holding ${remaining}ms more...`); await page.waitForTimeout(remaining); }

  const shot2 = path.join(OUT_DIR, `shot2_${USER_ID}.png`);
  try {
    await page.screenshot({ path: shot2, fullPage: false, type: "png",
      clip: { x: 0, y: 0, width: 1280, height: 720 }, timeout: 12000 });
    log(`shot2 saved: ${shot2}`);
  } catch (err) {
    log(`shot2 failed: ${err.message}`);
  }
  const shot2Val = fs.existsSync(shot2) ? validatePngFile(shot2) : { exists: false };
  log(`shot2 validation: ${JSON.stringify(shot2Val)}`);

  // ── canvas.toDataURL fallback (so we know if WebGL painted, even if page.screenshot saw DOM only) ──
  try {
    const dataUrl = await page.evaluate(() => {
      const c = document.querySelector("canvas");
      if (!c) return null;
      try { return c.toDataURL("image/png"); } catch (e) { return `ERR:${e.message}`; }
    });
    if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/png")) {
      const pngPath = path.join(OUT_DIR, `canvas_dataurl_${USER_ID}.png`);
      fs.writeFileSync(pngPath, Buffer.from(dataUrl.split(",")[1], "base64"));
      const cVal = validatePngFile(pngPath);
      log(`canvas_dataurl validation: ${JSON.stringify(cVal)}`);
      fs.writeFileSync(path.join(OUT_DIR, "canvas_dataurl_check.json"), JSON.stringify(cVal, null, 2));
    } else {
      log(`canvas_dataurl returned: ${String(dataUrl).slice(0,80)}`);
    }
  } catch (err) {
    log(`canvas_dataurl failed: ${err.message}`);
  }

  // ── Spark / metric collector snapshot ──────────────────────────────────────
  const sparkSnap = await page.evaluate(() => ({
    has_metrics_fn: typeof window.__vrcGetMetrics === "function",
    metrics: typeof window.__vrcGetMetrics === "function" ? window.__vrcGetMetrics() : null,
    raw_chunks: window.__vrcRawMetrics?.seen_chunks
      ? (window.__vrcRawMetrics.seen_chunks.size ?? null) : null,
    camera: window.__slDiagCam ? {
      position: window.__slDiagCam.position.toArray(),
      quaternion: window.__slDiagCam.quaternion.toArray(),
    } : null,
    canvas: (() => {
      const c = document.querySelector("canvas");
      return c ? { w: c.width, h: c.height, clientW: c.clientWidth, clientH: c.clientHeight } : null;
    })(),
  })).catch(err => ({ error: err.message }));
  fs.writeFileSync(path.join(OUT_DIR, "spark_snapshot.json"), JSON.stringify(sparkSnap, null, 2));
  log("spark_snapshot: " + JSON.stringify(sparkSnap));

  // ── Summary ────────────────────────────────────────────────────────────────
  const assetEvents = fs.existsSync(path.join(OUT_DIR, "asset_requests.jsonl"))
    ? fs.readFileSync(path.join(OUT_DIR, "asset_requests.jsonl"), "utf8")
        .trim().split(/\n+/).filter(Boolean).map(l => JSON.parse(l)) : [];
  const assetEnds = assetEvents.filter(e => e.event === "end");
  const assetEndsOk = assetEnds.filter(e => e.status >= 200 && e.status < 400);
  const totalBytes = assetEnds.reduce((s,e) => s + (e.bytes||0), 0);

  const summary = {
    session_id: SESSION_ID,
    headless: HEADLESS,
    page_goto: { status: gotoStatus, ms: gotoEnd - gotoStart, error: gotoErr },
    webgl: {
      has_ctx: !webglInfo.error,
      vendor: webglInfo.vendor,
      renderer: webglInfo.renderer,
      unmasked_renderer: webglInfo.unmasked_renderer,
      gl_ctx_lost: webglInfo.gl_ctx_lost,
      gl_errors: webglInfo.gl_errors,
      error: webglInfo.error,
    },
    canvas: webglInfo?.canvas,
    fps: fpsProbe?.fps ?? null,
    camera: webglInfo?.camera,
    assets: {
      starts: assetEvents.filter(e => e.event === "start").length,
      ends:   assetEnds.length,
      ok:     assetEndsOk.length,
      total_bytes: totalBytes,
    },
    shot1: shot1Val,
    shot2: shot2Val,
    spark: sparkSnap,
  };
  fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));
  log("summary: " + JSON.stringify({
    page_goto: summary.page_goto,
    webgl_renderer: summary.webgl.unmasked_renderer ?? summary.webgl.renderer,
    webgl_ctx_lost: summary.webgl.gl_ctx_lost,
    fps: summary.fps,
    assets_ok: summary.assets.ok, bytes: summary.assets.total_bytes,
    shot2_valid: summary.shot2?.screenshot_valid, shot2_reason: summary.shot2?.failure_reason,
    shot2_non_bg: summary.shot2?.non_background_ratio, shot2_mean_luma: summary.shot2?.mean_luma,
  }));

  await ctx.close();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}

  const pass = !!(summary.shot2 && summary.shot2.screenshot_valid);
  log(`RESULT: ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
}

main().catch(err => {
  console.error("[driver] FATAL:", err);
  fs.appendFileSync(path.join(OUT_DIR, "driver.log"), `FATAL: ${err.stack || err.message}\n`);
  process.exit(2);
});
