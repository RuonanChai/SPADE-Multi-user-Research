/**
 * Minimal HPC-CDN-Tunnel canary: 4 trials via Cloudflare Tunnel.
 * node scripts/hpc-cdn-tunnel-canary.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { runDistributedNetworkTrial } from "./lib/distributed_network/trial_cell.mjs";
import { loadDeliveryProfilesConfig } from "./lib/distributed_network/delivery_profiles.mjs";
import { cleanupStaleAblationProcesses } from "./lib/local_stutter_ablation_cell.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const TRIALS = [
  { delivery_profile: "hpc_cdn_tunnel", scenario: "single_user", arm_id: "E3_normal_streaming", measurement_mode: "streaming_in_loop_mode", trial_index: 0, client_id: "c0", client_count: 1, warmup_ms: 20000, move_ms: 40000, timeout_ms: 1200000, startup_mode: "steady_state" },
  { delivery_profile: "hpc_cdn_tunnel", scenario: "single_user", arm_id: "E5_fetch_only", measurement_mode: "streaming_in_loop_mode", trial_index: 0, client_id: "c0", client_count: 1, warmup_ms: 20000, move_ms: 40000, timeout_ms: 1200000, startup_mode: "steady_state" },
  { delivery_profile: "hpc_cdn_tunnel", scenario: "single_user", arm_id: "E8_pure_render", measurement_mode: "warm_steady_render_mode", trial_index: 0, client_id: "c0", client_count: 1, warmup_ms: 20000, move_ms: 40000, timeout_ms: 1200000, startup_mode: "steady_state" },
  { delivery_profile: "hpc_cdn_tunnel", scenario: "cold_start_single_user", arm_id: "E3_normal_streaming", measurement_mode: "streaming_in_loop_mode", trial_index: 0, client_id: "c0", client_count: 1, warmup_ms: 0, move_ms: 40000, timeout_ms: 1200000, startup_mode: "cold_start" },
];

async function main() {
  const outDir = path.join(projectRoot, "paper_materials", "measurement_motivation_24h", "hpc_cdn_tunnel_runs");
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(path.join(outDir, "per_trial_json"), { recursive: true });
  await fs.mkdir(path.join(outDir, "per_trial_runs"), { recursive: true });
  await fs.mkdir(path.join(outDir, "raw_logs"), { recursive: true });

  const profilesDoc = await loadDeliveryProfilesConfig(
    path.join(projectRoot, "260506_distributed_network_benchmark", "2026-05-20T06-20-11", "config", "delivery_profiles.json"),
    { preferLab: false },
  );

  const results = [];

  for (const desc of TRIALS) {
    await cleanupStaleAblationProcesses();
    const trialKey = [desc.delivery_profile, desc.scenario, desc.arm_id, desc.measurement_mode, `t${desc.trial_index}`, desc.client_id].join("__");
    console.log(`\n===== ${trialKey} =====`);

    let result;
    try {
      result = await runDistributedNetworkTrial({
        batchDir: outDir,
        trialDescriptor: desc,
        profilesDoc,
        machineMeta: { machine_id: os.hostname(), worker_id: "hpc_cdn_tunnel_canary" },
        assetPortOffset: 0,
      });
    } catch (e) {
      result = { trialJson: { trial_id: trialKey, status: "failed", error: String(e?.message || e), gpu_renderer: "", measure_rad_requests: null, measure_fps: null }, gateEval: { passed: false, failures: [String(e?.message || e)] } };
    }

    const tj = result.trialJson;
    const summary = {
      trial_key: trialKey,
      status: tj.status,
      gpu_renderer: tj.gpu_renderer || "",
      measure_fps: tj.measure_fps ?? tj.fps_mean ?? null,
      measure_rad_requests: tj.measure_rad_requests ?? null,
      preload_rad_requests: tj.preload_rad_requests ?? null,
      network_p95_ms: tj.request_total_p95_ms ?? tj.network_total_p95_ms ?? null,
      ttfb_p95_ms: tj.ttfb_p95_ms ?? null,
      first_visible_splat_ms: tj.first_visible_splat_ms ?? null,
      hard_gate_passed: tj.hard_gate_passed ?? false,
      hard_gate_failures: tj.hard_gate_failures ?? [],
      error: tj.error || null,
    };
    results.push(summary);
    console.log(JSON.stringify(summary, null, 2));
  }

  await fs.writeFile(path.join(outDir, "hpc_cdn_tunnel_results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(`\n===== DONE: ${results.filter(r => r.status === "completed").length}/${results.length} passed =====`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
