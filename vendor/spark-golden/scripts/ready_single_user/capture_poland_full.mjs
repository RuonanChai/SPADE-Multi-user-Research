/**
 * Poland scene (100M splats): comprehensive measurement for DLS paper.
 * Captures FV, q5s (at multiple timestamps), and t1m in one pass.
 * n=3 interleaved trials per trace.
 * Usage: node scripts/ready_single_user/capture_poland_full.mjs --all
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
const SCENE_URL = "https://streaming-1438331348.cos.ap-guangzhou.myqcloud.com/poland-lod.rad";
const SCENE_NAME = "poland";
const N_TRIALS = 3;
const RUN_DURATION_MS = 20000; // 20s to capture t1m
const SCREENSHOT_AT_MS = 5000;

async function runOneTrial(methodId, trace, trialIdx, outDir) {
  const arm = BASELINES[methodId];
  if (!arm) { console.log(`    SKIP: ${methodId} not found`); return null; }

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
  let result = { method: methodId, trace, trial: trialIdx, fv_ms: null, q5s: null, t1m_ms: null, q3s: null };
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

    // Start the startup monitor for FV tracking
    await page.evaluate(() => {
      window.__ablationStartStartupMonitor?.();
      // Also set up a timeline sampler
      window.__splatTimeline = [];
      window.__timelineT0 = performance.now();
      window.__t1mMs = null;
      const sampleInterval = setInterval(() => {
        const counts = window.__ablationReadSplatCounts?.();
        const vis = counts?.visible_splat_count ?? counts?.rendered_splat_count ?? 0;
        const elapsed = performance.now() - window.__timelineT0;
        window.__splatTimeline.push({ t: Math.round(elapsed), vis });
        if (vis >= 1000000 && window.__t1mMs == null) {
          window.__t1mMs = Math.round(elapsed);
        }
      }, 500);
      window.__timelineSampleInterval = sampleInterval;
    });

    // Take screenshot at t=5s, but run trace for full duration
    // First run to 5s for screenshot
    await replayCameraTrace(page, trace, SCREENSHOT_AT_MS);
    await new Promise(r => setTimeout(r, 100));

    // Capture q5s and screenshot
    const q5s = await page.evaluate(() => {
      const counts = window.__ablationReadSplatCounts?.();
      return counts?.visible_splat_count ?? counts?.rendered_splat_count ?? null;
    });
    result.q5s = q5s;

    // Screenshot at t=5s
    const screenshotPath = path.join(outDir, `${methodId}_t${trialIdx}_t5s.png`);
    await page.screenshot({ path: screenshotPath, type: "png" });

    // Continue running to capture t1m (additional 15s)
    const remainingMs = RUN_DURATION_MS - SCREENSHOT_AT_MS;
    if (remainingMs > 0) {
      await replayCameraTrace(page, trace, remainingMs);
      await new Promise(r => setTimeout(r, 100));
    }

    // Collect all metrics
    const metrics = await page.evaluate(() => {
      clearInterval(window.__timelineSampleInterval);
      const startup = window.__ablationGetStartupSnapshot?.() ?? {};
      const counts = window.__ablationReadSplatCounts?.();
      const vis20s = counts?.visible_splat_count ?? counts?.rendered_splat_count ?? 0;
      // Find q at 3s from timeline
      const tl = window.__splatTimeline || [];
      let q3s = 0;
      for (const s of tl) {
        if (s.t <= 3000) q3s = s.vis;
      }
      return {
        fv_ms: startup.first_visible_splat_ms ?? null,
        t1m_ms: window.__t1mMs ?? null,
        q3s,
        vis_at_20s: vis20s,
        timeline: tl,
      };
    });

    result.fv_ms = metrics.fv_ms;
    result.t1m_ms = metrics.t1m_ms;
    result.q3s = metrics.q3s;
    result.vis_at_20s = metrics.vis_at_20s;

    console.log(`    [t${trialIdx}] ${methodId}: fv=${result.fv_ms}ms, q5s=${q5s ? Math.round(q5s/1000)+"K" : "null"}, t1m=${result.t1m_ms}ms, q3s=${result.q3s ? Math.round(result.q3s/1000)+"K" : "0"}`);

    await browser.close();
    browser = null;
  } catch (e) {
    console.error(`    ERROR [t${trialIdx}] ${methodId}: ${e.message}`);
    if (browser) await browser.close().catch(() => {});
  } finally {
    server.close();
  }
  return result;
}

function median(arr) {
  const sorted = [...arr].filter(x => x != null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

async function runTrace(trace, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  console.log(`\n=== Poland (100M), Trace: ${trace}, n=${N_TRIALS} interleaved ===\n`);

  const allResults = {};
  for (const m of METHODS) allResults[m] = [];

  for (let t = 0; t < N_TRIALS; t++) {
    console.log(`  --- Trial ${t} ---`);
    for (const m of METHODS) {
      const r = await runOneTrial(m, trace, t, outDir);
      allResults[m].push(r);
    }
  }

  // Compute medians
  const summary = {};
  for (const m of METHODS) {
    const fvs = allResults[m].map(r => r?.fv_ms);
    const q5ss = allResults[m].map(r => r?.q5s);
    const t1ms = allResults[m].map(r => r?.t1m_ms);
    const q3ss = allResults[m].map(r => r?.q3s);
    summary[m] = {
      fv_median: median(fvs),
      q5s_median: median(q5ss),
      t1m_median: median(t1ms),
      q3s_median: median(q3ss),
      fv_trials: fvs,
      q5s_trials: q5ss,
      t1m_trials: t1ms,
    };
  }

  // Save summary
  const metaPath = path.join(outDir, `summary_n${N_TRIALS}.json`);
  await fs.writeFile(metaPath, JSON.stringify({ trace, scene: SCENE_NAME, n: N_TRIALS, summary, raw: allResults }, null, 2));

  // Copy median-trial screenshot as canonical
  for (const m of METHODS) {
    const q5sTrials = allResults[m].map(r => r?.q5s).filter(x => x != null);
    if (q5sTrials.length > 0) {
      const med = summary[m].q5s_median;
      let bestIdx = 0, bestDist = Infinity;
      for (let i = 0; i < N_TRIALS; i++) {
        const v = allResults[m][i]?.q5s;
        if (v != null && Math.abs(v - med) < bestDist) { bestDist = Math.abs(v - med); bestIdx = i; }
      }
      const src = path.join(outDir, `${m}_t${bestIdx}_t5s.png`);
      const dst = path.join(outDir, `${m}_t5s.png`);
      try { await fs.copyFile(src, dst); } catch {}
    }
    // Also save per-method meta
    const mMeta = path.join(outDir, `${m}_meta.json`);
    await fs.writeFile(mMeta, JSON.stringify({ method: m, trace, scene: SCENE_NAME, ...summary[m], n: N_TRIALS }));
  }

  return { trace, summary };
}

async function main() {
  const allFlag = process.argv.includes("--all");
  const traceArg = process.argv.find(a => a.startsWith("--trace="));
  const traces = allFlag
    ? ["burst_turn", "stop_go", "random_walk"]
    : [traceArg ? traceArg.split("=")[1] : "burst_turn"];

  const baseOut = path.join(projectRoot, "paper_materials", "ready_single_user_v1", "screenshots", SCENE_NAME);
  const allSummaries = [];

  for (const trace of traces) {
    const r = await runTrace(trace, path.join(baseOut, trace));
    allSummaries.push(r);
  }

  // Final summary
  console.log("\n\n========== POLAND FULL SUMMARY ==========");
  for (const { trace, summary } of allSummaries) {
    console.log(`\n${trace}:`);
    console.log("  method\t\tfv(ms)\tq3s(K)\tq5s(K)\tt1m(ms)");
    for (const m of METHODS) {
      const s = summary[m];
      console.log(`  ${m}\t\t${s.fv_median}\t${s.q3s_median ? Math.round(s.q3s_median/1000) : "-"}\t${s.q5s_median ? Math.round(s.q5s_median/1000) : "-"}\t${s.t1m_median ?? ">20s"}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
