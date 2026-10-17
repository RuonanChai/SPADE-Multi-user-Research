import "./distributed_orchestrator_env.mjs";

/**
 * VRC two-machine orchestrator: Worker1 runs u0–u1 + Vite + sync; Worker2 runs u2–u3 via SSH.
 * Both shards run **in parallel** (same session_id) so VRC overlap / hybrid decisions see 4 users.
 *
 * Prerequisite: OpenSSH `ssh`/`scp` on PATH; passwordless key to Worker2; same repo on both **or**
 * set **`VRC_DISTRIBUTED_PUSH_TO_WORKER2=1`** (alias: **`VRC_DISTRIBUTED_PUSH_VRC_PAPER=1`**) so this runner **scp** pushes only the **Worker2 manifest** (see **`experiments/worker2_push_manifest.mjs`**) — typically 3 small files under **`vrc-paper/experiments/`** plus optional root **`package.json`** / lockfile. **Never** `scp -r vrc-paper/`. Browser assets load from Worker1 Vite. Does **not** copy **`node_modules`**; Worker2 must already have **`npm install`** / Playwright.
 *
 *   copy experiments/distributed_lab.example.json → experiments/distributed_lab.json
 *   set VRC_RESULTS_ROOT=...
 *   node vrc-paper/experiments/run_experiment_distributed.mjs
 *
 * Env (distributed orchestrator): **`VRC_DELIVERY_PROFILE` MUST be non-empty**; **`VRC_CDN_LABEL`**
 * is required unless you set **`VRC_CDN_LABEL_BY_USER`** (JSON) — no silent legacy fallback.
 * For same-session dual-CDN static routing: **`VRC_DUAL_CDN_USER_SPLIT=1`**, **`VRC_CDN_LABEL=mixed`**
 * (or any session tag), plus **`VRC_CDN2_ASSET_BASE`**, and u0–u1 → cdn1 / u2–u3 → cdn2 in the runner.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { mergeDistributedShards, validateDistributedHybrid } from "./vrc_distributed_merge.mjs";
import { applyCdn2EnvFromLab } from "./distributed_lab_cdn2_env.mjs";
import { writeSessionPostDigest } from "./session_post_digest.mjs";
import { collectWorker2PushFiles } from "./worker2_push_manifest.mjs";
import {
  appendSummaryCsv,
  buildRunPassFailRow,
  mergeOrWriteSummaryCsv,
  verifyRunPassFailCsv,
  writeSummaryCsv,
} from "./summary_csv.mjs";
import { validateSessionDataHard, writeValidationReport } from "./data_validation.mjs";

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

/**
 * Whitelist ALL VRC_* keys that Worker2 SSH shard + primary child MUST receive from orchestrator env.
 * Only keys present in process.env are forwarded — no silent omission of undeclared keys.
 */
const VRC_DISTRIBUTED_SSH_ENV_WHITELIST = [
  "VRC_DELIVERY_PROFILE",
  "VRC_CDN_LABEL",
  "VRC_DUAL_CDN_USER_SPLIT",
  "VRC_CDN_LABEL_BY_USER",
  "VRC_HPC_ASSET_BASE",
  "VRC_CDN_ASSET_BASE",
  "VRC_CDN2_ASSET_BASE",
  "VRC_CDN2_OBJECT_PATH",
  "VRC_CDN2_OBJECT_PATH_HOBBITON",
  "VRC_HOT_THRESHOLD",
  "VRC_CDN_FALLBACK_TO_HPC",
  "VRC_CAPTURE_MODE",
  "VRC_HEADLESS",
  "VRC_TRIAL_DURATION_MS",
  "VRC_SCREENSHOT_DELAY_MS",
  "VRC_SUMMARY_APPEND",
  "VRC_CANARY_RULE",
  "VRC_USE_GCS_ONLY",
  "VRC_RAD_ASSET_BASE",
  "VRC_RAD_KEY_COIT",
  "VRC_RAD_KEY_HOBBITON",
  "VRC_CHROME_PATH",
  "VRC_SMOKE",
  "VRC_TEST_ID",
  "VRC_CDP_CAPTURE_TIMEOUT_MS",
  "VRC_VIEWPORT_CAPTURE_TIMEOUT_MS",
  "VRC_DATAURL_CAPTURE_TIMEOUT_MS",
  "VRC_SEQ_FPS_WAIT_MS",
  "VRC_SEQ_INTER_USER_MS",
  "VRC_PER_USER_CAPTURE_MS",
  "VRC_CAPTURE_DRAIN_AFTER_BUDGET_MS",
  "VRC_MIN_CHUNKS_READY",
  "VRC_MIN_ASSET_OK_READY",
  "VRC_SPARK_MU_MIN_CHUNKS",
  "VRC_SPARK_MU_MIN_ASSET_OK",
  "VRC_MIN_READY_LUMA_STD",
  "VRC_MIN_CAPTURE_FPS",
  "VRC_LOW_FPS_PROBE_MS",
  "VRC_METHODS",
  "VRC_SCENARIOS",
  "VRC_TRIALS",
  "VRC_CONTROLLER_HOST",
  "VRC_USER_START",
  "VRC_USER_COUNT",
  "VRC_EXPECTED_USERS",
  "VRC_REMOTE_OUTPUT_ROOT",
  "VRC_VITE_PORT",
];

