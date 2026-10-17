/**
 * Quick Hobbiton FV + t1m probe. n=3 interleaved, 15s per trial.
 * Usage: node scripts/ready_single_user/probe_hobbiton_fv_t1m.mjs
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
const TRACES = ["burst_turn", "stop_go", "random_walk"];
const N_TRIALS = 3;
const RUN_MS = 15000;

async function runOne(methodId, trace) {
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
  const { server, base } = await startPageStaticServer(0, pathOverrides);
  let browser;
  let result = { fv: null, t1m: null, q5s: null };

  try {
    browser = await chromium.launch({
      headless: false,
      args: NVIDIA_CHROME_ARGS,
      ignoreDefaultArgs: ["--enable-unsafe-swiftshader"],
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
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

    // Start startup monitor + timeline sampler
    await page.evaluate(() => {
      window.__ablationStartStartupMonitor?.();
      window.__t1mMs = null;
      window.__timelineT0 = performance.now();
      window.__splatTimeline = [];
      const iv = setInterval(() => {
        const counts = window.__ablationReadSplatCounts?.();
        const vis = counts?.visible_splat_count ?? counts?.rendered_splat_count ?? 0;
        const elapsed = performance.now() - window.__timelineT0;
        window.__splatTimeline.push({ t: Math.round(elapsed), vis });
        if (vis >= 1000000 && window.__t1mMs == null) {
          window.__t1mMs = Math.round(elapsed);
        }
      }, 250);
      window.__tlInterval = iv;
    });

    // Run trace for 15s
    await replayCameraTrace(page, trace, RUN_MS);
    await new Promise(r => setTimeout(r, 200));

    // Collect
    const data = await page.evaluate(() => {
      clearInterval(window.__tlInterval);
      const startup = window.__ablationGetStartupSnapshot?.() ?? {};
      const counts = window.__ablationReadSplatCounts?.();
      const vis = counts?.visible_splat_count ?? counts?.rendered_splat_count ?? 0;
      // Find q5s from timeline
      const tl = window.__splatTimeline || [];
      let q5s = 0;
      for (const s of tl) { if (s.t <= 5000 && s.vis > q5s) q5s = s.vis; }
      return {
        fv: startup.first_visible_splat_ms ?? null,
        t1m: window.__t1mMs ?? null,
        q5s,
        vis_final: vis,
      };
    });
    result = data;

    await browser.close();
    browser = null;
  } catch (e) {
    console.error(`    ERR ${methodId}/${trace}: ${e.message}`);
    if (browser) await browser.close().catch(() => {});
  } finally {
    server.close();
  }
  return result;
}

function median(arr) {
  const s = arr.filter(x => x != null).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.floor(s.length / 2)];
}

async function main() {
  const all = {};

  for (const trace of TRACES) {
    all[trace] = {};
    for (const m of METHODS) all[trace][m] = { fv: [], t1m: [], q5s: [] };

    for (let t = 0; t < N_TRIALS; t++) {
      console.log(`--- ${trace} trial ${t} ---`);
      for (const m of METHODS) {
        const r = await runOne(m, trace);
        all[trace][m].fv.push(r?.fv);
        all[trace][m].t1m.push(r?.t1m);
        all[trace][m].q5s.push(r?.q5s);
        console.log(`  ${m}: fv=${r?.fv}ms, q5s=${r?.q5s ? Math.round(r.q5s/1000)+"K" : "null"}, t1m=${r?.t1m}ms`);
      }
    }
  }

  // Summary
  console.log("\n\n========== HOBBITON FV / q5s / t1m SUMMARY (median of n=3) ==========");
  for (const trace of TRACES) {
    console.log(`\n${trace}:`);
    console.log("  method\t\tfv(ms)\tq5s(K)\tt1m(ms)");
    for (const m of METHODS) {
      const d = all[trace][m];
      const fvM = median(d.fv);
      const q5sM = median(d.q5s);
      const t1mM = median(d.t1m);
      console.log(`  ${m}\t\t${fvM ?? "null"}\t${q5sM ? Math.round(q5sM/1000) : "-"}\t${t1mM ?? ">15s"}`);
    }
    console.log(`  raw fv: ${JSON.stringify(Object.fromEntries(METHODS.map(m => [m, all[trace][m].fv])))}`);
    console.log(`  raw t1m: ${JSON.stringify(Object.fromEntries(METHODS.map(m => [m, all[trace][m].t1m])))}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
