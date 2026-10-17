/**
 * Harness smoke test — validates the analysis pipeline can run end-to-end
 * using synthetic raw data (for CI/dev only, NOT for paper claims).
 *
 * Creates minimal raw session dirs with fake JSONL, runs the full analysis
 * pipeline, and checks that all expected outputs are produced.
 *
 * Usage: node vrc-paper/analysis/smoke_test_harness.mjs
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TMP = path.join(os.tmpdir(), `vrc_smoke_${Date.now()}`);
const RAW = path.join(TMP, "raw");
const SUMMARY = path.join(TMP, "summary");
const FIGURES = path.join(TMP, "figures");
const SCREENSHOTS = path.join(TMP, "screenshots");

fs.mkdirSync(RAW, { recursive: true });
fs.mkdirSync(SUMMARY, { recursive: true });
fs.mkdirSync(FIGURES, { recursive: true });
fs.mkdirSync(SCREENSHOTS, { recursive: true });

const METHODS = ["Full", "Spark-MU", "VP-S", "NET-S", "VRC"];
const SCENARIOS = ["nearby", "burst_turn", "divergent"];

function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
}

function syntheticRequests(method, scenario, userId) {
  const rows = [];
  const baseLatency = method === "VRC" ? 30 : method === "Spark-MU" ? 80 : 55;
  for (let i = 0; i < 20; i++) {
    const lat = baseLatency + Math.random() * 40;
    rows.push({
      url: `https://example.com/streaming-lod/chunk-${i}.rad`,
      user_id: userId,
      method,
      scenario,
      session_id: `${method}_${scenario}_t0_${Date.now()}`,
      service_time_ms: lat,
      bytes_sent: 50000 + Math.floor(Math.random() * 100000),
      status: 206,
      request_start: Date.now() - lat,
      response_end: Date.now(),
      range: `bytes=${i * 50000}-${(i + 1) * 50000 - 1}`,
      host_ip: userId.includes("2") || userId.includes("3") ? "10.4.146.68" : "10.4.158.143",
      worker_id: userId.includes("2") || userId.includes("3") ? "worker2" : "worker1",
    });
  }
  return rows;
}

function syntheticClientMetrics(method, scenario, userId) {
  const baseP95 = method === "VRC" ? 35 : method === "Spark-MU" ? 90 : 60;
  return {
    user_id: userId,
    method,
    scenario,
    session_id: `${method}_${scenario}_t0_smoke`,
    final: true,
    snapshot: "final",
    trial: 0,
    p50_latency_ms: baseP95 * 0.6,
    p95_latency_ms: baseP95,
    p99_latency_ms: baseP95 * 1.3,
    fraction_over_50ms: method === "VRC" ? 0.1 : 0.5,
    duplicate_request_ratio: method === "VRC" ? 0.02 : 0.15,
    aggregate_client_bytes: 2000000,
    shared_bytes: method === "VRC" ? 800000 : 0,
    personalized_bytes: method === "VRC" ? 1200000 : 2000000,
    fps: 55 + Math.random() * 10,
    visible_quality: 0.85,
    qoe: 0.6,
    worker_id: userId.includes("2") || userId.includes("3") ? "worker2" : "worker1",
    host_ip: userId.includes("2") || userId.includes("3") ? "10.4.146.68" : "10.4.158.143",
  };
}

function syntheticServerEvents(method, scenario, sessionId) {
  const events = [];
  events.push({ event: "session_new", session_id: sessionId, method, t: Date.now() });
  for (let step = 0; step < 10; step++) {
    for (const uid of ["u0", "u1", "u2", "u3"]) {
      const chunks = [];
      const base = uid === "u0" ? 0 : uid === "u1" ? 3 : uid === "u2" ? 6 : 9;
      for (let c = base; c < base + 5; c++) chunks.push(String(c));
      events.push({
        event: "user_state",
        user_id: uid,
        session_id: sessionId,
        viewport_chunks: chunks,
        t: Date.now() + step * 50,
      });
    }
    events.push({
      event: "vrc_decision",
      session_id: sessionId,
      method,
      decision_step: Date.now() + step * 50,
      shared_chunks: ["3", "4", "5"],
      personalized_chunks: { u0: ["0", "1", "2"], u1: ["6", "7"], u2: ["8", "9"], u3: ["10", "11"] },
      num_users: 4,
      t: Date.now() + step * 50,
    });
  }
  return events;
}

console.log(`[smoke] Creating synthetic data in ${TMP}`);

for (const method of METHODS) {
  for (const scenario of SCENARIOS) {
    const sessionId = `${method}_${scenario}_t0_${Date.now()}`;
    const dir = path.join(RAW, sessionId);
    fs.mkdirSync(dir, { recursive: true });

    const allReqs = [];
    const allMetrics = [];
    for (const uid of ["u0", "u1", "u2", "u3"]) {
      allReqs.push(...syntheticRequests(method, scenario, uid));
      allMetrics.push(syntheticClientMetrics(method, scenario, uid));
    }

    writeJsonl(path.join(dir, "request_logs.jsonl"), allReqs);
    writeJsonl(path.join(dir, "client_metrics.jsonl"), allMetrics);
    writeJsonl(path.join(dir, `${sessionId}_server.jsonl`), syntheticServerEvents(method, scenario, sessionId));

    if (method.startsWith("VRC")) {
      writeJsonl(path.join(dir, "vrc_decisions.jsonl"),
        syntheticServerEvents(method, scenario, sessionId).filter(e => e.event === "vrc_decision"));
    }

    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({
      status: "PASS", session_id: sessionId, method, scenario, trial: 0,
      delivery_profile: "static_cdn", worker1_host: "10.4.158.143", worker2_host: "10.4.146.68",
    }));

    fs.writeFileSync(path.join(dir, "source_breakdown.json"), JSON.stringify({
      delivery_profile: "static_cdn", cdn_label: "cdn1",
      cdn_request_count: 40, cdn2_request_count: 20, hpc_request_count: 10,
      total_request_count: 70, source_validation_ok: true,
      host_ips: ["10.4.158.143", "10.4.146.68"],
      worker1_users: "u0,u1", worker2_users: "u2,u3",
    }));
  }
}

// Write pass/fail CSV
const pfRows = METHODS.flatMap(m => SCENARIOS.map(s => ({
  run: 1, method: m, scenario: s, trial: 0, status: "PASS",
  session_id: `${m}_${s}_t0_smoke`, delivery_profile: "static_cdn",
})));
const pfKeys = Object.keys(pfRows[0]);
const pfCsv = [pfKeys.join(","), ...pfRows.map(r => pfKeys.map(k => r[k]).join(","))].join("\n");
fs.writeFileSync(path.join(SUMMARY, "run_pass_fail.csv"), pfCsv + "\n");

console.log(`[smoke] Running analysis pipeline...`);

const scripts = [
  path.join(__dirname, "aggregate.mjs"),
  path.join(__dirname, "source_breakdown_aggregator.mjs"),
  path.join(__dirname, "validate_canary.mjs"),
  path.join(__dirname, "generate_figures.mjs"),
  path.join(__dirname, "generate_report.mjs"),
];

let failures = 0;
for (const script of scripts) {
  const name = path.basename(script);
  try {
    execSync(`node "${script}"`, {
      cwd: ROOT,
      env: { ...process.env, VRC_RESULTS_ROOT: TMP },
      stdio: "pipe",
      timeout: 30000,
    });
    console.log(`  PASS: ${name}`);
  } catch (e) {
    if (name === "validate_canary.mjs") {
      console.log(`  PASS (expected failures): ${name}`);
    } else {
      console.log(`  FAIL: ${name} — ${e.message?.split("\n")[0]}`);
      failures++;
    }
  }
}

// Verify outputs
const expectedFiles = [
  "summary/metrics_summary.csv",
  "summary/per_run_metrics.csv",
  "summary/per_client_metrics.csv",
  "summary/source_breakdown.csv",
  "summary/viewport_overlap_per_session.csv",
  "summary/canary_validation.json",
  "figures/fig2_vrc_workflow.svg",
  "figures/fig3_p95_latency.svg",
  "figures/fig4_fraction_over_50ms.svg",
  "figures/fig5_duplicate_ratio.svg",
  "figures/fig8_ablation.svg",
  "figures/fig9_mtp_timeline.svg",
  "figures/fig_appendix_all_methods_overview.svg",
  "final_report.md",
];

let missingCount = 0;
for (const f of expectedFiles) {
  const full = path.join(TMP, f);
  if (!fs.existsSync(full)) {
    console.log(`  MISSING: ${f}`);
    missingCount++;
  }
}

// Verify CSV content
const metricsCsv = path.join(TMP, "summary/metrics_summary.csv");
if (fs.existsSync(metricsCsv)) {
  const lines = fs.readFileSync(metricsCsv, "utf8").trim().split("\n");
  if (lines.length < 2) {
    console.log("  FAIL: metrics_summary.csv is empty");
    failures++;
  } else {
    console.log(`  OK: metrics_summary.csv has ${lines.length - 1} rows`);
  }
}

// Cleanup
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log(`\n[smoke] ${failures === 0 && missingCount === 0 ? "ALL PASS" : `${failures} failures, ${missingCount} missing files`}`);
process.exit(failures + missingCount > 0 ? 1 : 0);
