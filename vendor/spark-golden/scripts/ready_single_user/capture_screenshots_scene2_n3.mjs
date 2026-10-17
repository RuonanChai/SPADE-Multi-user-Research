/**
 * Capture browser screenshots for Hobbiton scene with n=3 interleaved trials.
 * Interleaved = round-robin across baselines within each trial index.
 * Usage: node scripts/ready_single_user/capture_screenshots_scene2_n3.mjs --all
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

const SCREENSHOT_METHODS = ["spark_od", "dls", "progs", "sgss"];
const SCREENSHOT_AT_MS = 5000;
const SCENE_URL = "https://streaming-1438331348.cos.ap-guangzhou.myqcloud.com/tijerin_w6_hobbiton-lod.rad";
const SCENE_NAME = "hobbiton";
const N_TRIALS = 3;

async function runOneTrial(methodId, trace, trialIdx, outDir) {
  const arm = BASELINES[methodId];
  if (!arm) { console.log(`    SKIP: baseline ${methodId} not found`); return null; }

  const sdlK = arm.sdl_k ?? 0;
  const coalesceK = arm.coalesce_k ?? 1;
  const proactiveBaseline = arm.proactive_baseline ?? "B0";

  // Only inject proactive prefetch code for baselines that need it (PRoGS, SGSS)
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
  let q5s = null;
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

    // Build URL with proactive baseline param so proactive_chunk_probe.js picks it up
    const pageUrl = new URL(base);
    if (needsProactive) {
      pageUrl.searchParams.set("VRC_PROACTIVE_BASELINE", proactiveBaseline);
    }
    await page.goto(pageUrl.href, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__slDiagCam != null, { timeout: 30000 });

    await replayCameraTrace(page, trace, SCREENSHOT_AT_MS);
    await new Promise(r => setTimeout(r, 200));

    // Read q5s
    q5s = await page.evaluate(() => {
      const counts = window.__ablationReadSplatCounts?.();
      return counts?.visible_splat_count ?? counts?.rendered_splat_count ?? null;
    });

    // Save screenshot for median trial (will be overwritten; keep last for visual)
    const screenshotPath = path.join(outDir, `${methodId}_t${trialIdx}_t5s.png`);
    await page.screenshot({ path: screenshotPath, type: "png" });

    console.log(`    [t${trialIdx}] ${methodId}: q5s=${q5s}`);

    await browser.close();
    browser = null;
  } catch (e) {
    console.error(`    ERROR [t${trialIdx}] ${methodId}: ${e.message}`);
    if (browser) await browser.close().catch(() => {});
  } finally {
    server.close();
  }
  return q5s;
}

function median(arr) {
  const sorted = [...arr].filter(x => x != null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

async function captureForTrace(trace, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  console.log(`\n=== Scene: ${SCENE_NAME}, Trace: ${trace}, n=${N_TRIALS} interleaved ===`);
  console.log(`Output: ${outDir}\n`);

  // Collect q5s per method across trials
  const results = {};
  for (const m of SCREENSHOT_METHODS) results[m] = [];

  // Interleaved: for each trial index, run all methods in order
  for (let t = 0; t < N_TRIALS; t++) {
    console.log(`  --- Trial ${t} ---`);
    for (const methodId of SCREENSHOT_METHODS) {
      const q5s = await runOneTrial(methodId, trace, t, outDir);
      results[methodId].push(q5s);
    }
  }

  // Compute medians and find median trial for screenshot selection
  console.log(`\n  Results for ${trace}:`);
  const medians = {};
  for (const methodId of SCREENSHOT_METHODS) {
    const med = median(results[methodId]);
    medians[methodId] = med;
    console.log(`    ${methodId}: trials=${JSON.stringify(results[methodId])}, median=${med}`);
  }

  // Save median meta JSON and copy median-trial screenshot as the canonical one
  for (const methodId of SCREENSHOT_METHODS) {
    const metaPath = path.join(outDir, `${methodId}_meta.json`);
    await fs.writeFile(metaPath, JSON.stringify({
      method: methodId,
      trace,
      scene: SCENE_NAME,
      q5s: medians[methodId],
      trials: results[methodId],
      n: N_TRIALS,
    }));

    // Copy the trial closest to median as the canonical screenshot
    const trials = results[methodId].filter(x => x != null);
    if (trials.length > 0) {
      const med = medians[methodId];
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < N_TRIALS; i++) {
        if (results[methodId][i] != null) {
          const dist = Math.abs(results[methodId][i] - med);
          if (dist < bestDist) { bestDist = dist; bestIdx = i; }
        }
      }
      const srcPath = path.join(outDir, `${methodId}_t${bestIdx}_t5s.png`);
      const dstPath = path.join(outDir, `${methodId}_t5s.png`);
      try {
        await fs.copyFile(srcPath, dstPath);
      } catch { /* keep existing */ }
    }
  }

  return { trace, medians, results };
}

async function main() {
  const allFlag = process.argv.includes("--all");
  const traceArg = process.argv.find(a => a.startsWith("--trace="));

  const traces = allFlag
    ? ["burst_turn", "stop_go", "random_walk"]
    : [traceArg ? traceArg.split("=")[1] : "burst_turn"];

  const baseOut = path.join(projectRoot, "paper_materials", "ready_single_user_v1", "screenshots", SCENE_NAME);

  const allResults = [];
  for (const trace of traces) {
    const r = await captureForTrace(trace, path.join(baseOut, trace));
    allResults.push(r);
  }

  // Summary
  console.log("\n\n========== SUMMARY ==========");
  for (const r of allResults) {
    console.log(`\n${r.trace}:`);
    for (const m of SCREENSHOT_METHODS) {
      console.log(`  ${m}: median=${r.medians[m]}, trials=${JSON.stringify(r.results[m])}`);
    }
  }
  console.log(`\n=== All done. Screenshots in: ${baseOut} ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
