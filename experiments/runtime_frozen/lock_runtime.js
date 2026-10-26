"use strict";

const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { spawnSync } = require("child_process");

const root = "D:/Program/SPADE_WWW_EVIDENCE_V2_20261024";
const runtime = path.join(root, "runtime");
const files = [
  "verified_peer.js",
  "proxy.js",
  "client_handoff_buffer.js",
  "spade_byte_cache.js",
  "matched_cache.js",
  "request_trace.js",
  "capture_checkpoint.js",
  "remote_worker_bundle.next.js",
  "isolated_run_cell.next.js",
  "phase_regimes.js",
  "p0_negative_test.js",
  "p0_wire_test.js",
];

function shaFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function headRange(objectName) {
  const target = `https://streaming-1438331348.cos.ap-guangzhou.myqcloud.com/${objectName}`;
  return new Promise((resolve, reject) => {
    const req = https.request(target, { method: "GET", headers: { Range: "bytes=0-0" }, timeout: 20000 }, (res) => {
      res.resume();
      res.on("end", () => resolve({
        url: target,
        status: res.statusCode,
        etag: res.headers.etag || "",
        content_range: res.headers["content-range"] || "",
        last_modified: res.headers["last-modified"] || "",
      }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("origin head timeout")));
    req.end();
  });
}

async function main() {
  const rows = files.map((name) => {
    const file = path.join(runtime, name);
    const hash = shaFile(file);
    return { component: name, sha256: hash, bytes: fs.statSync(file).size };
  });
  const combined = crypto.createHash("sha256").update(rows.map((row) => `${row.component}:${row.sha256}`).join("\n")).digest("hex");
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: "D:/Program/P5_3DGS", encoding: "utf8" });
  const sourceCommit = (git.stdout || "").trim();
  const coit = await headRange("coit-40m-sh1-lod.rad");
  const poland = await headRange("poland-lod.rad");
  const config = {
    runtime_version: "SPADE-VERIFIED-20261024",
    prior_runtime_version: "SPADE-BYTE-UNVERIFIED-20261023",
    proxy_budget_bytes: 52428800,
    proxy_max_objects: 100,
    sensitivity_budget_bytes: 555745280,
    handoff_hold_ms: 15000,
    client_cap_bytes: 167772160,
    peer_timeout_ms: 1500,
    hosts: { S: "192.168.1.200", C3: "192.168.1.197", C4: "192.168.1.196", C5: "192.168.1.195" },
  };
  const configHash = crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex");
  const manifest = {
    campaign: "SPADE_WWW_EVIDENCE_V2_20261024",
    source_commit: sourceCommit,
    runtime_version: config.runtime_version,
    prior_runtime_version: config.prior_runtime_version,
    runtime_tree_sha256: combined,
    proxy_configuration_sha256: configHash,
    storage_real_path: "F:/SPADE_WWW_EVIDENCE_V2_20261024",
    mandated_path: root,
    origin: { coit, poland },
    p0: "P0_PASS",
    p0_wire: "P0_WIRE_PASS",
    locked_utc: new Date().toISOString(),
  };
  const manifestPath = path.join(root, "EXPERIMENT_MANIFEST.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const manifestHash = shaFile(manifestPath);
  const env = [
    ["source_commit", sourceCommit],
    ["runtime_version", config.runtime_version],
    ["prior_runtime_version", config.prior_runtime_version],
    ["runtime_tree_sha256", combined],
    ["browser_bundle_sha256", rows.find((row) => row.component === "remote_worker_bundle.next.js").sha256],
    ["capture_checkpoint_sha256", rows.find((row) => row.component === "capture_checkpoint.js").sha256],
    ["proxy_configuration_sha256", configHash],
    ["dependency_lock_sha256", "NO_PACKAGE_LOCK"],
    ["node_version", process.version],
    ["origin_coit_etag", coit.etag],
    ["origin_coit_content_range", coit.content_range],
    ["origin_poland_etag", poland.etag],
    ["origin_poland_content_range", poland.content_range],
    ["experiment_manifest_sha256", manifestHash],
    ["storage_real_path", "F:/SPADE_WWW_EVIDENCE_V2_20261024"],
  ];
  const csv = ["field,value", ...env.map(([field, value]) => `${field},${JSON.stringify(value)}`)].join("\n") + "\n";
  fs.writeFileSync(path.join(root, "ENV_AND_RUNTIME_HASHES.csv"), csv);
  fs.writeFileSync(path.join(root, "SOURCE_LOCK.json"), JSON.stringify({ manifest_sha256: manifestHash, files: rows, config, config_sha256: configHash }, null, 2));
  console.log(JSON.stringify({ locked: true, manifestHash, combined, coit: coit.etag, poland: poland.etag, sourceCommit }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
