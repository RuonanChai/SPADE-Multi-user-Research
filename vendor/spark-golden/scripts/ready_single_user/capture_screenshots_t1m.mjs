/**
 * Capture browser screenshots at t=t1m (time-to-1M) for second visual comparison.
 * Uses Coit Tower on COS (direct, no proxy).
 * Records both FV and visible splat count at screenshot time.
 *
 * Usage: node scripts/ready_single_user/capture_screenshots_t1m.mjs --all
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
// Screenshot at t=11s (around t1m for Spark-OD on burst_turn)
const SCREENSHOT_AT_MS = 11000;
const COS_ASSET_URL = "https://streaming-1438331348.cos.ap-guangzhou.myqcloud.com/coit-40m-sh1-lod.rad";

async function captureForTrace(trace, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  console.log(`\n=== Trace: ${trace}, screenshot at t=${SCREENSHOT_AT_MS}ms ===`);
  console.log(`Output: ${outDir}\n`);

  for (const methodId of SCREENSHOT_METHODS) {
    console.log(`  [${methodId}] starting...`);
    const arm = BASELINES[methodId];
    if (!arm) { console.log(`    SKIP: baseline ${methodId} not found`); continue; }

    const sdlK = arm.sdl_k ?? 0;
    const coalesceK = arm.coalesce_k ?? 1;
    const proactiveBaseline = arm.proactive_baseline ?? "B0";

    const { outFile } = await buildAblationHtml({
      assetUrl: COS_ASSET_URL,
      pixelRatio: "1.0",
      ablationMode: "fetch_only_full",
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

      // Collect metrics
      const metrics = await page.evaluate(() => {
        const probe = window.__ablationProbe;
        const diag = window.__slDiag;
        return {
          visible_splats: diag?.visibleSplatCount ?? 0,
          fv_ms: probe?.firstVisibleMs ?? null,
        };
      });

      const screenshotPath = path.join(outDir, `${methodId}_t${SCREENSHOT_AT_MS/1000}s.png`);
      await page.screenshot({ path: screenshotPath, type: "png" });

      // Save metrics
      const metaPath = path.join(outDir, `${methodId}_meta.json`);
      await fs.writeFile(metaPath, JSON.stringify({
        method: methodId, trace,
        screenshot_time_ms: SCREENSHOT_AT_MS,
        visible_splats: metrics.visible_splats,
        fv_ms: metrics.fv_ms,
      }, null, 2));

      console.log(`    Screenshot: ${screenshotPath} (visible=${metrics.visible_splats}, fv=${metrics.fv_ms}ms)`);

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

  const baseOut = path.join(projectRoot, "paper_materials", "ready_single_user_v1", "screenshots", "coit_t1m");

  for (const trace of traces) {
    await captureForTrace(trace, path.join(baseOut, trace));
  }

  console.log(`\n=== All done. Screenshots in: ${baseOut} ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
