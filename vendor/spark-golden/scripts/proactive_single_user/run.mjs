#!/usr/bin/env node
/**
 * Proactive single-user runner.
 *
 *   node scripts/proactive_single_user/run.mjs --phase=phase0_canary
 *   node scripts/proactive_single_user/run.mjs --autonomous
 *   node scripts/proactive_single_user/run.mjs --resume --batchDir=...
 */
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMatrix } from "./delivery.mjs";
import { expandTrials, trialId } from "./matrix.mjs";
import { resolveProactiveDelivery } from "./delivery.mjs";
import { runProactiveTrial } from "./trial_cell.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const AUTONOMOUS_PHASES = ["phase0_canary", "phase1_origin_full", "phase2_remote_reduced"];

function parseArgs(argv) {
  const o = {
    phase: "phase0_canary",
    batchDir: null,
    resume: false,
    autonomous: false,
    maxRetries: 2,
  };
  for (const a of argv) {
    if (a.startsWith("--phase=")) o.phase = a.slice(8);
    else if (a.startsWith("--batchDir=")) o.batchDir = path.resolve(a.slice(11));
    else if (a === "--resume") o.resume = true;
    else if (a === "--autonomous") o.autonomous = true;
    else if (a.startsWith("--maxRetries=")) o.maxRetries = Number(a.slice(13)) || 2;
  }
  return o;
}

async function curlCheck(url) {
  const r = spawnSync(
    "curl.exe",
    ["-sI", "--connect-timeout", "12", "-H", "Range: bytes=0-1023", url],
    { encoding: "utf8", windowsHide: true },
  );
  const out = (r.stdout || "") + (r.stderr || "");
  return { ok: /206|200/.test(out), snippet: out.split("\n")[0] };
}

async function loadManifest(batchDir) {
  const p = path.join(batchDir, "manifest.json");
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return { trials: [] };
  }
}

