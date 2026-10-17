/**
 * Hard gate before / after distributed runs — fail fast (no silent zeros / dead Worker2).
 *
 *   node experiments/distributed_hard_gate.mjs --pre-run
 *   node experiments/distributed_hard_gate.mjs --validate-session <session_id>
 *   node experiments/distributed_hard_gate.mjs --validate-last
 *
 * Env: VRC_RESULTS_ROOT, VRC_DISTRIBUTED_CONFIG, same CDN/HPC env as runners.
 * Skip pre-run only for debugging: VRC_SKIP_HARD_GATE=1
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyCdn2EnvFromLab } from "./distributed_lab_cdn2_env.mjs";
import { collectWorker2PushFiles } from "./worker2_push_manifest.mjs";
import { readSummaryCsv, verifyRunPassFailCsv } from "./summary_csv.mjs";
import { validateSessionDataHard, writeValidationReport } from "./data_validation.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SPARK_MAIN = path.resolve(ROOT, "..");
const ARGS = new Set(process.argv.slice(2));
const PRE_RUN = ARGS.has("--pre-run");
const VALIDATE_LAST = ARGS.has("--validate-last");
const VALIDATE_SESSION = (() => {
  const i = process.argv.indexOf("--validate-session");
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1].trim();
  return null;
})();

const MIN_USER_BYTES = Number(process.env.VRC_GATE_MIN_USER_BYTES ?? 4096);
const WORKER2_MIN_BYTES = Number(process.env.VRC_GATE_WORKER2_MIN_BYTES ?? 4096);
const MIN_SESSION_CLASSIFIED_BYTES = Number(process.env.VRC_GATE_MIN_SESSION_BYTES ?? 1_000_000);

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function chunkBytesByUserFromLogs(finalRunDir) {
  const reqs = readJsonl(path.join(finalRunDir, "request_logs.jsonl"));
  /** @type {Record<string, number>} */
  const out = {};
  for (const r of reqs) {
    if (!r.url || !/\.(rad|spz|splat)(\?|#|$)/i.test(String(r.url))) continue;
    const uid = String(r.user_id ?? "").trim();
    if (!uid) continue;
    out[uid] = (out[uid] ?? 0) + Number(r.bytes_sent ?? 0);
  }
  return out;
}

function userHasChunkRequest(finalRunDir, uid) {
  const reqs = readJsonl(path.join(finalRunDir, "request_logs.jsonl"));
  return reqs.some((r) =>
    String(r.user_id ?? "") === uid
    && r.url
    && /\.(rad|spz|splat)(\?|#|$)/i.test(String(r.url)),
  );
}

function fatal(msg) {
  console.error(`[hard-gate] FATAL: ${msg}`);
  process.exit(2);
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* */ }
}

function sshBase(cfg) {
  const o = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=12", "-p", String(cfg.ssh_port ?? 22)];
  if (cfg.ssh_key_path) o.push("-i", String(cfg.ssh_key_path).replace(/\\/g, "/"));
  return o;
}

function loadCfg() {
  const cfgPath = process.env.VRC_DISTRIBUTED_CONFIG
    ? path.resolve(process.env.VRC_DISTRIBUTED_CONFIG)
    : path.join(ROOT, "experiments", "distributed_lab.json");
  if (!fs.existsSync(cfgPath)) fatal(`missing ${cfgPath}`);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  applyCdn2EnvFromLab(cfg);
  return { cfg, cfgPath };
}

function readCsvLoose(file) {
  return readSummaryCsv(file);
}

function verifyRemoteRepo(cfg) {
  const login = `${cfg.ssh_user}@${cfg.ssh_host}`;
  const repoWin = String(cfg.remote_repo_path ?? "").trim().replace(/\//g, "\\");
  const target = `${repoWin}\\vrc-paper\\experiments\\run_experiment.mjs`;
  const cmd = `cmd /c if exist "${target}" (echo REPO_OK) else (echo REPO_MISSING)`;
  const r = spawnSync("ssh", [...sshBase(cfg), login, cmd], { encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (r.status !== 0 || !out.includes("REPO_OK")) {
    fatal(
      `Worker2 remote_repo_path invalid or missing run_experiment.mjs.\n` +
      `  configured: ${cfg.remote_repo_path}\n` +
      `  checked: ${target}\n` +
      `  ssh output: ${out || `(exit ${r.status})`}\n` +
      `  Fix distributed_lab.json remote_repo_path or clone repo on Worker2, then re-run Push-Worker2ExperimentBundle.ps1`,
    );
  }
  console.log(`[hard-gate] remote repo OK: ${target}`);
}

function verifyScpRoundTrip(cfg) {
  const login = `${cfg.ssh_user}@${cfg.ssh_host}`;
  const remoteRoot = String(cfg.remote_results_root ?? cfg.remote_output_root ?? "D:/SparkRuns")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const remoteScript = `${remoteRoot}/_vrc_gate_test.ps1`;
  const localTmp = path.join(os.tmpdir(), `_vrc_gate_test_${process.pid}.ps1`);
  fs.writeFileSync(localTmp, "Write-Output 'gate_ok'\r\nexit 0\r\n", "utf8");
  const scpArgs = [
    ...(cfg.ssh_key_path ? ["-i", String(cfg.ssh_key_path).replace(/\\/g, "/")] : []),
    "-o", "BatchMode=yes",
    "-P", String(cfg.ssh_port ?? 22),
    localTmp,
    `${login}:${remoteScript}`,
  ];
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const scpR = spawnSync("scp", scpArgs, { encoding: "utf8" });
    if (scpR.status === 0) break;
    lastErr = scpR.stderr?.toString()?.trim() || `exit=${scpR.status}`;
    if (attempt < 3) {
      console.log(`[hard-gate] scp probe attempt ${attempt}/3 failed (${lastErr}); retrying…`);
      sleepSync(2000 * attempt);
    } else {
      try { fs.unlinkSync(localTmp); } catch { /* */ }
      fatal(
        `scp to Worker2 failed after 3 attempts (this caused canary1b FAIL_DISTRIBUTED_REMOTE).\n` +
        `  target: ${login}:${remoteScript}\n` +
        `  last error: ${lastErr}\n` +
        `  Check: ssh key, firewall, Worker2 disk space, path writable under ${remoteRoot}`,
      );
    }
  }
  try { fs.unlinkSync(localTmp); } catch { /* */ }
  const remoteWin = remoteScript.replace(/\//g, "\\");
  const runCmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${remoteWin}"`;
  const sshR = spawnSync("ssh", [...sshBase(cfg), login, runCmd], { encoding: "utf8" });
  const out = (sshR.stdout ?? "").trim();
  if (sshR.status !== 0 || !out.includes("gate_ok")) {
    fatal(`Worker2 scp round-trip OK but remote script failed (exit=${sshR.status} out=${out || sshR.stderr})`);
  }
  console.log("[hard-gate] scp + remote PowerShell round-trip OK");
}

function pushManifest(cfgPath) {
  const pushPs1 = path.join(ROOT, "experiments", "Push-Worker2ExperimentBundle.ps1");
  if (!fs.existsSync(pushPs1)) fatal(`missing ${pushPs1}`);
  const files = collectWorker2PushFiles(SPARK_MAIN);
  console.log(`[hard-gate] pushing Worker2 manifest (${files.length} files) via Push-Worker2ExperimentBundle.ps1`);
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", pushPs1, "-ConfigPath", cfgPath],
    { cwd: SPARK_MAIN, env: process.env, encoding: "utf8" },
  );
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if ((r.status ?? 1) !== 0) {
    fatal(`Push-Worker2ExperimentBundle.ps1 failed exit=${r.status ?? 1}`);
  }
}

function runPreRun() {
  if (process.env.VRC_SKIP_HARD_GATE === "1") {
    console.log("[hard-gate] VRC_SKIP_HARD_GATE=1 — skipped");
    return;
  }
  const { cfg, cfgPath } = loadCfg();
  console.log(`[hard-gate] pre-run using ${cfgPath}`);

  const pfScript = path.join(ROOT, "experiments", "dual_cdn_preflight.mjs");
  const pfProfile = String(process.env.VRC_PREFLIGHT_PROFILE ?? "cdn1").trim().toLowerCase();
  let pfOk = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const pf = spawnSync(process.execPath, [pfScript, "--assets-only", "--require-profile", pfProfile], {
      cwd: ROOT,
      env: process.env,
      encoding: "utf8",
    });
    if (pf.status === 0) {
      pfOk = true;
      break;
    }
    if (pf.status === 3 && pfProfile === "dual_cdn") {
      console.log("[hard-gate] preflight dual_cdn: CDN2 unreachable (exit 3) — OK for pre-run gate");
      pfOk = true;
      break;
    }
    console.error(`[hard-gate] preflight attempt ${attempt}/3 profile=${pfProfile} exit=${pf.status ?? 1}`);
    if (pf.stdout) process.stderr.write(pf.stdout);
    if (pf.stderr) process.stderr.write(pf.stderr);
    if (attempt < 3) sleepSync(15000);
  }
  if (!pfOk) {
    fatal(`dual_cdn_preflight --assets-only --require-profile ${pfProfile} failed after 3 attempts`);
  }

  verifyRemoteRepo(cfg);
  verifyScpRoundTrip(cfg);
  pushManifest(cfgPath);
  console.log("[hard-gate] pre-run PASS — safe to start distributed trials");
}

function validateSessionData(resultsRoot, sessionId) {
  const dir = path.join(resultsRoot, "raw", sessionId);
  if (!fs.existsSync(dir)) fatal(`missing raw session dir ${dir}`);

  const statusPath = path.join(dir, "status.json");
  let status = {};
  try { status = JSON.parse(fs.readFileSync(statusPath, "utf8")); } catch { /* */ }
  if (String(status.status ?? "") !== "PASS") {
    fatal(`session ${sessionId} status=${status.status ?? "missing"} (expected PASS)`);
  }

  const perClientPath = path.join(dir, "per_client_metrics.csv");
  if (!fs.existsSync(perClientPath)) fatal(`missing ${perClientPath}`);
  const rows = readCsvLoose(perClientPath).filter((r) => String(r.session_id ?? sessionId) === sessionId || !r.session_id);
  const chunkLogBytes = chunkBytesByUserFromLogs(dir);
  let sessionClassified = 0;
  const sbPath = path.join(dir, "source_breakdown.json");
  if (fs.existsSync(sbPath)) {
    const sb = JSON.parse(fs.readFileSync(sbPath, "utf8"));
    sessionClassified = (sb.hpc_bytes || 0) + (sb.cdn_bytes || 0) + (sb.cdn2_bytes || 0);
  }
  const profileEarly = String(rows[0]?.delivery_profile ?? "").trim().toLowerCase();
  if (profileEarly !== "origin_only" && sessionClassified < MIN_SESSION_CLASSIFIED_BYTES) {
    fatal(
      `session ${sessionId} classified bytes too low (${sessionClassified} < ${MIN_SESSION_CLASSIFIED_BYTES}) — check HPC/CDN fetch`,
    );
  }
  const users = ["u0", "u1", "u2", "u3"];
  for (const uid of users) {
    const row = rows.find((r) => String(r.user_id ?? "").trim() === uid);
    if (!row) fatal(`session ${sessionId} missing per_client row for ${uid}`);
    const dp = String(row.delivery_profile ?? "").trim().toLowerCase();
    if (dp === "legacy" || dp === "") {
      fatal(`session ${sessionId} ${uid} delivery_profile=${row.delivery_profile} (env dropped — fix SSH whitelist)`);
    }
    const cl = String(row.cdn_label ?? "").trim();
    if (!cl) fatal(`session ${sessionId} ${uid} empty cdn_label`);
    const hpc = Number(row.hpc_bytes ?? 0);
    const cdn = Number(row.cdn_bytes ?? 0);
    const cdn2 = Number(row.cdn2_bytes ?? 0);
    const agg = Number(row.aggregate_client_bytes ?? 0);
    const fromLogs = chunkLogBytes[uid] ?? 0;
    const transport = hpc + cdn + cdn2;
    const effective = Math.max(transport, agg, fromLogs);
    const minB = (uid === "u2" || uid === "u3") ? WORKER2_MIN_BYTES : MIN_USER_BYTES;
    const hasChunk = userHasChunkRequest(dir, uid);
    if (effective < minB && !hasChunk) {
      fatal(
        `session ${sessionId} ${uid} no chunk activity effective=${effective} ` +
        `(transport=${transport} aggregate=${agg} chunk_log_bytes=${fromLogs}) min=${minB}`,
      );
    }
    if ((uid === "u2" || uid === "u3") && effective < minB && !hasChunk) {
      fatal(`session ${sessionId} ${uid} Worker2 shard likely failed (no .rad requests in logs)`);
    }
    if ((uid === "u2" || uid === "u3") && String(row.worker_id ?? "") !== "worker2") {
      fatal(`session ${sessionId} ${uid} worker_id=${row.worker_id} (expected worker2)`);
    }
  }

  const dvPath = path.join(dir, "distributed_validation.json");
  if (fs.existsSync(dvPath)) {
    const dv = JSON.parse(fs.readFileSync(dvPath, "utf8"));
    if (!dv.ok) fatal(`distributed_validation.json errors: ${(dv.errors ?? []).join(" | ")}`);
  }

  const profile = String(rows[0]?.delivery_profile ?? "").trim().toLowerCase();
  if (profile === "static_cdn") {
    fatal("static_cdn is deprecated — re-run with vrc_guided_hybrid only");
  }
  if (profile === "vrc_guided_hybrid") {
    const sbPath = path.join(dir, "source_breakdown.json");
    if (fs.existsSync(sbPath)) {
      const sb = JSON.parse(fs.readFileSync(sbPath, "utf8"));
      const classified = (sb.hpc_request_count || 0) + (sb.cdn_request_count || 0) + (sb.cdn2_request_count || 0);
      if (classified === 0) {
        fatal(`session ${sessionId} hybrid run has zero classified chunk requests in source_breakdown`);
      }
    }
  }

  const cfgPath = path.join(dir, "config.json");
  let method = "";
  let canary = "";
  let cdnLabel = "";
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    method = String(cfg.method ?? "");
    canary = String(cfg.canary_rule ?? process.env.VRC_CANARY_RULE ?? "");
    cdnLabel = String(cfg.cdn_label ?? "");
  } catch { /* */ }

  const skipHardData = process.env.VRC_SKIP_DATA_VALIDATION === "1"
    || profile === "origin_only";
  if (!skipHardData) {
    const dataVal = validateSessionDataHard(dir, {
      delivery_profile: profile,
      method,
      canary,
      cdn_label: cdnLabel,
    });
    writeValidationReport(dir, dataVal);
    if (!dataVal.ok) {
      fatal(
        `data_validation failed for ${sessionId} class=${dataVal.experiment_class}: ` +
        `${[...dataVal.global_reasons, ...dataVal.users.flatMap((u) => u.reasons.map((r) => `${u.user_id}:${r}`))].join(" | ")}`,
      );
    }
    console.log(`[hard-gate] data_validation PASS (${dataVal.experiment_class}) valid=${dataVal.valid_clients}/${dataVal.expected_users}`);
  } else {
    console.log(`[hard-gate] skip strict data_validation (origin_only connectivity baseline or VRC_SKIP_DATA_VALIDATION=1)`);
  }

  const canaryScript = path.join(ROOT, "analysis", "validate_canary.mjs");
  const vr = spawnSync(process.execPath, [
    canaryScript,
    "--results-root", resultsRoot,
    "--session", sessionId,
    "--skip-summary-per-client-assert",
  ], { cwd: ROOT, env: process.env, encoding: "utf8" });
  if (vr.status !== 0) {
    console.error(vr.stdout || "");
    console.error(vr.stderr || "");
    fatal(`validate_canary.mjs failed for ${sessionId}`);
  }

  console.log(`[hard-gate] session ${sessionId} data validation PASS`);
}

function main() {
  const resultsRoot = process.env.VRC_RESULTS_ROOT
    ? (path.isAbsolute(process.env.VRC_RESULTS_ROOT)
        ? process.env.VRC_RESULTS_ROOT
        : path.resolve(ROOT, process.env.VRC_RESULTS_ROOT))
    : path.join(ROOT, "results");

  if (PRE_RUN) {
    runPreRun();
    return;
  }

  let sessionId = VALIDATE_SESSION;
  if (VALIDATE_LAST) {
    const pf = path.join(resultsRoot, "summary", "run_pass_fail.csv");
    let rows;
    try {
      rows = verifyRunPassFailCsv(pf, 1);
    } catch (e) {
      fatal(e.message);
    }
    const last = rows[rows.length - 1];
    if (String(last.status ?? "") !== "PASS") {
      fatal(`last run status=${last.status} session=${last.session_id} — fix before continuing`);
    }
    sessionId = String(last.session_id ?? "").trim();
    if (!sessionId) fatal("last run_pass_fail row missing session_id");
  }

  if (!sessionId) {
    fatal("usage: --pre-run | --validate-session <id> | --validate-last");
  }

  validateSessionData(resultsRoot, sessionId);
}

main();
