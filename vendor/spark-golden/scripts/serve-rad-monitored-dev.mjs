/**
 * Dev .rad server on 9210 using MonitoredAssetServer (same Range stack as 24h/ablation).
 * Logs: .diag-cache/dev-rad-monitor/<session>/server_monitor/
 *
 *   node scripts/serve-rad-monitored-dev.mjs
 *   RAD_DEV_PORT=9210 node scripts/serve-rad-monitored-dev.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MonitoredAssetServer, probeMonitoredServer } from "./lib/local_stutter_asset_server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.RAD_DEV_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.RAD_DEV_PORT || "9210", 10);
const sessionId = process.env.RAD_DEV_SESSION || `dev_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
const runDir = path.join(root, ".diag-cache", "dev-rad-monitor", sessionId);

await fs.mkdir(runDir, { recursive: true });

const assetSrv = new MonitoredAssetServer({
  rootDir: root,
  host,
  port,
  runDir,
  runId: sessionId,
});

let info;
try {
  info = await assetSrv.start();
  await probeMonitoredServer(info.base);
} catch (e) {
  console.error(`[serve-rad-monitored-dev] failed to bind ${host}:${port}:`, e?.message || e);
  console.error("[serve-rad-monitored-dev] Stop other process on this port (old serve-rad-dev / stale MonitoredAssetServer / 24h trial).");
  process.exit(1);
}

console.log(`[serve-rad-monitored-dev] MonitoredAssetServer ${info.base}`);
console.log(`[serve-rad-monitored-dev] Coit: ${info.base}/examples/streaming-lod/coit-40m-sh1-lod.rad`);
console.log(`[serve-rad-monitored-dev] logs: ${assetSrv.monitorDir}`);

async function shutdown() {
  console.log("[serve-rad-monitored-dev] stopping…");
  await assetSrv.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