async function saveManifest(batchDir, manifest) {
  manifest.updated_at = new Date().toISOString();
  await fs.writeFile(path.join(batchDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function isTransientError(msg) {
  return /timeout|page\.goto|Target closed|browser|ECONNRESET|ETIMEDOUT|Navigation/i.test(msg);
}

async function ensureBatchDir(opts, matrix) {
  let batchDir = opts.batchDir;
  if (!batchDir) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    batchDir = path.join(root, "paper_materials", "proactive_single_user", "runs", ts);
  }
  await fs.mkdir(path.join(batchDir, "per_trial_json"), { recursive: true });
  await fs.mkdir(path.join(batchDir, "per_trial_runs"), { recursive: true });
  await fs.mkdir(path.join(batchDir, "config"), { recursive: true });
  await fs.copyFile(
    path.join(root, "config", "proactive_single_user", "experiment_matrix.json"),
    path.join(batchDir, "config", "experiment_matrix.json"),
  );
  return batchDir;
}

async function buildManifestTrials(batchDir, matrix, phases, existing = []) {
  const byKey = new Map(existing.map((t) => [trialId(t), t]));
  for (const phaseName of phases) {
    for (const desc of expandTrials(matrix, phaseName)) {
      const key = trialId(desc);
      if (!byKey.has(key)) {
        byKey.set(key, { ...desc, status: "pending", trial_key: key, attempts: 0 });
      }
    }
  }
  return [...byKey.values()];
}

async function writeBlocker(reason, details) {
  const blocker = path.join(root, "paper_materials", "proactive_single_user", "blocker_report.md");
  await fs.writeFile(blocker, `# Blocker\n\n- ${reason}\n\n${details}\n`, "utf8");
}

async function runPhaseTrials({ batchDir, manifest, matrix, opts, phaseFilter }) {
  const refDemand = (dk) => path.join(batchDir, `reference_demand_${dk}.json`);
  let portOff = 0;
  const blockers = [];

  for (const desc of manifest.trials) {
    if (phaseFilter && desc.phase !== phaseFilter) continue;
    if (desc.status === "completed" && desc.hard_gate_passed) continue;

    const tid = trialId(desc);
    if (opts.resume && !desc.hard_gate_passed) desc.attempts = 0;
    desc.attempts = desc.attempts || 0;

    while (desc.attempts <= opts.maxRetries) {
      desc.attempts += 1;
      console.log(`\n[proactive] === ${tid} (attempt ${desc.attempts}) ===`);
      desc.status = "running";
      await saveManifest(batchDir, manifest);

      try {
        const delivery = await resolveProactiveDelivery(desc.delivery_key, matrix);
        const curl = await curlCheck(delivery.curl_check_url);
        if (!curl.ok) {
          throw new Error(`curl failed before trial: ${delivery.curl_check_url} (${curl.snippet})`);
        }
        console.log(`[proactive] curl 206 OK: ${delivery.curl_check_url}`);
        const { trialJson, gate } = await runProactiveTrial({
          batchDir,
          desc,
          delivery,
          referenceDemandPath: refDemand(desc.delivery_key),
          assetPortOffset: portOff,
        });
        desc.status = trialJson.status;
        desc.hard_gate_passed = gate.passed;
        desc.trial_json = path.join(batchDir, "per_trial_json", `${tid}.json`);

        if (gate.passed) {
          console.log(
            `[proactive] PASS miss50=${((trialJson.deadline_miss_ratio_50ms || 0) * 100).toFixed(1)}% useful_before=${trialJson.useful_chunks_before_demand} fps=${trialJson.measure_fps}`,
          );
          break;
        }

        const failMsg = gate.failures.join("; ");
        blockers.push(`${tid}: ${failMsg}`);
        if (desc.phase === "phase0_canary" && desc.attempts > opts.maxRetries) {
          await writeBlocker("Phase0 canary failed", blockers.map((b) => `- ${b}`).join("\n"));
          console.error("[proactive] STOP: phase0 metrics incomplete");
          process.exitCode = 1;
          await saveManifest(batchDir, manifest);
          return { stopped: true, blockers };
        }
        if (desc.attempts <= opts.maxRetries) {
          console.warn(`[proactive] retry ${tid}: ${failMsg}`);
          continue;
        }
        desc.status = "failed";
        break;
      } catch (e) {
        const msg = String(e?.message || e);
        desc.error = msg;
        if (isTransientError(msg) && desc.attempts <= opts.maxRetries) {
          console.warn(`[proactive] transient, retry: ${msg}`);
          continue;
        }
        desc.status = "failed";
        blockers.push(`${tid}: ${msg}`);
        console.error(`[proactive] FAIL ${tid}`, e);
        break;
      } finally {
        await saveManifest(batchDir, manifest);
      }
    }
    portOff += 3;
  }
  return { stopped: false, blockers };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const matrix = await loadMatrix();
  const phases = opts.autonomous ? AUTONOMOUS_PHASES : [opts.phase];
  const batchDir = await ensureBatchDir(opts, matrix);

  let manifest = await loadManifest(batchDir);
  const trialList = await buildManifestTrials(batchDir, matrix, phases, manifest.trials || []);
  manifest = {
    created_at: manifest.created_at || new Date().toISOString(),
    autonomous: opts.autonomous,
    phases,
    trials: trialList,
  };
  await saveManifest(batchDir, manifest);

  for (const phaseName of phases) {
    const sample = expandTrials(matrix, phaseName)[0];
    const delivery = await resolveProactiveDelivery(sample.delivery_key, matrix);
    const curl = await curlCheck(delivery.curl_check_url);
    if (!curl.ok) {
      await writeBlocker(
        `${sample.delivery_key} unreachable`,
        `- URL: ${delivery.curl_check_url}\n- curl: ${curl.snippet}\n`,
      );
      console.error(`[proactive] BLOCKED: ${delivery.curl_check_url}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[proactive] ${phaseName} curl OK: ${delivery.curl_check_url}`);

    const result = await runPhaseTrials({
      batchDir,
      manifest,
      matrix,
      opts,
      phaseFilter: phaseName,
    });
    await saveManifest(batchDir, manifest);
    if (result.stopped) return;
  }

  console.log(`\n[proactive] batch_dir=${batchDir}`);
  const done = manifest.trials.filter((t) => t.status === "completed" && t.hard_gate_passed).length;
  console.log(`[proactive] passed=${done}/${manifest.trials.length}`);
  console.log("[proactive] analyze: node scripts/proactive_single_user/analyze.mjs --batchDir=" + batchDir);
  if (opts.autonomous || opts.phase === "phase1_origin_full") {
    const { spawnSync: sp } = await import("node:child_process");
    sp(process.execPath, [path.join(root, "scripts/proactive_single_user/analyze.mjs"), `--batchDir=${batchDir}`, "--writeChapter"], {
      stdio: "inherit",
      cwd: root,
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
