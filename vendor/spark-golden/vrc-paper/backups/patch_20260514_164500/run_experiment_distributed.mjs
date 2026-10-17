/**
 * VRC two-machine orchestrator: Worker1 runs u0–u1 + Vite + sync; Worker2 runs u2–u3 via SSH.
 * Both shards run **in parallel** (same session_id) so VRC overlap / hybrid decisions see 4 users.
 *
 * Prerequisite: OpenSSH `ssh`/`scp` on PATH; passwordless key to Worker2; same repo on both **or**
 * set **`VRC_DISTRIBUTED_PUSH_TO_WORKER2=1`** (alias: **`VRC_DISTRIBUTED_PUSH_VRC_PAPER=1`**) so this runner **scp** pushes from the orchestrator:
 *   - **`spark-main/vrc-paper/`** (experiments, client_instrument, server, scenarios, …)
 *   - **`spark-main/package.json`** and any present lockfile (**`package-lock.json`**, **`pnpm-lock.yaml`**, **`yarn.lock`**, **`npm-shrinkwrap.json`**)
 *   into **`{remote_repo_path}/`** on Worker2 before Vite starts. Does **not** copy **`node_modules`** (too large); Worker2 must already have **`npm install`** / Playwright there, or run it once after the first clone.
 *
 *   copy experiments/distributed_lab.example.json → experiments/distributed_lab.json
 *   set VRC_RESULTS_ROOT=...
 *   node vrc-paper/experiments/run_experiment_distributed.mjs
 *
 * Env: VRC_DISTRIBUTED_CONFIG, VRC_METHODS, VRC_SCENARIOS, VRC_TRIALS, VRC_DELIVERY_PROFILE, VRC_SUMMARY_APPEND, …
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { mergeDistributedShards, validateDistributedHybrid } from "./vrc_distributed_merge.mjs";
import { applyCdn2EnvFromLab } from "./distributed_lab_cdn2_env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(ROOT, "..");

function log(m) {
  console.log(`[vrc-dist] ${new Date().toISOString()} ${m}`);
}

function loadCfg(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function sshBase(cfg) {
  const o = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-p", String(cfg.ssh_port ?? 22)];
  if (cfg.ssh_key_path) o.push("-i", String(cfg.ssh_key_path).replace(/\\/g, "/"));
  return o;
}

function hybridEnvPassthrough() {
  const keys = [
    "VRC_DELIVERY_PROFILE", "VRC_HPC_ASSET_BASE", "VRC_CDN_ASSET_BASE", "VRC_CDN2_ASSET_BASE",
    "VRC_CDN2_OBJECT_PATH", "VRC_CDN2_OBJECT_PATH_HOBBITON",
    "VRC_CDN_LABEL",
    "VRC_HOT_THRESHOLD", "VRC_CDN_FALLBACK_TO_HPC", "VRC_CAPTURE_MODE", "VRC_HEADLESS",
    "VRC_TRIAL_DURATION_MS", "VRC_SCREENSHOT_DELAY_MS", "VRC_SUMMARY_APPEND",
  ];
  const o = {};
  for (const k of keys) {
    if (process.env[k] != null && String(process.env[k]).length) o[k] = process.env[k];
  }
  return o;
}

function writeCsv(rows, file) {
  if (!rows.length) return;
  const keys = [...new Set(rows.flatMap(Object.keys))];
  const lines = rows.map((r) => keys.map((k) => {
    const v = r[k];
    if (v == null) return "";
    if (typeof v === "string" && (v.includes(",") || v.includes("\""))) return `"${v.replace(/"/g, "\"\"")}"`;
    return String(v);
  }).join(","));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [keys.join(","), ...lines].join("\n"));
}

function readSummaryCsvLoose(file) {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) return [];
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) return [];
  const lines = text.split("\n").filter(Boolean);
  const header = lines[0].split(",").map((h) => h.replace(/^"|"$/g, ""));
  return lines.slice(1).map((line) => {
    const cols = line.split(",").map((c) => c.replace(/^"|"$/g, ""));
    const o = {};
    header.forEach((k, i) => { o[k] = cols[i] ?? ""; });
    return o;
  });
}

function mergeOrWriteSummaryCsv(file, newRows, append) {
  if (!newRows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!append || !fs.existsSync(file) || fs.statSync(file).size === 0) {
    writeCsv(newRows, file);
    return;
  }
  const prev = readSummaryCsvLoose(file);
  writeCsv([...prev, ...newRows], file);
}

function runPrimaryShardAsync(envExtra) {
  const script = path.join(ROOT, "experiments", "run_experiment.mjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...envExtra },
      stdio: "ignore",
      detached: false,
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (e) => {
      log(`PRIMARY spawn error: ${e.message}`);
      resolve(1);
    });
  });
}

function runRemoteShardAsync(cfg, envLines) {
  const login = `${cfg.ssh_user}@${cfg.ssh_host}`;
  const repo = String(cfg.remote_repo_path).replace(/\//g, "\\");
  const remoteScript = `${String(cfg.remote_results_root ?? "D:/SparkRuns").replace(/\\/g, "/")}/_vrc_shard_run.ps1`;

  // Build a .ps1 script with env vars and node invocation
  const psLines = envLines.map((line) => {
    const m = line.match(/^set\s+([^=]+)=(.*)$/i);
    if (m) return `$env:${m[1]} = '${m[2].replace(/'/g, "''")}'`;
    return "";
  }).filter(Boolean);
  psLines.unshift(`$env:PLAYWRIGHT_BROWSERS_PATH = 'D:\\Program Files\\Spark-main'`);
  psLines.push(`Set-Location '${repo}'`);
  psLines.push(`node vrc-paper\\experiments\\run_experiment.mjs *> D:\\SparkRuns\\_vrc_shard_output.log`);
  psLines.push(`exit $LASTEXITCODE`);

  // Write script locally, scp to Worker2, then execute via SSH
  const localTmp = path.join(os.tmpdir(), "_vrc_shard_run.ps1");
  fs.writeFileSync(localTmp, psLines.join("\r\n") + "\r\n", "utf8");

  const scpArgs = [...(cfg.ssh_key_path ? ["-i", String(cfg.ssh_key_path).replace(/\\/g, "/")] : []),
    "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
    "-P", String(cfg.ssh_port ?? 22),
    localTmp, `${login}:${remoteScript}`];
  const scpR = spawnSync("scp", scpArgs, { cwd: REPO_ROOT, stdio: "pipe", env: process.env });
  if (scpR.status !== 0) {
    log(`REMOTE scp script push failed exit=${scpR.status}`);
    return Promise.resolve(1);
  }

  const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${remoteScript.replace(/\//g, "\\")}"`;
  const args = [...sshBase(cfg), login, cmd];
  log(`ssh ${login} (remote shard u2–u3, script file)…`);
  return new Promise((resolve) => {
    const child = spawn("ssh", args, { cwd: REPO_ROOT, stdio: "ignore", env: process.env });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (e) => {
      log(`REMOTE ssh error: ${e.message}`);
      resolve(1);
    });
  });
}

function scpPull(cfg, remotePosixDir, localDir) {
  fs.mkdirSync(localDir, { recursive: true });
  const login = `${cfg.ssh_user}@${cfg.ssh_host}`;
  const port = String(cfg.ssh_port ?? 22);
  const from = `${login}:${remotePosixDir.replace(/\\/g, "/")}`;
  const args = ["-P", port];
  if (cfg.ssh_key_path) args.push("-i", String(cfg.ssh_key_path).replace(/\\/g, "/"));
  args.push("-r", from, localDir);
  log(`scp pull ${from} → ${localDir}`);
  const r = spawnSync("scp", args, { cwd: REPO_ROOT, stdio: "pipe", env: process.env });
  return r.status ?? 1;
}

/** True if orchestrator should scp-push experiment code to Worker2 before trials. */
function pushWorkerBundleEnabled() {
  const a = String(process.env.VRC_DISTRIBUTED_PUSH_TO_WORKER2 ?? "").trim().toLowerCase();
  const b = String(process.env.VRC_DISTRIBUTED_PUSH_VRC_PAPER ?? "").trim().toLowerCase();
  return a === "1" || a === "true" || b === "1" || b === "true";
}

