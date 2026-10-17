/**
 * Legacy thin Range server (no per-request JSONL). Prefer npm run dev:streaming-lod
 * which uses MonitoredAssetServer via scripts/serve-rad-monitored-dev.mjs on 9210.
 *
 *   node scripts/serve-rad-dev.mjs
 * Default: http://127.0.0.1:9210/
 */
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveFileWithRange } from "./lib/serve_rad_range.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.RAD_DEV_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.RAD_DEV_PORT || "9210", 10);

const server = createServer((req, res) => {
  const u = new URL(req.url || "/", `http://${host}:${port}`);
  let pathname = decodeURIComponent(u.pathname);
  if (pathname.includes("..")) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  const diskPath = path.join(rootDir, pathname.replace(/^\//, "").replace(/\//g, path.sep));
  if (!diskPath.startsWith(rootDir)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  serveFileWithRange(req, res, diskPath);
});

server.listen(port, host, () => {
  console.log(`[serve-rad-dev] http://${host}:${port}/  (root: ${rootDir})`);
  console.log(
    `[serve-rad-dev] Coit: http://${host}:${port}/examples/streaming-lod/coit-40m-sh1-lod.rad`,
  );
});
