/**
 * Capture browser screenshots at t=5s for visual comparison figures.
 * Usage: node scripts/ready_single_user/capture_screenshots.mjs --trace=burst_turn
 *        node scripts/ready_single_user/capture_screenshots.mjs --all
 *
 * Runs 4 baselines (spark_od, dls, progs, sgss) on the given trace,
 * captures a screenshot at t=5000ms, saves PNGs.
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
const COS_ASSET_URL = "https://streaming-1438331348.cos.ap-guangzhou.myqcloud.com/coit-40m-sh1-lod.rad";

async function captureForTrace(trace, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  console.log(`\n=== Trace: ${trace} ===`);
  console.log(`Output: ${outDir}\n`);

  for (const methodId of SCREENSHOT_METHODS) {
    console.log(`  [${methodId}] starting...`);
    const arm = BASELINES[methodId];
    if (!arm) { console.log(`    SKIP: baseline ${methodId} not found`); continue; }

    const sdlK = arm.sdl_k ?? 0;
    const coalesceK = arm.coalesce_k ?? 1;
    const proactiveBaseline = arm.proactive_baseline ?? "B0";

    // Build HTML page (writes to cache, returns {outFile, localRadUrl})
    const { outFile } = await buildAblationHtml({
      assetUrl: COS_ASSET_URL,
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

      // Inject SDL/coalesce/proactive config
      await page.addInitScript((params) => {
        window.__sparkSdlK = params.sdlK;
        window.__sparkCoalesceK = params.coalesceK;
        window.__proactiveBaseline = params.proactiveBaseline;
      }, { sdlK, coalesceK, proactiveBaseline });

      await page.goto(base, { waitUntil: "domcontentloaded" });

      // Wait for Spark init
      await page.waitForFunction(() => window.__slDiagCam != null, { timeout: 30000 });
      console.log(`    Spark initialized, replaying trace for ${SCREENSHOT_AT_MS}ms...`);

      // Replay camera trace for exactly 5s
      await replayCameraTrace(page, trace, SCREENSHOT_AT_MS);

      // Small settle delay for GPU upload
      await new Promise(r => setTimeout(r, 200));

      // Capture screenshot
      const screenshotPath = path.join(outDir, `${methodId}_t5s.png`);
      await page.screenshot({ path: screenshotPath, type: "png" });
      console.log(`    Screenshot: ${screenshotPath}`);

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

  const baseOut = path.join(projectRoot, "paper_materials", "ready_single_user_v1", "screenshots");

  for (const trace of traces) {
    await captureForTrace(trace, path.join(baseOut, trace));
  }

  console.log(`\n=== All done. Screenshots in: ${baseOut} ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