/**
 * Push everything the Worker2 shard runs from disk (besides node_modules): full vrc-paper + repo package manifests.
 * Browser loads instrumented pages from the controller Vite URL; this syncs Node-side scripts + scenario JSON + lockfiles.
 */
function scpPushWorkerExperimentBundle(cfg) {
  if (!pushWorkerBundleEnabled()) return 0;
  const login = `${cfg.ssh_user}@${cfg.ssh_host}`;
  const port = String(cfg.ssh_port ?? 22);
  const remoteBase = String(cfg.remote_repo_path ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!remoteBase) {
    log("FATAL: distributed push requires remote_repo_path in distributed_lab.json");
    return 2;
  }
  const localVrc = path.join(REPO_ROOT, "vrc-paper");
  if (!fs.existsSync(localVrc)) {
    log("FATAL: local spark-main/vrc-paper is missing");
    return 2;
  }
  const keyArgs = [];
  if (cfg.ssh_key_path) keyArgs.push("-i", String(cfg.ssh_key_path).replace(/\\/g, "/"));
  const destParent = `${login}:"${remoteBase}/"`;

  log(`scp push vrc-paper/ → ${login}:${remoteBase}/vrc-paper/ (VRC_DISTRIBUTED_PUSH_TO_WORKER2 or VRC_DISTRIBUTED_PUSH_VRC_PAPER)`);
  const r1 = spawnSync("scp", ["-r", "-P", port, ...keyArgs, localVrc.replace(/\\/g, "/"), destParent], {
    cwd: REPO_ROOT, stdio: "pipe", env: process.env,
  });
  if ((r1.status ?? 1) !== 0) {
    log(`FATAL: scp push vrc-paper failed exit=${r1.status ?? 1}`);
    return r1.status ?? 1;
  }

  const rootFiles = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"];
  for (const f of rootFiles) {
    const lp = path.join(REPO_ROOT, f);
    if (!fs.existsSync(lp)) continue;
    log(`scp push ${f} → ${login}:${remoteBase}/`);
    const r2 = spawnSync("scp", ["-P", port, ...keyArgs, lp.replace(/\\/g, "/"), destParent], {
      cwd: REPO_ROOT, stdio: "pipe", env: process.env,
    });
    if ((r2.status ?? 1) !== 0) {
      log(`FATAL: scp push ${f} failed exit=${r2.status ?? 1}`);
      return r2.status ?? 1;
    }
  }
  log(`[vrc-dist] Worker2 bundle push done — on Worker2 check: ${remoteBase}/vrc-paper/ (and package.json / lockfile next to it)`);
  return 0;
}

