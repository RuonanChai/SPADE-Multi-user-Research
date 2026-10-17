import { chromium } from "playwright";

const HEADLESS = process.env.VRC_HEADLESS === "true";

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
];

const browser = await chromium.launch({ headless: HEADLESS, args: CHROME_FLAGS });
const page = await browser.newPage();
await page.setContent(
  `<canvas id=c width=8 height=8></canvas><script>
    const gl = document.getElementById('c').getContext('webgl2') || document.getElementById('c').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    window.__webgl_renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : (gl ? gl.getParameter(gl.RENDERER) : '');
    window.__webgl_vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : (gl ? gl.getParameter(gl.VENDOR) : '');
    window.__webgl_version = gl ? gl.getParameter(gl.VERSION) : '';
  </script>`,
);
await page.waitForFunction(() => window.__webgl_renderer !== undefined, undefined, { timeout: 15000 });
const info = await page.evaluate(() => ({
  renderer: window.__webgl_renderer,
  vendor: window.__webgl_vendor,
  version: window.__webgl_version,
}));
await browser.close();

const ok = /nvidia|geforce|rtx/i.test(`${info.vendor} ${info.renderer}`);
console.log(JSON.stringify({ headless: HEADLESS, ok, ...info }, null, 2));
process.exit(ok ? 0 : 1);
