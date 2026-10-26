"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function originServer() {
  return http.createServer((req, res) => {
    const body = Buffer.from(`bytes-${req.headers.range || "all"}`);
    res.writeHead(206, {
      ETag: "\"c63451f94630f45659334d7d1ea5d20b-153\"",
      "Content-Range": `bytes 0-${body.length - 1}/1280517688`,
      "Content-Length": body.length,
      "Content-Type": "application/octet-stream",
    });
    res.end(body);
  });
}

function once(port, runId, user) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: "/coit-40m-sh1-lod.rad",
      headers: { Range: "bytes=0-15", "x-run-id": runId, "x-user-id": user },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, decision: res.headers["x-p5-origin-decision"], id: res.headers["x-p5-request-id"], body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function runMethod(method, port) {
  const evidence = path.join(__dirname, "smoke_evidence", method);
  fs.rmSync(evidence, { recursive: true, force: true });
  fs.mkdirSync(evidence, { recursive: true });
  const runId = method === "LRU"
    ? "nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_staggered_seed26101832_a3"
    : "nsdi_N2_SPADEF_coit-40m-sh1-lod_stop_go_staggered_seed26101832_a4";
  const child = spawn(process.execPath, [
    path.join(__dirname, "proxy.js"),
    "--method", method, "--port", String(port), "--origin-url", "http://127.0.0.1:18099",
    "--run-id", runId, "--evidence-dir", evidence, "--cache-max-entries", "100", "--cache-max-mb", "50", "--dls-k", "0",
  ], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const first = await once(port, runId, "C3");
  const second = await once(port, runId, "C3");
  child.kill();
  const decisions = fs.readFileSync(path.join(evidence, "proxy_decisions.jsonl"), "utf8");
  if (first.decision !== "origin_fetch" || second.decision !== "cache_hit") {
    throw new Error(`${method} expected miss then hit, got ${first.decision} ${second.decision}`);
  }
  if (!first.id || first.id === second.id) throw new Error(`${method} request ids`);
  if (!decisions.includes(first.id) || !decisions.includes("origin_response")) throw new Error(`${method} linkage`);
  return { method, first: first.decision, second: second.decision };
}

async function main() {
  const origin = originServer();
  await new Promise((resolve) => origin.listen(18099, "127.0.0.1", resolve));
  try {
    const lru = await runMethod("LRU", 18097);
    const spade = await runMethod("SPADE_F", 18098);
    console.log(JSON.stringify({ pass: true, lru, spade }));
  } finally {
    origin.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