function rmTree(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

async function main() {
  const cfgPath = process.env.VRC_DISTRIBUTED_CONFIG
    ? path.resolve(process.env.VRC_DISTRIBUTED_CONFIG)
    : path.join(ROOT, "experiments", "distributed_lab.json");
  if (!fs.existsSync(cfgPath)) {
    log(`FATAL: missing config ${cfgPath} — copy distributed_lab.example.json → distributed_lab.json`);
    process.exit(2);
  }
  const cfg = loadCfg(cfgPath);
  applyCdn2EnvFromLab(cfg);
  const controllerHost = String(cfg.controller_host ?? "").trim();
  if (!controllerHost) {
    log("FATAL: distributed_lab.json needs controller_host (LAN IP of Worker1 / Vite host)");
    process.exit(2);
  }
  const vitePort = Number(cfg.vite_port ?? process.env.VITE_PORT ?? 9200);
  const syncPort = Number(cfg.sync_port ?? process.env.VRC_SYNC_PORT ?? 9201);
  const remoteRoot = String(cfg.remote_results_root ?? cfg.remote_output_root ?? "D:/SparkRuns").replace(/\\/g, "/");

  const pushSt = scpPushWorkerExperimentBundle(cfg);
  if (pushSt !== 0) {
    log("FATAL: Worker2 code sync (scp push) failed — fix network/ssh/path or set VRC_DISTRIBUTED_PUSH_TO_WORKER2=0 (and VRC_DISTRIBUTED_PUSH_VRC_PAPER=0) to skip");
    process.exit(pushSt || 2);
  }

  const RESULTS_ROOT = process.env.VRC_RESULTS_ROOT
    ? (path.isAbsolute(process.env.VRC_RESULTS_ROOT)
        ? process.env.VRC_RESULTS_ROOT
        : path.resolve(ROOT, process.env.VRC_RESULTS_ROOT))
    : path.join(ROOT, "results");
  process.env.VRC_RESULTS_ROOT = RESULTS_ROOT;
  process.env.VITE_PORT = String(vitePort);
  process.env.VRC_SYNC_PORT = String(syncPort);

  // Set worker identity before importing run_experiment.mjs (its top-level guard requires these when VRC_DISTRIBUTED=true)
  process.env.VRC_WORKER_ID = "worker1";
  process.env.VRC_HOST_IP = controllerHost;
  process.env.VRC_USER_INDICES = process.env.VRC_USER_INDICES || "0,1";

  const rw = await import("./run_experiment.mjs");
  log("Starting Vite + sync on controller (orchestrator process)…");
  const viteOk = await rw.startVite();
  if (!viteOk) {
    log("FATAL: Vite failed to start on controller");
    process.exit(1);
  }
  const syncOk = await rw.startSyncServer();
  if (!syncOk) log("WARNING: sync server not fully healthy — continuing");
  const RAW = path.join(RESULTS_ROOT, "raw");
  const SUMMARY = path.join(RESULTS_ROOT, "summary");
  fs.mkdirSync(RAW, { recursive: true });
  fs.mkdirSync(SUMMARY, { recursive: true });

  const METHODS = [...new Set((process.env.VRC_METHODS ?? "Full,Spark-MU,VP-S,NET-S,VRC-V,VRC-N,VRC-O,VRC")
    .split(",").map(s => s.trim()).filter(Boolean))];
  const SCENARIOS = (process.env.VRC_SCENARIOS ?? "nearby,burst_turn,divergent")
    .split(",").map(s => s.trim()).filter(Boolean);
  const TRIALS = Number(process.env.VRC_TRIALS ?? 3);
  const CAPTURE_MODE = (process.env.VRC_CAPTURE_MODE ?? "parallel").toLowerCase();
  const sumAppend = process.env.VRC_SUMMARY_APPEND === "1";
  const deliveryProfile = (process.env.VRC_DELIVERY_PROFILE ?? "").trim() || "legacy";

  log(`Controller host=${controllerHost} vite=${vitePort} sync=${syncPort}`);
  log(`Methods=${METHODS.join(",")} scenarios=${SCENARIOS.join(",")} trials=${TRIALS}`);
  log(`RESULTS_ROOT=${RESULTS_ROOT}`);

  // H2/H5 fix: ensure VRC_CDN_LABEL is set when using static_cdn
  if (deliveryProfile === "static_cdn" && !process.env.VRC_CDN_LABEL) {
    process.env.VRC_CDN_LABEL = "cdn1";
  }

  const passFail = [];
  let runIdx = 0;

  for (const scenario of SCENARIOS) {
    for (const method of METHODS) {
      for (let t = 0; t < TRIALS; t++) {
        runIdx++;
        const sessionId = `${method}_${scenario}_t${t}_${Date.now()}`;
        const primaryDir = path.join(RAW, `_shardwork_${sessionId}_primary`);
        const remotePosix = `${remoteRoot}/raw/_shardwork_${sessionId}_worker`.replace(/\/+/g, "/");
        const remotePull = path.join(RAW, `_shardwork_${sessionId}_worker_pull`);
        const finalDir = path.join(RAW, sessionId);
        rmTree(primaryDir);
        rmTree(remotePull);
        rmTree(finalDir);

        log(`--- Trial ${runIdx}: ${sessionId} (parallel shards) ---`);

        const commonHybrid = hybridEnvPassthrough();
        const common = {
          ...commonHybrid,
          VRC_SINGLE_TRIAL: `${method}:${scenario}:${t}`,
          VRC_SESSION_ID_OVERRIDE: sessionId,
          VRC_RESULTS_ROOT: RESULTS_ROOT,
          VITE_PORT: String(vitePort),
          VRC_SYNC_PORT: String(syncPort),
          VRC_SKIP_LOCAL_SERVERS: "1",
          VRC_DISTRIBUTED: "true",
          VRC_DISTRIBUTED_SHARD_SKIP_SUMMARY: "1",
        };

        const remoteWin = path.join(remoteRoot.replace(/\//g, path.sep), "raw", `_shardwork_${sessionId}_worker`);
        const remoteEnv = [
          `set VRC_RESULTS_ROOT=${remoteRoot.replace(/\//g, "\\")}`,
          `set VRC_SINGLE_TRIAL=${method}:${scenario}:${t}`,
          `set VRC_SESSION_ID_OVERRIDE=${sessionId}`,
          `set VRC_USER_INDICES=2,3`,
          "set VRC_SKIP_LOCAL_SERVERS=1",
          "set VRC_SKIP_SESSION_CONFIGURE=1",
          `set VRC_BROWSER_ORIGIN=http://${controllerHost}:${vitePort}`,
          `set VRC_PUBLIC_PAGE_BASE=http://${controllerHost}:${vitePort}`,
          `set VRC_SYNC_HTTP_HOST=${controllerHost}`,
          `set VRC_RUN_DIR_OVERRIDE=${remoteWin}`,
          "set VRC_WORKER_ID=worker2",
          `set VRC_HOST_IP=${String(cfg.ssh_host ?? "").trim() || controllerHost}`,
          "set VRC_DISTRIBUTED_SHARD_SKIP_SUMMARY=1",
        ];
        for (const [k, v] of Object.entries(commonHybrid)) {
          remoteEnv.push(`set ${k}=${String(v).replace(/&/g, "^&")}`);
        }
        remoteEnv.push("set VRC_DISTRIBUTED=true");
        remoteEnv.push("set VRC_CHROME_PATH=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");

        const primaryEnv = {
          ...common,
          VRC_USER_INDICES: "0,1",
          VRC_BROWSER_ORIGIN: `http://localhost:${vitePort}`,
          VRC_RUN_DIR_OVERRIDE: primaryDir,
          VRC_WORKER_ID: "worker1",
          VRC_HOST_IP: controllerHost,
        };

        // Run sequentially to avoid Windows libuv UV_HANDLE_CLOSING assertion crash
        // when multiple child processes run alongside Vite/sync pipe handles.
        // Start remote first (SSH connect takes time), then primary.
        const remotePromise = runRemoteShardAsync(cfg, remoteEnv);
        await new Promise(r => setTimeout(r, 3000));
        const stPrimary = await runPrimaryShardAsync(primaryEnv);
        const stRemote = await remotePromise;

        if (stPrimary !== 0) {
          log(`PRIMARY shard failed exit=${stPrimary}`);
          passFail.push({
            run: Number(process.env.VRC_RUN_SEQ || runIdx), method, scenario, trial: t, status: "FAIL_DISTRIBUTED_PRIMARY", session_id: sessionId, delivery_profile: deliveryProfile,
          });
          rmTree(primaryDir);
          continue;
        }
        if (stRemote !== 0) {
          log(`REMOTE shard failed exit=${stRemote}`);
          passFail.push({
            run: Number(process.env.VRC_RUN_SEQ || runIdx), method, scenario, trial: t, status: "FAIL_DISTRIBUTED_REMOTE", session_id: sessionId, delivery_profile: deliveryProfile,
          });
          rmTree(primaryDir);
          continue;
        }

        if (scpPull(cfg, remotePosix, remotePull) !== 0) {
          log("FATAL: scp pull failed");
          passFail.push({
            run: Number(process.env.VRC_RUN_SEQ || runIdx), method, scenario, trial: t, status: "FAIL_DISTRIBUTED_SCP", session_id: sessionId, delivery_profile: deliveryProfile,
          });
          rmTree(primaryDir);
          continue;
        }

        let remoteShardDir = remotePull;
        const nested = path.join(remotePull, path.basename(remotePosix));
        if (fs.existsSync(nested)) remoteShardDir = nested;

        const merged = mergeDistributedShards({
          sessionId,
          primaryShardDir: primaryDir,
          remoteShardDir,
          finalRunDir: finalDir,
          resultsRoot: RESULTS_ROOT,
          method,
          scenario,
          trialIdx: t,
          captureMode: CAPTURE_MODE,
          controllerHost,
          workerHost: String(cfg.ssh_host ?? "").trim(),
          canaryRule: (process.env.VRC_CANARY_RULE ?? "").trim(),
        });
        const distVal = validateDistributedHybrid({
          finalRunDir: finalDir,
          controllerHost,
          workerHost: String(cfg.ssh_host ?? "").trim(),
          deliveryProfile,
          canaryRule: (process.env.VRC_CANARY_RULE ?? "").trim(),
        });
        log(`Merged → ${finalDir} status=${merged.status} distributed_validation_ok=${distVal.ok}`);
        if (!distVal.ok) {
          log(`distributed validation errors: ${distVal.errors.join(" | ")}`);
        }
        const st = distVal.ok ? merged.status : `FAIL_DISTRIBUTED_VALIDATION:${distVal.errors[0] ?? "unknown"}`;
        passFail.push({
          run: Number(process.env.VRC_RUN_SEQ || runIdx), method, scenario, trial: t,
          status: st,
          session_id: sessionId,
          delivery_profile: deliveryProfile,
        });
        if (merged.sourceBreakdownRow && merged.perClientMetricRows?.length) {
          mergeOrWriteSummaryCsv(path.join(SUMMARY, "source_breakdown.csv"), [merged.sourceBreakdownRow], sumAppend);
          mergeOrWriteSummaryCsv(path.join(SUMMARY, "per_client_metrics.csv"), merged.perClientMetricRows, sumAppend);
        }
        if (merged.networkSummaryRow) {
          mergeOrWriteSummaryCsv(path.join(SUMMARY, "per_run_metrics.csv"), [merged.networkSummaryRow], sumAppend);
        }
        rmTree(primaryDir);
        rmTree(remotePull);
      }
    }
  }

  mergeOrWriteSummaryCsv(path.join(SUMMARY, "run_pass_fail.csv"), passFail, sumAppend);
  const pass = passFail.filter(r => r.status === "PASS").length;
  await rw.teardown("distributed-complete");
  log(`Done: ${pass}/${passFail.length} PASS → ${path.join(SUMMARY, "run_pass_fail.csv")}`);
  process.exit(pass === passFail.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
