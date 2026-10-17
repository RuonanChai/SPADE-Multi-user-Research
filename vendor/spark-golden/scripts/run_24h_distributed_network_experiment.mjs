/**
 * 24h distributed network benchmark (Node runner).
 *
 *   node scripts/run_24h_distributed_network_experiment.mjs
 *   node scripts/run_24h_distributed_network_experiment.mjs --resume --batchDir=...
 */
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { cleanupStaleAblationProcesses } from "./lib/local_stutter_ablation_cell.mjs";
import { loadDeliveryProfilesConfig } from "./lib/distributed_network/delivery_profiles.mjs";
import { loadLabInfrastructure } from "./lib/distributed_network/load_lab_infrastructure.mjs";
import {
  expandExperimentMatrix,
  loadExperimentMatrix,
  writeMatrixArtifacts,
} from "./lib/distributed_network/experiment_matrix.mjs";
import {
  loadManifest,
  saveManifest,
  upsertTrial,
  pendingTrials,
} from "./lib/distributed_network/manifest.mjs";
import { runDistributedNetworkTrial } from "./lib/distributed_network/trial_cell.mjs";
import { evaluateHardGates, applyHardGatesToTrialJson } from "./lib/distributed_network/hard_gates.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const ACCEPTED_CANARY_BATCH = "2026-05-20T05-54-12";

function parseArgs(argv) {
  const o = {
    batchDir: null,
    matrix: "round1",
    resume: false,
    skipCanaryCheck: false,
    canaryBatch: ACCEPTED_CANARY_BATCH,
    trialTimeoutMs: 1_200_000,
  };
  for (const a of argv) {
    if (a.startsWith("--batchDir=")) o.batchDir = a.slice(11);
    else if (a.startsWith("--matrix=")) o.matrix = a.slice(9);
    else if (a === "--resume") o.resume = true;
    else if (a === "--skipCanaryCheck") o.skipCanaryCheck = true;
    else if (a.startsWith("--canaryBatch=")) o.canaryBatch = a.slice(14);
    else if (a.startsWith("--trialTimeoutMs=")) o.trialTimeoutMs = Number.parseInt(a.slice(17), 10);
  }
  return o;
}

async function verifyCanaryPrecondition(canaryBatchName) {
  const canaryDir = path.join(
    projectRoot,
    "260506_distributed_network_benchmark",
    canaryBatchName,
  );
  const summaryPath = path.join(canaryDir, "reports", "canary_summary.md");
  const text = await fs.readFile(summaryPath, "utf8");
  if (!text.includes("CANARY PASSED")) {
    throw new Error(`Canary batch not passed: ${summaryPath}`);
  }
  return { canaryDir, summaryPath };
}

async function appendFailureLog(batchDir, line) {
  const p = path.join(batchDir, "reports", "run_failures.md");
  await fs.mkdir(path.dirname(p), { recursive: true });
  let prev = "";
  try {
    prev = await fs.readFile(p, "utf8");
  } catch {
    prev = "# Run failures\n\n";
  }
  if (!prev.startsWith("#")) prev = `# Run failures\n\n${prev}`;
  await fs.writeFile(p, `${prev}${line}\n`, "utf8");
}

async function writeHalted(batchDir, reason, trialJson) {
  const halted = {
    halted_at: new Date().toISOString(),
    reason,
    last_trial: trialJson?.trial_id ?? null,
  };
  await fs.writeFile(
    path.join(batchDir, "halted.json"),
    `${JSON.stringify(halted, null, 2)}\n`,
    "utf8",
  );
  await appendFailureLog(batchDir, `- **HALT** ${halted.halted_at}: ${reason}`);
}

