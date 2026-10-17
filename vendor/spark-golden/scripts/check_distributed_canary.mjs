/**
 * Minimal distributed-network canary — must pass before 24h batch.
 *
 *   node scripts/check_distributed_canary.mjs
 *   node scripts/check_distributed_canary.mjs --batchDir=path/to/existing
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { cleanupStaleAblationProcesses } from "./lib/local_stutter_ablation_cell.mjs";
import { loadDeliveryProfilesConfig } from "./lib/distributed_network/delivery_profiles.mjs";
import {
  expandExperimentMatrix,
  loadExperimentMatrix,
  writeMatrixArtifacts,
} from "./lib/distributed_network/experiment_matrix.mjs";
import { runDistributedNetworkTrial } from "./lib/distributed_network/trial_cell.mjs";
import { upsertTrial, saveManifest } from "./lib/distributed_network/manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const o = { batchDir: null };
  for (const a of argv) {
    if (a.startsWith("--batchDir=")) o.batchDir = a.slice(11);
  }
  return o;
}

async function validateTrial(t) {
  const issues = [];
  const isFetch = t.arm_id === "E5_fetch_only";

  if (!isFetch && (!Number.isFinite(t.measure_fps) || t.measure_fps <= 0)) {
    issues.push("missing measure_fps");
  }
  if (!t.protocol) issues.push("missing protocol");
  if (t.measure_rad_requests == null) issues.push("missing measure_rad_requests");
  if (!t.asset_url) issues.push("missing asset_url");
  if (!t.gpu_renderer) issues.push("missing gpu_renderer");
  if (t.status !== "completed") issues.push(`status=${t.status}`);

  if (t.run_dir) {
    const cdp = path.join(t.run_dir, "cdp_network_audit.csv");
    let netOk = false;
    try {
      const st = await fs.stat(cdp);
      netOk = st.size > 20;
    } catch { /* */ }
    if (!netOk) {
      try {
        const raw = path.join(t.run_dir, "raw_logs");
        const files = await fs.readdir(raw);
        netOk = files.some((f) => f.startsWith("network_") && f.endsWith(".jsonl"));
      } catch { /* */ }
    }
    if (!netOk) issues.push("missing network logs");
  } else {
    issues.push("missing run_dir");
  }
  return issues;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await cleanupStaleAblationProcesses();

  const startedAt = new Date().toISOString();
  const ts = startedAt.replace(/[:.]/g, "-").slice(0, 19);
  const batchDir =
    opts.batchDir || path.join(projectRoot, "260506_distributed_network_benchmark", ts);
  await fs.mkdir(batchDir, { recursive: true });

  const matrix = await loadExperimentMatrix("canary");
  const profilesDoc = await loadDeliveryProfilesConfig();
  const trials = expandExperimentMatrix(matrix);
  await writeMatrixArtifacts(batchDir, matrix, trials, profilesDoc);

  const manifest = { trials: [], batch_dir: batchDir, kind: "canary", started_at: startedAt };
  const controllerLog = path.join(batchDir, "raw_logs", "controller.log");
  await fs.mkdir(path.dirname(controllerLog), { recursive: true });
  const log = async (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    console.log(msg);
    await fs.appendFile(controllerLog, line, "utf8");
  };

  await log(`canary batch_dir=${batchDir}`);
  await log(`trials=${trials.length}`);

  const results = [];
  let portOff = 0;
  for (const desc of trials) {
    await log(`RUN ${desc.arm_id} ${desc.measurement_mode} trial=${desc.trial_index}`);
    const t0 = Date.now();
    let trialJson;
    let err = null;
    try {
      ({ trialJson } = await runDistributedNetworkTrial({
        batchDir,
        trialDescriptor: desc,
        profilesDoc,
        machineMeta: {
          machine_id: process.env.VRC_MACHINE_ID || os.hostname(),
          worker_id: process.env.VRC_WORKER_ID || "w0",
        },
        assetPortOffset: portOff,
      }));
    } catch (e) {
      err = e;
      trialJson = { status: "failed", error: String(e?.message || e), arm_id: desc.arm_id };
    }
    portOff += 5;
    const issues = await validateTrial(trialJson);
    const pass = !err && issues.length === 0;
    upsertTrial(manifest, {
      ...desc,
      status: pass ? "completed" : "failed",
      duration_ms: Date.now() - t0,
      issues,
      trial_json: path.join("per_trial_json", `${desc.arm_id}.json`),
    });
    results.push({ desc, trialJson, issues, pass });
    await log(
      `${pass ? "PASS" : "FAIL"} ${desc.arm_id} fps=${trialJson.measure_fps} protocol=${trialJson.protocol} measure_rad=${trialJson.measure_rad_requests} gpu=${String(trialJson.gpu_renderer || "").slice(0, 40)} issues=${issues.join(";")}`,
    );
  }

  await saveManifest(batchDir, manifest);

  const summaryPath = path.join(batchDir, "reports", "canary_summary.md");
  await fs.mkdir(path.dirname(summaryPath), { recursive: true });
  const passed = results.filter((r) => r.pass).length;
  const lines = [
    "# Distributed network canary summary",
    "",
    `- batch_dir: \`${batchDir}\``,
    `- passed: **${passed}** / ${results.length}`,
    `- timestamp: ${startedAt}`,
    "",
    "## Trials",
    "",
    "| arm | mode | pass | measure_fps | protocol | measure_rad | gpu_renderer | issues |",
    "|-----|------|------|-------------|----------|-------------|--------------|--------|",
  ];
  for (const { desc, trialJson: t, issues, pass } of results) {
    lines.push(
      `| ${desc.arm_id} | ${desc.measurement_mode} | ${pass ? "yes" : "no"} | ${t.measure_fps ?? "—"} | ${t.protocol ?? "—"} | ${t.measure_rad_requests ?? "—"} | ${String(t.gpu_renderer || "").slice(0, 32)} | ${issues.join(", ") || "—"} |`,
    );
  }
  lines.push("");
  if (passed < results.length) {
    lines.push("**CANARY FAILED** — do not start 24h batch until all checks pass.");
  } else {
    lines.push("**CANARY PASSED** — review summary then confirm 24h run.");
  }
  await fs.writeFile(summaryPath, lines.join("\n"), "utf8");

  console.log("\n======== CANARY SUMMARY ========");
  console.log(`batch_dir: ${batchDir}`);
  console.log(`passed: ${passed}/${results.length}`);
  console.log(`report: ${summaryPath}`);
  for (const { desc, trialJson: t, pass } of results) {
    console.log(
      `  ${pass ? "OK" : "FAIL"} ${desc.arm_id} fps=${t.measure_fps} protocol=${t.protocol} rad=${t.measure_rad_requests}`,
    );
  }

  if (passed < results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
