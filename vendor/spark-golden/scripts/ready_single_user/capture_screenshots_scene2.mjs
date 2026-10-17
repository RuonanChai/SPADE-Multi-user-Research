/**
 * Capture browser screenshots for the cozy-spaceship scene (second scenario).
 * Usage: node scripts/ready_single_user/capture_screenshots_scene2.mjs --all
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
// Second scene: hobbiton on COS (direct, no proxy)
const SCENE_URL = "https://streaming-1438331348.cos.ap-guangzhou.myqcloud.com/tijerin_w6_hobbiton-lod.rad";
const SCENE_NAME = "hobbiton";

async function captureForTrace(trace, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  console.log(`\n=== Scene: ${SCENE_NAME}, Trace: ${trace} ===`);
  console.log(`Output: ${outDir}\n`);

  for (const methodId of SCREENSHOT_METHODS) {
    console.log(`  [${methodId}] starting...`);
    const arm = BASELINES[methodId];
    if (!arm) { console.log(`    SKIP: baseline ${methodId} not found`); continue; }

    const sdlK = arm.sdl_k ?? 0;
    const coalesceK = arm.coalesce_k ?? 1;
    const proactiveBaseline = arm.proactive_baseline ?? "B0";

    const { outFile } = await buildAblationHtml({
      assetUrl: SCENE_URL,
      pixelRatio: "1.0",
      ablationMode: "normal",
    });

    const pathOverrides = new Map([["/index.html", outFile]]);
    const { server, port, base } = await startPageStaticServer(0, pathOverrides);

    let browser;
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

      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__slDiagCam != null, { timeout: 30000 });
      console.log(`    Spark initialized, replaying ${trace} for ${SCREENSHOT_AT_MS}ms...`);

      await replayCameraTrace(page, trace, SCREENSHOT_AT_MS);
      await new Promise(r => setTimeout(r, 200));

      // Capture FV and q5s metrics before screenshot
      const fv = await page.evaluate(() => {
        return window.__ablationProbe?.getFirstVisibleMs?.() ?? null;
      });
      const q5s = await page.evaluate(() => {
        const counts = window.__ablationReadSplatCounts?.();
        return counts?.visible_splat_count ?? counts?.rendered_splat_count ?? null;
      });

      const screenshotPath = path.join(outDir, `${methodId}_t5s.png`);
      await page.screenshot({ path: screenshotPath, type: "png" });
      console.log(`    Screenshot: ${screenshotPath} (fv=${fv}ms, q5s=${q5s})`);

      // Save metrics
      const metaPath = path.join(outDir, `${methodId}_meta.json`);
      await fs.writeFile(metaPath, JSON.stringify({ method: methodId, trace, scene: SCENE_NAME, fv_ms: fv, q5s }));

      await browser.close();
      browser = null;
    } catch (e) {
      console.error(`    ERROR: ${e.message}`);
      if (browser) await browser.close().catch(() => {});
    } finally {
      server.close();
    }
  }
}

async function main() {
  const allFlag = process.argv.includes("--all");
  const traceArg = process.argv.find(a => a.startsWith("--trace="));

  const traces = allFlag
    ? ["burst_turn", "stop_go", "random_walk"]
    : [traceArg ? traceArg.split("=")[1] : "burst_turn"];

  const baseOut = path.join(projectRoot, "paper_materials", "ready_single_user_v1", "screenshots", SCENE_NAME);

  for (const trace of traces) {
    await captureForTrace(trace, path.join(baseOut, trace));
  }

  console.log(`\n=== All done. Screenshots in: ${baseOut} ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
