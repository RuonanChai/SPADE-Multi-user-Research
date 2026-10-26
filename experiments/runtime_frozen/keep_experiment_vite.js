"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = __dirname;
const SPARK = "D:/Program/SPADE/NSDI_SPADE_DIAG_W04/spark";
const RUNTIME = path.join(ROOT, "..", "runtime");
const CACHE = path.join(RUNTIME, "persistent-vite-cache");
const STAGE = path.join(RUNTIME, "persistent_vite_stages.jsonl");
const LOG = path.join(RUNTIME, "persistent_vite.log");

function clockReady() {
  return new Promise((resolve) => {
    const req = http.get("http://127.0.0.1:18080/clock", (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(res.statusCode === 200 && Number.isFinite(JSON.parse(body).date_ms)); }
        catch (_) { resolve(false); }
      });
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

function startVite() {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.mkdirSync(path.dirname(STAGE), { recursive: true });
  const out = fs.openSync(LOG, "a");
  const child = spawn(process.execPath, [
    path.join(SPARK, "node_modules", "vite", "bin", "vite.js"),
    "--config", path.join(ROOT, "vite.g1.config.js"),
    "--port", "18080", "--host", "0.0.0.0", "--strictPort",
  ], {
    cwd: SPARK,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      G1_STAGE_LOG: STAGE,
      G1_VITE_CACHE: CACHE,
    },
  });
  child.unref();
  fs.appendFileSync(LOG, `[${new Date().toISOString()}] started pid=${child.pid}\n`);
}

async function main() {
  while (true) {
    try {
      if (!(await clockReady())) startVite();
    } catch (error) {
      fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${error.stack || error.message}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

main();
