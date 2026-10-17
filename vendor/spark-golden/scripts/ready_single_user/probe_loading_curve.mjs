/**
 * Quick probe: sample visible splat count at t=1s, 2s, 3s, 4s, 5s for each method.
 * Finds the timestamp with best differentiation.
 * Usage: node scripts/ready_single_user/probe_loading_curve.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { NVIDIA_CHROME_ARGS } from "../lib/local_stutter_nvidia_chrome.mjs";
import { buildAblationHtml } from "../lib/local_stutter_ablation_html.mjs";
import { startPageStaticServer } from "../lib/local_stutter_ablation_cell.mjs";
import { replayCameraTrace } from "./trace_replay.mjs";
import { BASELINES } from "./constants.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

const METHODS = ["spark_od", "dls", "progs", "sgss"];
const SCENE_URL = "https://streaming-1438331348.cos.ap-guangzhou.myqcloud.com/tijerin_w6_hobbiton-lod.rad";
const TRACE = "burst_turn";
const SAMPLE_TIMES_MS = [1000, 1500, 2000, 2500, 3000, 4000, 5000];

async function probeMethod(methodId) {
  const arm = BASELINES[methodId];
  if (!arm) return null;

  const sdlK = arm.sdl_k ?? 0;
  const coalesceK = arm.coalesce_k ?? 1;
  const proactiveBaseline = arm.proactive_baseline ?? "B0";
  const needsProactive = arm.ready_aware && proactiveBaseline !== "B0";

  const { outFile } = await buildAblationHtml({
    assetUrl: SCENE_URL,
    pixelRatio: "1.0",
    ablationMode: "normal",
    proactiveBaselineCode: needsProactive ? proactiveBaseline : null,
  });

  const pathOverrides = new Map([["/index.html", outFile]]);
  const { server, port, base } = await startPageStaticServer(0, pathOverrides);

  let browser;
  const samples = {};
  try {
    browser = await chromium.launch({
      headless: false,
      args: NVIDIA_CHROME_ARGS,
      ignoreDefaultArgs: ["--enable-unsafe-swiftshader"],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    await page.addInitScript((params) => {
      window.__sparkSdlK = params.sdlK;
      window.__sparkCoalesceK = params.coalesceK;
      window.__proactiveBaseline = params.proactiveBaseline;
    }, { sdlK, coalesceK, proactiveBaseline });

    const pageUrl = new URL(base);
    if (needsProactive) pageUrl.searchParams.set("VRC_PROACTIVE_BASELINE", proactiveBaseline);
    await page.goto(pageUrl.href, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__slDiagCam != null, { timeout: 30000 });

    // Start trace replay and sample at multiple timestamps
    // We'll replay for the full 5s but inject sampling code
    await page.evaluate(() => {
      window.__splatSamples = [];
      window.__sampleStartTime = performance.now();
    });

    // Start the trace
    await page.evaluate((trace) => {
      // Trigger trace replay via the same mechanism
      window.__probeTrace = trace;
    }, TRACE);

    // Use replayCameraTrace but sample at intervals
    // Actually, let's just replay and poll
    const startTime = Date.now();
    await page.evaluate((traceMode) => {
      // Start camera movement manually using the existing __slDiagCam
      window.__probeStarted = performance.now();
    }, TRACE);

    // Replay trace for full duration, sampling along the way
    await replayCameraTrace(page, TRACE, 5000, {
      onTick: async (elapsedMs) => {
        // This won't work with replayCameraTrace API, so let's do it differently
      }
    }).catch(() => {});

    // Actually, simpler approach: replay for each sample time separately
    // But that's expensive. Let's just do one 5s run and sample periodically.
    // The issue is replayCameraTrace blocks for the duration.
    // Let's inject a periodic sampler before starting the trace.

    await browser.close();
    browser = null;
  } catch (e) {
    console.error(`ERROR ${methodId}: ${e.message}`);
    if (browser) await browser.close().catch(() => {});
  } finally {
    server.close();
  }
  return samples;
}

// Simpler approach: run separate short trials at each timestamp
async function probeMethodAtTime(methodId, durationMs) {
  const arm = BASELINES[methodId];
  if (!arm) return null;

  const sdlK = arm.sdl_k ?? 0;
  const coalesceK = arm.coalesce_k ?? 1;
  const proactiveBaseline = arm.proactive_baseline ?? "B0";
  const needsProactive = arm.ready_aware && proactiveBaseline !== "B0";

  const { outFile } = await buildAblationHtml({
    assetUrl: SCENE_URL,
    pixelRatio: "1.0",
    ablationMode: "normal",
    proactiveBaselineCode: needsProactive ? proactiveBaseline : null,
  });

  const pathOverrides = new Map([["/index.html", outFile]]);
  const { server, port, base } = await startPageStaticServer(0, pathOverrides);

  let browser;
  let q = null;
  try {
    browser = await chromium.launch({
      headless: false,
      args: NVIDIA_CHROME_ARGS,
      ignoreDefaultArgs: ["--enable-unsafe-swiftshader"],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    await page.addInitScript((params) => {
      window.__sparkSdlK = params.sdlK;
      window.__sparkCoalesceK = params.coalesceK;
      window.__proactiveBaseline = params.proactiveBaseline;
    }, { sdlK, coalesceK, proactiveBaseline });

    const pageUrl = new URL(base);
    if (needsProactive) pageUrl.searchParams.set("VRC_PROACTIVE_BASELINE", proactiveBaseline);
    await page.goto(pageUrl.href, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__slDiagCam != null, { timeout: 30000 });

    await replayCameraTrace(page, TRACE, durationMs);
    await new Promise(r => setTimeout(r, 100));

    q = await page.evaluate(() => {
      const counts = window.__ablationReadSplatCounts?.();
      return counts?.visible_splat_count ?? counts?.rendered_splat_count ?? null;
    });

    await browser.close();
    browser = null;
  } catch (e) {
    console.error(`ERROR ${methodId}@${durationMs}ms: ${e.message}`);
    if (browser) await browser.close().catch(() => {});
  } finally {
    server.close();
  }
  return q;
}

async function main() {
  console.log(`Probing Hobbiton loading curve (${TRACE})...`);
  console.log(`Methods: ${METHODS.join(", ")}`);
  console.log(`Sample times: ${SAMPLE_TIMES_MS.join(", ")}ms\n`);

  const results = {};
  for (const m of METHODS) results[m] = {};

  // Interleaved: for each time point, run all methods
  for (const t of SAMPLE_TIMES_MS) {
    console.log(`--- t=${t}ms ---`);
    for (const m of METHODS) {
      const q = await probeMethodAtTime(m, t);
      results[m][t] = q;
      console.log(`  ${m}: ${q != null ? Math.round(q/1000) + "K" : "null"}`);
    }
  }

  console.log("\n\n========== LOADING CURVE ==========");
  console.log("time_ms\t" + METHODS.join("\t"));
  for (const t of SAMPLE_TIMES_MS) {
    const row = METHODS.map(m => {
      const v = results[m][t];
      return v != null ? Math.round(v/1000) + "K" : "null";
    });
    console.log(`${t}\t${row.join("\t")}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
