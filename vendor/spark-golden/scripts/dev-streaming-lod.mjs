/**
 * Vite page (9200) + MonitoredAssetServer .rad (9210) for streaming-lod local dev.
 * Same Range/instrumentation stack as 24h local_loopback trials.
 *
 * Vite binds 0.0.0.0 so Worker2 can open http://<controller>:9200/ (see distributed_lab.json).
 * Override: VITE_DEV_HOST=127.0.0.1 npm run dev:streaming-lod
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;

let controllerHost = "10.4.158.143";
try {
  const lab = JSON.parse(
    fs.readFileSync(path.join(root, "vrc-paper/experiments/distributed_lab.json"), "utf8"),
  );
  controllerHost = lab.controller_host || controllerHost;
} catch {
  /* optional */
}

const viteHost = process.env.VITE_DEV_HOST || "0.0.0.0";
const vitePort = process.env.VITE_DEV_PORT || "9200";

function run(label, args, extraEnv = {}) {
  const child = spawn(node, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  child.on("exit", (code) => {
    if (code && code !== 0) console.error(`[${label}] exited ${code}`);
  });
  return child;
}

const radPort = process.env.RAD_DEV_PORT || "9210";
const rad = run("rad-monitored", ["scripts/serve-rad-monitored-dev.mjs"], {
  RAD_DEV_PORT: radPort,
});
const vite = run("vite", [
  "node_modules/vite/bin/vite.js",
  "--port",
  vitePort,
  "--host",
  viteHost,
  "--strictPort",
]);


function shutdown() {
  rad.kill("SIGTERM");
  vite.kill("SIGTERM");
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("\n[dev-streaming-lod] Open (local):");
console.log(
  `  http://localhost:${vitePort}/examples/streaming-lod/index.html?world=Coit+Tower%2C+SF`,
);
if (viteHost !== "127.0.0.1" && viteHost !== "localhost") {
  console.log("[dev-streaming-lod] Worker2 / LAN (after firewall allows inbound TCP 9200):");
  console.log(
    `  http://${controllerHost}:${vitePort}/examples/streaming-lod/index.html?world=Coit+Tower%2C+SF`,
  );
}
console.log(`[dev-streaming-lod] .rad via MonitoredAssetServer http://127.0.0.1:${radPort}/`);
console.log("[dev-streaming-lod] logs under .diag-cache/dev-rad-monitor/<session>/server_monitor/\n");
