/**
 * Append cold_start_single_user trials to an existing 24h manifest (does not rerun steady trials).
 *
 *   node scripts/append-distributed-cold-start-trials.mjs --batchDir=260506_distributed_network_benchmark/2026-05-20T06-20-11
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadExperimentMatrix } from "./lib/distributed_network/experiment_matrix.mjs";
import { loadManifest, saveManifest, trialKey, upsertTrial } from "./lib/distributed_network/manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  let batchDir = null;
  for (const a of argv) {
    if (a.startsWith("--batchDir=")) batchDir = path.resolve(a.slice(11));
  }
  if (!batchDir) throw new Error("--batchDir required");
  return { batchDir };
}

async function main() {
  const { batchDir } = parseArgs(process.argv.slice(2));
  const matrixPath = path.join(batchDir, "config", "experiment_matrix.json");
  let matrix;
  try {
    matrix = JSON.parse(await fs.readFile(matrixPath, "utf8"));
  } catch {
    matrix = await loadExperimentMatrix("round1");
  }

  if (!matrix.cold_start?.enabled) {
    console.error("Matrix has cold_start.enabled=false — enable in experiment_matrix first.");
    process.exitCode = 1;
    return;
  }

  const { expandExperimentMatrix } = await import("./lib/distributed_network/experiment_matrix.mjs");
  const all = expandExperimentMatrix(matrix);
  const coldOnly = all.filter((t) => t.scenario === (matrix.cold_start.scenario ?? "cold_start_single_user"));

  const manifest = await loadManifest(batchDir);
  const existing = new Set(manifest.trials.map((t) => trialKey(t)));
  let added = 0;
  for (const desc of coldOnly) {
    const key = trialKey(desc);
    if (existing.has(key)) continue;
    upsertTrial(manifest, { ...desc, status: "pending" });
    existing.add(key);
    added++;
  }

  manifest.total_trials = manifest.trials.length;
  await saveManifest(batchDir, manifest);
  console.log(`Appended ${added} cold-start trials (${coldOnly.length} in matrix slice).`);
  console.log(`manifest total: ${manifest.trials.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