async function initBatch(opts) {
  if (opts.resume && opts.batchDir) {
    return path.resolve(opts.batchDir);
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const batchDir = opts.batchDir
    ? path.resolve(opts.batchDir)
    : path.join(projectRoot, "260506_distributed_network_benchmark", ts);
  await fs.mkdir(batchDir, { recursive: true });
  await fs.mkdir(path.join(batchDir, "raw_logs"), { recursive: true });
  await fs.mkdir(path.join(batchDir, "per_trial_json"), { recursive: true });
  await fs.mkdir(path.join(batchDir, "csv"), { recursive: true });
  await fs.mkdir(path.join(batchDir, "reports"), { recursive: true });

  const matrix = await loadExperimentMatrix(opts.matrix);
  const profilesDoc = await loadDeliveryProfilesConfig(null, { preferLab: true });
  const infra = await loadLabInfrastructure();
  const trials = expandExperimentMatrix(matrix);
  await writeMatrixArtifacts(batchDir, matrix, trials, profilesDoc, infra);
  console.log(`[24h] lab assets: HPC=${infra.assets.hpc_asset_url}`);
  console.log(`[24h] lab assets: CDN1=${infra.assets.cdn1_r2_asset_url}`);
  console.log(`[24h] lab assets: CDN2=${infra.assets.cdn2_gcs_asset_url}`);
  console.log(`[24h] workers: w1=${infra.workers.worker1.host_ip} w2=${infra.workers.worker2.host_ip}`);

  const canary = await verifyCanaryPrecondition(opts.canaryBatch);
  await fs.writeFile(
    path.join(batchDir, "config", "canary_precondition.json"),
    `${JSON.stringify(
      {
        accepted_canary_batch: opts.canaryBatch,
        canary_dir: canary.canaryDir,
        canary_summary: canary.summaryPath,
        verified_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const manifest = {
    batch_dir: batchDir,
    matrix: opts.matrix,
    started_at: new Date().toISOString(),
    canary_precondition: opts.canaryBatch,
    trials: trials.map((t) => ({ ...t, status: "pending" })),
    completed_count: 0,
    failed_count: 0,
    halted: false,
  };
  await saveManifest(batchDir, manifest);
  return batchDir;
}

function attachWorkerLog(batchDir) {
  const logPath = path.join(batchDir, "raw_logs", "worker_0.log");
  const stream = createWriteStream(logPath, { flags: "a" });
  const stamp = () => new Date().toISOString();
  const write = (level, args) => {
    stream.write(
      `[${stamp()}] [${level}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`,
    );
  };
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => {
    orig.log(...a);
    write("INFO", a);
  };
  console.error = (...a) => {
    orig.error(...a);
    write("ERROR", a);
  };
  console.warn = (...a) => {
    orig.warn(...a);
    write("WARN", a);
  };
  return {
    logPath,
    close: () => stream.end(),
  };
}

async function runAnalyze(batchDir) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/analyze_distributed_network_results.mjs", `--batchDir=${batchDir}`],
      { cwd: projectRoot, stdio: "inherit" },
    );
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`analyze exit ${code}`))));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await cleanupStaleAblationProcesses();

  if (!opts.skipCanaryCheck) {
    await verifyCanaryPrecondition(opts.canaryBatch);
  }

  const batchDir = opts.resume
    ? path.resolve(opts.batchDir)
    : await initBatch(opts);

  if (!opts.resume && !opts.skipCanaryCheck) {
    console.log(`[24h] canary precondition OK: ${opts.canaryBatch}`);
  }

  const controllerLog = path.join(batchDir, "raw_logs", "controller.log");
  const logger = attachWorkerLog(batchDir);
  console.log(`[24h] batch_dir=${batchDir}`);

  let manifest = await loadManifest(batchDir);
  if (manifest.halted) {
    console.error(`[24h] batch already halted — use --resume after fixing halted.json`);
    process.exitCode = 1;
    return;
  }

  try {
    await fs.access(path.join(batchDir, "halted.json"));
    console.error(`[24h] halted.json present — abort`);
    process.exitCode = 1;
    return;
  } catch { /* ok */ }

  const profilesDoc = await loadDeliveryProfilesConfig(
    path.join(batchDir, "config", "delivery_profiles.json"),
    { preferLab: false },
  );
  const queue = pendingTrials(manifest, { retryFailed: true });
  console.log(`[24h] pending_trials=${queue.length}`);

  let portOff = 0;
  let completed = 0;
  let failed = 0;

  for (const desc of queue) {
    const trialKey = [
      desc.delivery_profile,
      desc.scenario,
      desc.arm_id,
      desc.measurement_mode,
      `t${desc.trial_index}`,
      desc.client_id,
    ].join("__");

    await cleanupStaleAblationProcesses();

    console.log(`\n[24h] ===== ${trialKey} =====`);
    await fs.appendFile(
      controllerLog,
      `[${new Date().toISOString()}] START ${trialKey}\n`,
      "utf8",
    );
    upsertTrial(manifest, { ...desc, status: "running" });
    await saveManifest(batchDir, manifest);

    const t0 = Date.now();
    let trialJson;
    let runError = null;

    try {
      process.env.VRC_DELIVERY_PROFILE = desc.delivery_profile;
      const result = await runDistributedNetworkTrial({
        batchDir,
        trialDescriptor: desc,
        profilesDoc,
        machineMeta: {
          machine_id: process.env.VRC_MACHINE_ID || os.hostname(),
          worker_id: process.env.VRC_WORKER_ID || "worker1",
        },
        assetPortOffset: portOff,
      });
      trialJson = result.trialJson;
    } catch (e) {
      runError = e;
      trialJson = {
        trial_id: trialKey,
        status: "failed",
        error: String(e?.message || e),
        arm_id: desc.arm_id,
        delivery_profile: desc.delivery_profile,
        gpu_renderer: "",
        measure_rad_requests: null,
      };
    }

    const gateEval = evaluateHardGates(trialJson);
    applyHardGatesToTrialJson(trialJson, gateEval);

    const outPath = path.join(batchDir, "per_trial_json", `${trialKey}.json`);
    await fs.writeFile(outPath, `${JSON.stringify(trialJson, null, 2)}\n`, "utf8");

    const pass = !runError && gateEval.passed && trialJson.status === "completed";
    if (pass) completed++;
    else failed++;

    upsertTrial(manifest, {
      ...desc,
      status: pass ? "completed" : "failed",
      duration_ms: Date.now() - t0,
      hard_gate_passed: gateEval.passed,
      hard_gate_failures: gateEval.failures,
      trial_json: outPath,
      gpu_renderer: trialJson.gpu_renderer,
    });
    manifest.completed_count = completed;
    manifest.failed_count = failed;
    await saveManifest(batchDir, manifest);

    const logLine = `${pass ? "PASS" : "FAIL"} ${trialKey} fps=${trialJson.measure_fps} rad=${trialJson.measure_rad_requests} gpu=${String(trialJson.gpu_renderer || "").slice(0, 48)} gates=${gateEval.failures.join(";") || "ok"}`;
    console.log(`[24h] ${logLine}`);
    await fs.appendFile(controllerLog, `[${new Date().toISOString()}] ${logLine}\n`, "utf8");

    if (!gateEval.passed) {
      await appendFailureLog(
        batchDir,
        `- ${trialKey}: ${gateEval.failures.join("; ")}`,
      );
    }

    if (gateEval.halt_batch) {
      const reason = gateEval.failures.join("; ");
      console.error(`[24h] HARD GATE HALT: ${reason}`);
      manifest.halted = true;
      await saveManifest(batchDir, manifest);
      await writeHalted(batchDir, reason, trialJson);
      break;
    }

    portOff += 5;

    if ((completed + failed) % 5 === 0) {
      try {
        await runAnalyze(batchDir);
      } catch (e) {
        console.warn(`[24h] analyze warning: ${e?.message || e}`);
      }
    }
  }

  manifest.finished_at = new Date().toISOString();
  await saveManifest(batchDir, manifest);
  await runAnalyze(batchDir);

  console.log("\n======== 24h RUN CHECKPOINT ========");
  console.log(`batch_dir: ${batchDir}`);
  console.log(`completed: ${completed}`);
  console.log(`failed: ${failed}`);
  console.log(`halted: ${manifest.halted ?? false}`);
  console.log(`worker_log: ${logger.logPath}`);
  logger.close();
}

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
});