function collectWhitelistedVrcEnvFromProcess() {
  const o = {};
  for (const k of VRC_DISTRIBUTED_SSH_ENV_WHITELIST) {
    const v = process.env[k];
    if (v !== undefined && String(v).trim().length) o[k] = String(v);
  }
  return o;
}

function dualCdnUserSplitEnabled() {
  const v = String(process.env.VRC_DUAL_CDN_USER_SPLIT ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "worker_shards";
}

function assertDistributedOrchestratorEnv() {
  const dp = String(process.env.VRC_DELIVERY_PROFILE ?? "").trim();
  const cl = String(process.env.VRC_CDN_LABEL ?? "").trim();
  const byUser = String(process.env.VRC_CDN_LABEL_BY_USER ?? "").trim();
  const split = dualCdnUserSplitEnabled();
  if (!dp || (!cl && !byUser)) {
    const msg =
      "FATAL: VRC_DELIVERY_PROFILE must be set, and either VRC_CDN_LABEL or VRC_CDN_LABEL_BY_USER " +
      `(per-user JSON map) before launching orchestrator. Got VRC_DELIVERY_PROFILE=${dp === "" ? "[EMPTY]" : JSON.stringify(dp)} ` +
      `VRC_CDN_LABEL=${cl === "" ? "[EMPTY]" : JSON.stringify(cl)} ` +
      `VRC_CDN_LABEL_BY_USER=${byUser ? "[set]" : "[EMPTY]"}. ` +
      "Do NOT rely on silent legacy fallback.";
    console.error(`[vrc-dist] ${msg}`);
    console.error('[vrc-dist] VALIDATION_FAIL: Exiting with code 1 (Debug-Agent hint: propagate env through SSH Worker2 shard).');
    throw new Error(msg);
  }
  if (split && !String(process.env.VRC_CDN2_ASSET_BASE ?? "").trim()) {
    const msg =
      'FATAL: VRC_DUAL_CDN_USER_SPLIT requires VRC_CDN2_ASSET_BASE (second CDN origin for hybrid hot paths on u2/u3).';
    console.error(`[vrc-dist] ${msg}`);
    throw new Error(msg);
  }
}

function escapePsSingleQuoted(s) {
  return String(s).replace(/'/g, "''");
}

/** @param {string} remoteRoot */
function remoteShardPaths(sessionId, remoteRoot) {
  const root = String(remoteRoot).replace(/\\/g, "/").replace(/\/+$/, "");
  const workPosix = `${root}/raw/_shardwork_${sessionId}_worker`;
  const failPosix = `${root}/raw/_remote_fail_${sessionId}`;
  return {
    workPosix,
    workWin: workPosix.replace(/\//g, "\\"),
    failPosix,
    failWin: failPosix.replace(/\//g, "\\"),
    rawPosix: `${root}/raw`,
    rootPosix: root,
  };
}

function sshMkdirWin(cfg, winPath) {
  const login = `${cfg.ssh_user}@${cfg.ssh_host}`;
  const win = String(winPath).replace(/\//g, "\\").replace(/'/g, "''");
  const cmd = `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path '${win}' | Out-Null"`;
  const r = spawnSync("ssh", [...sshBase(cfg), login, cmd], { cwd: REPO_ROOT, stdio: "pipe", encoding: "utf8" });
  if ((r.status ?? 1) !== 0) {
    log(`WARNING: remote mkdir ${win} exit=${r.status} stderr=${(r.stderr ?? "").slice(0, 200)}`);
  }
  return (r.status ?? 1) === 0;
}

function sshReadRemoteFile(cfg, winPath, tailN = 120) {
  const login = `${cfg.ssh_user}@${cfg.ssh_host}`;
  const win = String(winPath).replace(/\//g, "\\").replace(/'/g, "''");
  const cmd = `powershell -NoProfile -Command "if (Test-Path -LiteralPath '${win}') { Get-Content -LiteralPath '${win}' -Tail ${tailN} -ErrorAction SilentlyContinue }"`;
  const r = spawnSync("ssh", [...sshBase(cfg), login, cmd], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

function printRemoteShardDiagBundle(cfg, paths, label = "remote") {
  const files = [
    ["remote_stdout.log", "stdout"],
    ["remote_stderr.log", "stderr"],
    ["remote_env.json", "env"],
    ["remote_exit_code.txt", "exit"],
    ["remote_command.txt", "cmd"],
  ];
  for (const [name, tag] of files) {
    const win = `${paths.workWin}\\${name}`;
    const r = sshReadRemoteFile(cfg, win, 120);
    log(`—— ${label} ${name} (last 120 lines) ——`);
    const body = (r.stdout || r.stderr || "").trim();
    if (body) {
      for (const line of body.split(/\r?\n/)) log(`[${tag}] ${line}`);
    } else {
      log(`[${tag}] (missing or empty)`);
    }
    log(`—— end ${label} ${name} ——`);
  }
}

function scpPullOne(cfg, remotePosixDir, localDir) {
  fs.mkdirSync(localDir, { recursive: true });
  const login = `${cfg.ssh_user}@${cfg.ssh_host}`;
  const from = `${login}:${String(remotePosixDir).replace(/\\/g, "/")}`;
  const args = ["-P", String(cfg.ssh_port ?? 22)];
  if (cfg.ssh_key_path) args.push("-i", String(cfg.ssh_key_path).replace(/\\/g, "/"));
  args.push("-r", from, localDir.replace(/\\/g, "/"));
  const r = spawnSync("scp", args, { cwd: REPO_ROOT, stdio: "pipe", env: process.env });
  return { status: r.status ?? 1, stderr: r.stderr?.toString()?.slice(0, 400) || "" };
}

/**
 * Pull worker shard dir and fallbacks into local remote_debug.
 * @returns {{ ok: boolean, pulledFrom: string, attempts: object[] }}
 */
function pullRemoteDiagnostics(cfg, sessionId, paths, localSessionDir) {
  const debugRoot = path.join(localSessionDir, "remote_debug");
  fs.mkdirSync(debugRoot, { recursive: true });
  const targets = [
    { label: "shard_work", remote: paths.workPosix, local: path.join(debugRoot, "shard_work") },
    { label: "remote_fail", remote: paths.failPosix, local: path.join(debugRoot, "remote_fail") },
    { label: "raw_root", remote: paths.rawPosix, local: path.join(debugRoot, "raw_root") },
    { label: "spark_runs_root", remote: paths.rootPosix, local: path.join(debugRoot, "spark_runs_root") },
  ];
  const attempts = [];
  let pulledFrom = "";
  for (const t of targets) {
    const r = scpPullOne(cfg, t.remote, t.local);
    attempts.push({ label: t.label, remote: t.remote, status: r.status, stderr: r.stderr });
    if (r.status === 0 && !pulledFrom) pulledFrom = t.label;
  }
  fs.writeFileSync(path.join(debugRoot, "pull_attempts.json"), JSON.stringify(attempts, null, 2), "utf8");
  printRemoteShardDiagBundle(cfg, paths, "remote-shard");
  return { ok: attempts.some((a) => a.status === 0), pulledFrom, attempts, debug_dir: debugRoot };
}

function tailLines(text, n = 100) {
  const lines = String(text ?? "").split(/\r?\n/).filter((l) => l.length > 0);
  return lines.slice(-n).join("\n");
}

function readRemoteShardLog(cfg, remoteLogWin) {
  const login = `${cfg.ssh_user}@${cfg.ssh_host}`;
  const remoteWin = remoteLogWin.replace(/\//g, "\\");
  const cmd = `powershell -NoProfile -Command "if (Test-Path '${remoteWin.replace(/'/g, "''")}') { Get-Content -LiteralPath '${remoteWin.replace(/'/g, "''")}' -Tail 120 -ErrorAction SilentlyContinue }"`;
  const r = spawnSync("ssh", [...sshBase(cfg), login, cmd], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

/**
 * Pull remote debug bundle after failed shard.
 * @returns {object} debug meta
 */
function collectRemoteShardDebug(cfg, sessionId, paths, localResultsRoot, exitCode) {
  const localSessionDir = path.join(localResultsRoot, "raw", sessionId);
  fs.mkdirSync(localSessionDir, { recursive: true });
  const pull = pullRemoteDiagnostics(cfg, sessionId, paths, localSessionDir);
  const debugDir = pull.debug_dir;
  let remoteStatusPath = "";
  let remoteClientMetricCount = 0;
  const shardCandidates = [
    path.join(debugDir, "shard_work", path.basename(paths.workPosix)),
    path.join(debugDir, "shard_work"),
  ];
  let shardDir = "";
  for (const c of shardCandidates) {
    if (fs.existsSync(path.join(c, "status.json")) || fs.existsSync(path.join(c, "client_metrics.jsonl"))) {
      shardDir = c;
      break;
    }
  }
  if (shardDir) {
    const statusPath = path.join(shardDir, "status.json");
    if (fs.existsSync(statusPath)) {
      remoteStatusPath = statusPath;
      try {
        fs.writeFileSync(path.join(debugDir, "remote_status.json"), fs.readFileSync(statusPath, "utf8"));
      } catch { /* */ }
    }
    const cmPath = path.join(shardDir, "client_metrics.jsonl");
    if (fs.existsSync(cmPath)) {
      remoteClientMetricCount = fs.readFileSync(cmPath, "utf8").split("\n").filter(Boolean).length;
    }
  }
  const stdoutTail = sshReadRemoteFile(cfg, `${paths.workWin}\\remote_stdout.log`, 120).stdout;
  const meta = {
    remote_exit_code: exitCode,
    remote_error_tail: stdoutTail.slice(-8000),
    remote_status_path: remoteStatusPath,
    remote_client_metric_count: remoteClientMetricCount,
    remote_work_dir: paths.workPosix,
    remote_fail_dir: paths.failPosix,
    scp_pull_ok: pull.ok,
    pulled_from: pull.pulledFrom,
    pull_attempts: pull.attempts,
    debug_dir: debugDir,
  };
  fs.writeFileSync(path.join(debugDir, "remote_debug_meta.json"), JSON.stringify(meta, null, 2));
  log(`REMOTE debug bundle → ${debugDir} scp_any_ok=${pull.ok} pulled_from=${pull.pulledFrom || "none"} client_metrics_lines=${remoteClientMetricCount}`);
  return meta;
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

async function runRemoteShardAsync(cfg, sessionId, shardEnvFlat, paths) {
  const login = `${cfg.ssh_user}@${cfg.ssh_host}`;
  const repo = String(cfg.remote_repo_path).replace(/\//g, "\\");
  const remoteScriptWin = `${paths.rootPosix.replace(/\//g, "\\")}\\_vrc_shard_run_${sessionId}.ps1`;
  const remoteScriptPosix = `${paths.rootPosix}/_vrc_shard_run_${sessionId}.ps1`;

  sshMkdirWin(cfg, paths.workWin);
  sshMkdirWin(cfg, paths.failWin);

  const envB64 = Buffer.from(JSON.stringify(shardEnvFlat, null, 2), "utf8").toString("base64");
  const nodeRel = "vrc-paper\\experiments\\run_experiment.mjs";
  const psLines = [
    `$ErrorActionPreference = 'Continue'`,
    `$workDir = '${escapePsSingleQuoted(paths.workWin)}'`,
    `$failDir = '${escapePsSingleQuoted(paths.failWin)}'`,
    `New-Item -ItemType Directory -Force -Path $workDir,$failDir | Out-Null`,
    `function Write-FailDiag([string]$reason) {`,
    `  $f = @("reason=$reason")`,
    `  $f += "pwd=$((Get-Location).Path)"`,
    `  $f += "whoami=$(whoami)"`,
    `  try { $f += "node=$((node -v) 2>&1 | Out-String).Trim()" } catch { $f += "node=MISSING" }`,
    `  try { $f += "npm=$((npm -v) 2>&1 | Out-String).Trim()" } catch { $f += "npm=MISSING" }`,
    `  foreach ($cp in @('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe')) { if (Test-Path -LiteralPath $cp) { $f += "chrome=$cp"; break } }`,
    `  $repoPath = '${escapePsSingleQuoted(repo)}'`,
    `  $f += "repo_exists=$((Test-Path -LiteralPath $repoPath))"`,
    `  $f += "run_experiment_exists=$((Test-Path -LiteralPath (Join-Path $repoPath '${nodeRel.replace(/\\/g, "\\\\")}')))"`,
    `  $f += "VRC_WORKER_ID=$env:VRC_WORKER_ID"`,
    `  $f += "VRC_HOST_IP=$env:VRC_HOST_IP"`,
    `  $f += "VRC_USER_START=$env:VRC_USER_START"`,
    `  $f += "VRC_USER_COUNT=$env:VRC_USER_COUNT"`,
    `  $f += "VRC_CONTROLLER_HOST=$env:VRC_CONTROLLER_HOST"`,
    `  $f += "VRC_SYNC_PORT=$env:VRC_SYNC_PORT"`,
    `  $f += "VRC_VITE_PORT=$env:VRC_VITE_PORT"`,
    `  $f += "VRC_RESULTS_ROOT=$env:VRC_RESULTS_ROOT"`,
    `  $f += "VRC_REMOTE_OUTPUT_ROOT=$env:VRC_REMOTE_OUTPUT_ROOT"`,
    `  if ($Error.Count -gt 0) { $f += "last_ps_error=$($Error[0].ToString())" }`,
    `  $f | Set-Content -LiteralPath "$failDir\\diag.txt" -Encoding UTF8`,
    `}`,
    `$env:PLAYWRIGHT_BROWSERS_PATH = "$env:LOCALAPPDATA\\ms-playwright"`,
  ];
  const keysSorted = Object.keys(shardEnvFlat).sort();
  for (const k of keysSorted) {
    const v = shardEnvFlat[k];
    if (v === undefined) continue;
    psLines.push(`$env:${k} = '${escapePsSingleQuoted(String(v))}'`);
  }
  psLines.push(
    `[IO.File]::WriteAllText("$workDir\\remote_env.json", [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${envB64}')))`,
    `"${nodeRel}" | Set-Content -LiteralPath "$workDir\\remote_command.txt" -Encoding UTF8`,
    `if (-not (Test-Path -LiteralPath '${escapePsSingleQuoted(repo)}')) { Write-FailDiag 'repo_missing'; exit 2 }`,
    `Set-Location '${escapePsSingleQuoted(repo)}'`,
    `if (-not (Test-Path -LiteralPath '${escapePsSingleQuoted(nodeRel)}')) { Write-FailDiag 'run_experiment_missing'; exit 3 }`,
    `& node ${nodeRel} *> "$workDir\\remote_stdout.log" 2> "$workDir\\remote_stderr.log"`,
    `$code = $LASTEXITCODE`,
    `"$code" | Set-Content -LiteralPath "$workDir\\remote_exit_code.txt" -Encoding ASCII`,
    `if ($code -ne 0) { Write-FailDiag "exit_$code" }`,
    `exit $code`,
  );

  const localTmp = path.join(os.tmpdir(), `_vrc_shard_run_${sessionId}.ps1`);
  fs.writeFileSync(localTmp, psLines.join("\r\n") + "\r\n", "utf8");

  const scpArgs = [...(cfg.ssh_key_path ? ["-i", String(cfg.ssh_key_path).replace(/\\/g, "/")] : []),
    "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
    "-P", String(cfg.ssh_port ?? 22),
    localTmp, `${login}:${remoteScriptPosix}`];
  let scpStatus = 1;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const scpR = spawnSync("scp", scpArgs, { cwd: REPO_ROOT, stdio: "pipe", env: process.env });
    scpStatus = scpR.status ?? 1;
    if (scpStatus === 0) break;
    const scpErr = scpR.stderr?.toString()?.slice(0, 400) || "";
    log(`REMOTE scp script push attempt ${attempt}/3 failed exit=${scpStatus}${scpErr ? ` stderr=${scpErr}` : ""}`);
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  if (scpStatus !== 0) {
    log(`REMOTE scp script push failed after 3 attempts exit=${scpStatus}`);
    return 1;
  }

  const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${remoteScriptWin}"`;
  const args = [...sshBase(cfg), login, cmd];
  log(`ssh ${login} (remote shard u2–u3, workDir=${paths.workPosix})…`);
  return new Promise((resolve) => {
    const child = spawn("ssh", args, { cwd: REPO_ROOT, stdio: "ignore", env: process.env });
    child.on("exit", (code) => {
      const c = code ?? 1;
      if (c !== 0) printRemoteShardDiagBundle(cfg, paths, "remote-shard-failed");
      resolve(c);
    });
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
  args.push("-r", from, localDir.replace(/\\/g, "/"));
  log(`scp pull ${from} → ${localDir}`);
  const r = spawnSync("scp", args, { cwd: REPO_ROOT, stdio: "pipe", env: process.env });
  if (r.status !== 0) {
    const stderr = r.stderr?.toString()?.slice(0, 300) || "";
    log(`scp pull FAILED exit=${r.status} stderr=${stderr}`);
  }
  return r.status ?? 1;
}

/** True if orchestrator should scp-push experiment code to Worker2 before trials. */
function pushWorkerBundleEnabled() {
  const a = String(process.env.VRC_DISTRIBUTED_PUSH_TO_WORKER2 ?? "").trim().toLowerCase();
  const b = String(process.env.VRC_DISTRIBUTED_PUSH_VRC_PAPER ?? "").trim().toLowerCase();
  return a === "1" || a === "true" || b === "1" || b === "true";
}

/** mkdir -p on Worker2 for a posix file path under remoteBase or staging. */
function sshEnsureRemoteParent(cfg, login, posixFilePath) {
  const parent = posixFilePath.replace(/\/[^/]+$/, "");
  const win = parent.replace(/\//g, "\\").replace(/'/g, "''");
  const cmd = `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path '${win}' | Out-Null"`;
  const r = spawnSync("ssh", [...sshBase(cfg), login, cmd], { cwd: REPO_ROOT, stdio: "pipe", env: process.env });
  if ((r.status ?? 1) !== 0) {
    log(`WARNING: remote mkdir may have failed for ${parent} (exit=${r.status}) stderr=${(r.stderr?.toString() ?? "").slice(0, 200)}`);
  }
}

/**
 * Push only Worker2 manifest files (Playwright shard). Pages load from Worker1 Vite.
 * See worker2_push_manifest.mjs — never scp -r the whole vrc-paper/ tree.
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
  let files;
  try {
    files = collectWorker2PushFiles(REPO_ROOT);
  } catch (e) {
    log(`FATAL: ${e.message}`);
    return 2;
  }
  const keyArgs = [];
  if (cfg.ssh_key_path) keyArgs.push("-i", String(cfg.ssh_key_path).replace(/\\/g, "/"));

  const remoteHasSpace = remoteBase.includes(" ");
  const remoteTmp = String(cfg.remote_results_root ?? "D:/SparkRuns").replace(/\\/g, "/").replace(/\/+$/, "") + "/_push_staging";
  const pushRoot = remoteHasSpace ? remoteTmp : remoteBase;

  log(`scp push Worker2 manifest (${files.length} files) → ${login}:${remoteBase}/ (manifest: worker2_push_manifest.mjs)`);

  if (remoteHasSpace) {
    const tmpWin = remoteTmp.replace(/\//g, "\\").replace(/'/g, "''");
    spawnSync("ssh", [...sshBase(cfg), login,
      `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path '${tmpWin}' | Out-Null"`], {
      cwd: REPO_ROOT, stdio: "pipe", env: process.env,
    });
  }

  for (const { rel, local } of files) {
    const remoteFile = `${pushRoot}/${rel}`.replace(/\\/g, "/");
    sshEnsureRemoteParent(cfg, login, remoteFile);
    const dest = `${login}:${remoteFile}`;
    log(`  scp ${rel}`);
    const r = spawnSync("scp", ["-P", port, ...keyArgs, local.replace(/\\/g, "/"), dest], {
      cwd: REPO_ROOT, stdio: "pipe", env: process.env,
    });
    if ((r.status ?? 1) !== 0) {
      const err = (r.stderr?.toString() ?? "").slice(0, 300);
      log(`FATAL: scp push ${rel} failed exit=${r.status ?? 1} stderr=${err}`);
      return r.status ?? 1;
    }
  }

  if (remoteHasSpace) {
    const remoteWin = remoteBase.replace(/\//g, "\\");
    const tmpWin = remoteTmp.replace(/\//g, "\\");
    const moveParts = files.map(({ rel }) => {
      const winRel = rel.replace(/\//g, "\\");
      const parent = winRel.includes("\\") ? winRel.replace(/\\[^\\]+$/, "") : "";
      const mkdir = parent ? `if not exist "${remoteWin}\\${parent}" mkdir "${remoteWin}\\${parent}" 2>NUL & ` : "";
      return `${mkdir}copy /Y "${tmpWin}\\${winRel}" "${remoteWin}\\${winRel}" >NUL 2>&1`;
    });
    const moveCmd = `${moveParts.join(" & ")} & rmdir /S /Q "${tmpWin}" 2>NUL & echo MOVE_OK`;
    const mvR = spawnSync("ssh", [...sshBase(cfg), login, `cmd /c ${moveCmd}`], {
      cwd: REPO_ROOT, stdio: "pipe", env: process.env,
    });
    const mvOut = (mvR.stdout?.toString() ?? "").trim();
    if (!mvOut.includes("MOVE_OK")) {
      log(`WARNING: staging→final move may have partially failed (stdout=${mvOut.slice(0, 200)})`);
    }
  }
  log(`[vrc-dist] Worker2 manifest push done (${files.length} files) — verify ${remoteBase}/vrc-paper/experiments/run_experiment.mjs`);
  return 0;
}

function rmTree(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

async function main() {
  assertDistributedOrchestratorEnv();

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
  const deliveryProfile = String(process.env.VRC_DELIVERY_PROFILE ?? "").trim();
  const cdnLabelEnv = String(process.env.VRC_CDN_LABEL ?? "").trim();
  // Asserted at startup — no silent legacy default.

  log(`Controller host=${controllerHost} vite=${vitePort} sync=${syncPort}`);
  log(`Methods=${METHODS.join(",")} scenarios=${SCENARIOS.join(",")} trials=${TRIALS}`);
  log(`RESULTS_ROOT=${RESULTS_ROOT}`);
  log(`VRC_DELIVERY_PROFILE=${deliveryProfile} VRC_CDN_LABEL=${cdnLabelEnv}`);

  const passFail = [];
  let runIdx = 0;

  for (const scenario of SCENARIOS) {
    for (const method of METHODS) {
      for (let t = 0; t < TRIALS; t++) {
        runIdx++;
        const sessionId = `${method}_${scenario}_t${t}_${Date.now()}`;
        const primaryDir = path.join(RAW, `_shardwork_${sessionId}_primary`);
        const paths = remoteShardPaths(sessionId, remoteRoot);
        const remotePosix = paths.workPosix;
        const remotePull = path.join(RAW, `_shardwork_${sessionId}_worker_pull`);
        const finalDir = path.join(RAW, sessionId);
        rmTree(primaryDir);
        rmTree(remotePull);
        rmTree(finalDir);

        log(`--- Trial ${runIdx}: ${sessionId} (parallel shards) ---`);

        await rw.configureSession(sessionId, method, {
          scenario,
          trial: t,
          ...(deliveryProfile
            ? {
              delivery_profile: deliveryProfile,
              hot_threshold: Number(process.env.VRC_HOT_THRESHOLD ?? 2),
              hpc_asset_base: process.env.VRC_HPC_ASSET_BASE,
              cdn_asset_base: process.env.VRC_CDN_ASSET_BASE,
              ...(process.env.VRC_CDN2_ASSET_BASE ? { cdn2_asset_base: process.env.VRC_CDN2_ASSET_BASE } : {}),
              ...(cdnLabelEnv ? { cdn_label: cdnLabelEnv } : {}),
            }
            : {}),
        });
        log(`[sync] session configured id=${sessionId} profile=${deliveryProfile || "legacy"} cdn_label=${cdnLabelEnv || "(none)"}`);

        const whitelistPass = collectWhitelistedVrcEnvFromProcess();
        const workerHost = String(cfg.ssh_host ?? "").trim();
        /** @type {Record<string,string>} */
        const remoteShardEnv = {
          ...whitelistPass,
          VRC_DISTRIBUTED: "true",
          VRC_WORKER_ID: "worker2",
          VRC_HOST_IP: workerHost,
          VRC_CONTROLLER_HOST: controllerHost,
          VRC_VITE_PORT: String(vitePort),
          VRC_SYNC_PORT: String(syncPort),
          VRC_USER_START: "2",
          VRC_USER_COUNT: "2",
          VRC_USER_INDICES: "2,3",
          VRC_EXPECTED_USERS: "4",
          VRC_RESULTS_ROOT: paths.workPosix,
          VRC_REMOTE_OUTPUT_ROOT: paths.rootPosix,
          VRC_SINGLE_TRIAL: `${method}:${scenario}:${t}`,
          VRC_SESSION_ID_OVERRIDE: sessionId,
          VRC_SKIP_LOCAL_SERVERS: "1",
          VRC_SKIP_SESSION_CONFIGURE: "1",
          VRC_BROWSER_ORIGIN: `http://${controllerHost}:${vitePort}`,
          VRC_PUBLIC_PAGE_BASE: `http://${controllerHost}:${vitePort}`,
          VRC_SYNC_HTTP_HOST: controllerHost,
          VRC_RUN_DIR_OVERRIDE: paths.workWin,
          VRC_DISTRIBUTED_SHARD_SKIP_SUMMARY: "1",
          VITE_PORT: String(vitePort),
        };

        const common = {
          ...whitelistPass,
          VRC_SINGLE_TRIAL: `${method}:${scenario}:${t}`,
          VRC_SESSION_ID_OVERRIDE: sessionId,
          VRC_RESULTS_ROOT: RESULTS_ROOT,
          VITE_PORT: String(vitePort),
          VRC_SYNC_PORT: String(syncPort),
          VRC_SKIP_LOCAL_SERVERS: "1",
          VRC_DISTRIBUTED: "true",
          VRC_DISTRIBUTED_SHARD_SKIP_SUMMARY: "1",
        };

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
        const remoteStartDelayMs = Number(process.env.VRC_DISTRIBUTED_REMOTE_START_DELAY_MS ?? 8000);
        const remoteRetries = Math.max(1, Number(process.env.VRC_DISTRIBUTED_REMOTE_RETRIES ?? 2));
        let stRemote = 1;
        let stPrimary = 1;
        for (let remoteAttempt = 1; remoteAttempt <= remoteRetries; remoteAttempt++) {
          if (remoteAttempt > 1) {
            log(`REMOTE shard retry ${remoteAttempt}/${remoteRetries} after exit=${stRemote}`);
            await new Promise((r) => setTimeout(r, 5000));
          }
          const remotePromise = runRemoteShardAsync(cfg, sessionId, remoteShardEnv, paths);
          if (remoteAttempt === 1) {
            await new Promise((r) => setTimeout(r, remoteStartDelayMs));
            stPrimary = await runPrimaryShardAsync(primaryEnv);
          }
          stRemote = await remotePromise;
          if (stRemote === 0) break;
        }

        const canaryRule = (process.env.VRC_CANARY_RULE ?? "").trim();
        const cdnLabelForRow = cdnLabelEnv;

        if (stPrimary !== 0) {
          log(`PRIMARY shard failed exit=${stPrimary}`);
          passFail.push(buildRunPassFailRow({
            run: Number(process.env.VRC_RUN_SEQ || runIdx), method, scenario, trial: t,
            status: "FAIL_DISTRIBUTED_PRIMARY", session_id: sessionId, delivery_profile: deliveryProfile,
            canary: canaryRule, fail_reason: `PRIMARY exit=${stPrimary}`,
            result_dir: path.join(RAW, sessionId),
          }));
          rmTree(primaryDir);
          continue;
        }
        if (stRemote !== 0) {
          log(`REMOTE shard failed exit=${stRemote}`);
          const remoteDebug = collectRemoteShardDebug(cfg, sessionId, paths, RESULTS_ROOT, stRemote);
          fs.mkdirSync(finalDir, { recursive: true });
          fs.writeFileSync(path.join(finalDir, "remote_debug_summary.json"), JSON.stringify(remoteDebug, null, 2));
          passFail.push(buildRunPassFailRow({
            run: Number(process.env.VRC_RUN_SEQ || runIdx), method, scenario, trial: t,
            status: "FAIL_DISTRIBUTED_REMOTE", session_id: sessionId, delivery_profile: deliveryProfile,
            canary: canaryRule,
            fail_reason: `REMOTE_SHARD_FAILED_EXIT_${stRemote} debug=${remoteDebug.debug_dir}`,
            result_dir: path.join(RAW, sessionId),
          }));
          rmTree(primaryDir);
          continue;
        }

        const scpSt = scpPull(cfg, remotePosix, remotePull);
        if (scpSt !== 0) {
          log(`REMOTE_SHARD_LAUNCH_OR_OUTPUT_FAILURE: scp pull worker dir missing (${remotePosix})`);
          const remoteDebug = collectRemoteShardDebug(cfg, sessionId, paths, RESULTS_ROOT, scpSt);
          fs.mkdirSync(finalDir, { recursive: true });
          fs.writeFileSync(path.join(finalDir, "remote_debug_summary.json"), JSON.stringify(remoteDebug, null, 2));
          passFail.push(buildRunPassFailRow({
            run: Number(process.env.VRC_RUN_SEQ || runIdx), method, scenario, trial: t,
            status: "FAIL_DISTRIBUTED_SCP", session_id: sessionId, delivery_profile: deliveryProfile,
            canary: canaryRule,
            fail_reason: `REMOTE_SHARD_LAUNCH_OR_OUTPUT_FAILURE scp_pull debug=${remoteDebug.debug_dir}`,
            result_dir: path.join(RAW, sessionId),
          }));
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
          canaryRule,
        });
        const distVal = validateDistributedHybrid({
          finalRunDir: finalDir,
          controllerHost,
          workerHost: String(cfg.ssh_host ?? "").trim(),
          deliveryProfile,
          canaryRule,
        });
        log(`Merged → ${finalDir} status=${merged.status} distributed_validation_ok=${distVal.ok}`);
        if (!distVal.ok) {
          log(`distributed validation errors: ${distVal.errors.join(" | ")}`);
        }
        const digestRes = writeSessionPostDigest(finalDir, log);
        let st = distVal.ok ? merged.status : `FAIL_DISTRIBUTED_VALIDATION:${distVal.errors[0] ?? "unknown"}`;
        if (
          process.env.VRC_SESSION_DIGEST_FAIL === "1"
          && st === "PASS"
          && !digestRes.gate_ok
        ) {
          st = `FAIL_SESSION_DIGEST:${(digestRes.digest.hints[0] ?? "gate").slice(0, 200)}`;
        }

        const isConnectivityBaseline = deliveryProfile === "origin_only";
        const dataVal = validateSessionDataHard(finalDir, {
          delivery_profile: deliveryProfile,
          method,
          canary: canaryRule,
          cdn_label: cdnLabelForRow,
        });
        writeValidationReport(finalDir, dataVal);
        if (st === "PASS" && !dataVal.ok && !isConnectivityBaseline) {
          const reasons = [
            ...dataVal.global_reasons,
            ...dataVal.users.flatMap((u) => u.reasons.map((r) => `${u.user_id}:${r}`)),
          ];
          st = `FAIL_DATA_VALIDATION:${reasons[0] ?? "invalid_metrics"}`;
          log(`data validation FAIL: ${reasons.join(" | ")}`);
        } else if (st === "PASS" && isConnectivityBaseline) {
          log(`connectivity baseline (origin_only): validation class=${dataVal.experiment_class} valid=${dataVal.valid_clients}/${dataVal.expected_users} warnings only`);
        }

        passFail.push(buildRunPassFailRow({
          run: Number(process.env.VRC_RUN_SEQ || runIdx), method, scenario, trial: t,
          status: st,
          session_id: sessionId,
          delivery_profile: deliveryProfile,
          canary: canaryRule,
          fail_reason: st === "PASS" ? "" : st,
          result_dir: finalDir,
        }));
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

  const pfPath = path.join(SUMMARY, "run_pass_fail.csv");
  if (sumAppend) {
    appendSummaryCsv(pfPath, passFail);
  } else {
    writeSummaryCsv(passFail, pfPath);
  }
  try {
    verifyRunPassFailCsv(pfPath, passFail.length > 0 ? 1 : 0);
  } catch (e) {
    log(`FATAL: run_pass_fail.csv verify failed: ${e.message}`);
    await rw.teardown("distributed-complete");
    process.exit(2);
  }
  const pass = passFail.filter((r) => r.status === "PASS" && String(r.pass).toLowerCase() === "true").length;
  await rw.teardown("distributed-complete");
  log(`Done: ${pass}/${passFail.length} PASS → ${pfPath} (${verifyRunPassFailCsv(pfPath).length} row(s) on disk)`);
  const continueOnFail = process.env.VRC_CONTINUE_ON_FAIL === "1";
  if (continueOnFail && passFail.length > 0) {
    log(`VRC_CONTINUE_ON_FAIL=1 — matrix attempted ${passFail.length} trial(s), exit 0 for orchestrator resume`);
    process.exit(0);
  }
  process.exit(pass === passFail.length && passFail.length > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
