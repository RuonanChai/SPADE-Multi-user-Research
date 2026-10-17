/**
 * Remap legacy profile names + clear halt so 24h resume can continue.
 *
 *   node scripts/remap_24h_manifest_profiles.mjs --batchDir=260506_distributed_network_benchmark/2026-05-20T06-20-11
 *   node scripts/remap_24h_manifest_profiles.mjs --batchDir=... --clearHalt
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { trialKey } from "./lib/distributed_network/manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MAP = {
  lan_server: "lan_controller",
  remote_cdn: "cdn1_r2",
  remote_cdn_throttled_50mbps_100ms: "cdn1_r2_throttled_50mbps_100ms",
  remote_cdn_throttled_10mbps_100ms: "cdn1_r2_throttled_10mbps_100ms",
};

const batchDir = process.argv.find((a) => a.startsWith("--batchDir="))?.slice(11);
const clearHalt = !process.argv.includes("--noClearHalt");

if (!batchDir) throw new Error("--batchDir required");

const manifestPath = path.join(batchDir, "manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
let remapped = 0;
let resetFailed = 0;

for (const t of manifest.trials) {
  const oldProfile = t.delivery_profile;
  const mapped = MAP[oldProfile];
  if (!mapped) continue;
  if (t.status === "completed") continue;

  t.delivery_profile = mapped;
  t.trial_key = trialKey(t);
  remapped++;

  if (t.status === "failed") {
    t.status = "pending";
    delete t.trial_json;
    delete t.hard_gate_passed;
    delete t.hard_gate_failures;
    delete t.duration_ms;
    resetFailed++;
  }
}

manifest.halted = false;
delete manifest.halt_reason;

await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const matrixSrc = path.join(root, "config/distributed_network/experiment_matrix.round1.json");
const matrixDst = path.join(batchDir, "config/experiment_matrix.json");
try {
  await fs.copyFile(matrixSrc, matrixDst);
  console.log(`[remap] synced ${matrixDst} from round1`);
} catch (e) {
  console.warn(`[remap] matrix sync warning: ${e?.message || e}`);
}

const labProfiles = path.join(batchDir, "config/delivery_profiles.json");
try {
  const { loadDeliveryProfilesWithLab } = await import("./lib/distributed_network/load_lab_infrastructure.mjs");
  const { profilesDoc } = await loadDeliveryProfilesWithLab();
  await fs.writeFile(labProfiles, `${JSON.stringify(profilesDoc, null, 2)}\n`, "utf8");
  console.log(`[remap] refreshed ${labProfiles} from distributed_lab.json`);
} catch (e) {
  console.warn(`[remap] delivery_profiles refresh: ${e?.message || e}`);
}

if (clearHalt) {
  const haltedPath = path.join(batchDir, "halted.json");
  try {
    await fs.unlink(haltedPath);
    console.log(`[remap] removed ${haltedPath}`);
  } catch {
    console.log("[remap] no halted.json");
  }
}

console.log(`[remap] remapped ${remapped} trials, reset ${resetFailed} failed → pending`);
console.log("[remap] resume with:");
console.log(
  `  node scripts/run_24h_distributed_network_experiment.mjs --resume --batchDir=${batchDir}`,
);
