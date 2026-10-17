/**
 * Resume incomplete / failed trials from manifest.json.
 *
 *   node scripts/resume_distributed_experiment.mjs --batchDir=260506_distributed_network_benchmark/<ts>
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { cleanupStaleAblationProcesses } from "./lib/local_stutter_ablation_cell.mjs";
import { loadDeliveryProfilesConfig } from "./lib/distributed_network/delivery_profiles.mjs";
import { loadExperimentMatrix } from "./lib/distributed_network/experiment_matrix.mjs";
import { loadManifest, pendingTrials, saveManifest, upsertTrial } from "./lib/distributed_network/manifest.mjs";
import { runDistributedNetworkTrial } from "./lib/distributed_network/trial_cell.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const o = { batchDir: null, retryFailed: true };
  for (const a of argv) {
    if (a.startsWith("--batchDir=")) o.batchDir = a.slice(11);
    if (a === "--no-retry-failed") o.retryFailed = false;
  }
  if (!o.batchDir) throw new Error("--batchDir required");
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await cleanupStaleAblationProcesses();
  const batchDir = path.resolve(opts.batchDir);
  const manifest = await loadManifest(batchDir);
  const pending = pendingTrials(manifest, { retryFailed: opts.retryFailed });
  const profilesDoc = await loadDeliveryProfilesConfig(
    path.join(batchDir, "config", "delivery_profiles.json"),
  );

  console.log(`[resume] batch=${batchDir} pending=${pending.length}`);
  let portOff = 100;
  for (const desc of pending) {
    console.log(`[resume] RUN ${desc.trial_key || desc.arm_id}`);
    upsertTrial(manifest, { ...desc, status: "running" });
    await saveManifest(batchDir, manifest);
    try {
      const { trialJson } = await runDistributedNetworkTrial({
        batchDir,
        trialDescriptor: desc,
        profilesDoc,
        machineMeta: {
          machine_id: process.env.VRC_MACHINE_ID || os.hostname(),
          worker_id: process.env.VRC_WORKER_ID || "w0",
        },
        assetPortOffset: portOff,
      });
      upsertTrial(manifest, { ...desc, status: trialJson.status === "completed" ? "completed" : "failed" });
    } catch (e) {
      upsertTrial(manifest, { ...desc, status: "failed", error: String(e?.message || e) });
    }
    await saveManifest(batchDir, manifest);
    portOff += 5;
  }
  console.log(`[resume] done`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
