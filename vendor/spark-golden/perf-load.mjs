// perf-load.mjs — node perf-load.mjs [users] [url]
import { chromium } from "playwright";
const N = parseInt(process.argv[2] || "1");
const URL = process.argv[3] || "http://localhost:8080/examples/hello-world/";
const TIMEOUT = 30000;

async function runOne(i) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setExtraHTTPHeaders({ "Cache-Control": "no-cache, no-store", "Pragma": "no-cache" });
  const bustURL = URL + (URL.includes("?") ? "&" : "?") + `_cb=${Date.now()}_${i}`;
  const t0 = Date.now();
  try {
    await page.goto(bustURL, { waitUntil: "load", timeout: TIMEOUT });
    const marks = await page.evaluate(() =>
      new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("timeout waiting for interactive-ready")), 25000);
        const check = () => {
          // Read _marks directly — these are already _t0-relative on the main-thread clock
          if (window._marks?.["interactive-ready"] != null) {
            clearTimeout(deadline);
            // Wait up to 2000ms for first-spz-first-byte to arrive (worker _perf is async)
            const pollByte = (tries) => {
              if (window._marks["first-spz-first-byte"] != null || tries <= 0) {
                setTimeout(() => resolve({ ...window._marks }), 0);
              } else {
                setTimeout(() => pollByte(tries - 1), 100);
              }
            };
            pollByte(40);
          } else {
            setTimeout(check, 200);
          }
        };
        check();
      })
    );

    const wi  = marks["worker-init-start"] != null && marks["worker-init-end"] != null
      ? (marks["worker-init-end"] - marks["worker-init-start"]).toFixed(0) : "INVALID";
    const fbg = marks["first-spz-request"] != null && marks["first-spz-first-byte"] != null
      ? (marks["first-spz-first-byte"] - marks["first-spz-request"]).toFixed(0) : "INVALID";
    const ffg = marks["first-spz-first-byte"] != null && marks["first-nonempty-frame"] != null
      ? (marks["first-nonempty-frame"] - marks["first-spz-first-byte"]).toFixed(0) : "INVALID";
    const rg  = marks["first-nonempty-frame"] != null && marks["interactive-ready"] != null
      ? (marks["interactive-ready"] - marks["first-nonempty-frame"]).toFixed(0) : "INVALID";
    const wall = Date.now() - t0;
    return { user: i, worker_init: wi, first_byte_gap: fbg, first_frame_gap: ffg, ready_gap: rg, wall_ms: wall };
  } catch (e) {
    return { user: i, error: e.message };
  } finally {
    await browser.close();
  }
}

const results = await Promise.all(Array.from({ length: N }, (_, i) => runOne(i)));
console.table(results);
