/**
 * Quick local preview: static page + MonitoredAssetServer for any .rad under repo root.
 *
 *   node scripts/preview-local-rad.mjs paper_materials/cozy-spaceship_2-lod.rad
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MonitoredAssetServer, probeMonitoredServer } from "./lib/local_stutter_asset_server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const radRel = (process.argv[2] || "paper_materials/cozy-spaceship_2-lod.rad").replace(/\\/g, "/");
const radAbs = path.join(root, radRel);
const worldName = process.argv[3] || "Cozy Spaceship";

if (!existsSync(radAbs)) {
  console.error(`[preview-local-rad] missing file: ${radAbs}`);
  process.exit(1);
}

const pagePort = Number.parseInt(process.env.PREVIEW_PAGE_PORT || "8764", 10);
const radPort = Number.parseInt(process.env.PREVIEW_RAD_PORT || "8765", 10);
const cacheDir = path.join(root, ".diag-cache", "preview-local-rad");

await fs.mkdir(cacheDir, { recursive: true });

let html = await fs.readFile(path.join(root, "examples/streaming-lod/index.html"), "utf8");
html = html.replace(
  'url: "https://storage.googleapis.com/forge-dev-public/asundqui/rad/260217/cozy-spaceship_2-lod.rad"',
  `url: localRadUrl(${JSON.stringify(radRel)})`,
);
html = html.replace(
  /const defaultWorldKey = worldKeyParam && worlds\[worldKeyParam\] \? worldKeyParam : "[^"]+";/,
  `const defaultWorldKey = worldKeyParam && worlds[worldKeyParam] ? worldKeyParam : ${JSON.stringify(worldName)};`,
);
html = html.replace(
  /const port = uParams\.get\("rad_port"\) \|\| "9210";/,
  `const port = uParams.get("rad_port") || "${radPort}";`,
);
html = html.replace(
  '"three": "../js/vendor/three/build/three.module.js"',
  '"three": "/node_modules/three/build/three.module.js"',
);
html = html.replace(
  '"lil-gui": "/examples/js/vendor/lil-gui/dist/lil-gui.esm.js"',
  '"lil-gui": "/node_modules/lil-gui/dist/lil-gui.esm.js"',
);

const patchedHtml = path.join(cacheDir, "index.html");
await fs.writeFile(patchedHtml, html);

const assetSrv = new MonitoredAssetServer({
  rootDir: root,
  host: "127.0.0.1",
  port: radPort,
  runDir: cacheDir,
  runId: "preview",
});
const radInfo = await assetSrv.start();
await probeMonitoredServer(radInfo.base);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const pageServer = createServer((req, res) => {
  try {
    const u = new URL(req.url || "/", `http://127.0.0.1:${pagePort}`);
    let p = decodeURIComponent(u.pathname);
    if (p === "/") p = "/examples/streaming-lod/index.html";
    let disk;
    if (p === "/examples/streaming-lod/index.html") disk = patchedHtml;
    else {
      const rel = p.replace(/^\//, "");
      if (p.startsWith("/examples/") || p.startsWith("/dist/") || p.startsWith("/node_modules/")) {
        disk = path.join(root, rel);
      }
    }
    if (!disk || !existsSync(disk) || !statSync(disk).isFile()) {
      res.writeHead(404);
      res.end("404 " + p);
      return;
    }
    res.setHeader("Content-Type", mime[path.extname(disk).toLowerCase()] || "application/octet-stream");
    res.writeHead(200);
    res.end(readFileSync(disk));
  } catch (e) {
    res.writeHead(500);
    res.end(String(e?.message || e));
  }
});

await new Promise((resolve, reject) => {
  pageServer.once("error", reject);
  pageServer.listen(pagePort, "127.0.0.1", resolve);
});

const pageUrl = `http://127.0.0.1:${pagePort}/examples/streaming-lod/index.html?world=${encodeURIComponent(worldName)}&rad_port=${radPort}`;
console.log(`[preview-local-rad] RAD  ${radInfo.base}/${radRel}`);
console.log(`[preview-local-rad] Page ${pageUrl}`);
console.log("[preview-local-rad] Ctrl+C to stop");

spawn("cmd.exe", ["/c", "start", "", pageUrl], { detached: true, stdio: "ignore" }).unref();

async function shutdown() {
  console.log("[preview-local-rad] stopping…");
  pageServer.close();
  await assetSrv.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
