/**
 * Unattended pipeline: 24h → analyze → gate → (auto-fix loop) → vrc dual → validate.
 *
 *   node scripts/run-autonomous-24h-then-vrc-dual.mjs --phase=all --resume --loop
 *   node scripts/run-autonomous-24h-then-vrc-dual.mjs --phase=loop --batchDir=...
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logDir = path.join(root, "260506_distributed_network_benchmark", "_autonomous_pipeline");
const DEFAULT_BATCH = "260506_distributed_network_benchmark/2026-05-20T06-20-11";

function parseArgs(argv) {
  const o = {
    phase: "all",
    batchDir: null,
    resume: false,
    relax24h: false,
    minCompletionPct: 95,
    skipVrc: false,
    loop: false,
    maxLoops: 50,
    maxVrcAttempts: 5,
  };
  for (const a of argv) {
    if (a.startsWith("--phase=")) o.phase = a.slice(8);
    else if (a.startsWith("--batchDir=")) o.batchDir = path.resolve(a.slice(11));
    else if (a === "--resume") o.resume = true;
    else if (a === "--relax24h") o.relax24h = true;
    else if (a === "--loop") o.loop = true;
    else if (a.startsWith("--minCompletionPct=")) o.minCompletionPct = Number(a.slice(19));
    else if (a.startsWith("--maxLoops=")) o.maxLoops = Number(a.slice(11));
    else if (a.startsWith("--maxVrcAttempts=")) o.maxVrcAttempts = Number(a.slice(17));
    else if (a === "--skipVrc") o.skipVrc = true;
  }
  if (o.phase === "loop") {
    o.loop = true;
    o.phase = "all";
  }
  return o;
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(path.join(logDir, "pipeline.log"), `${line}\n`, "utf8");
}

function runNode(script, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    log(`RUN node ${script} ${args.join(" ")}`);
    const child = spawn(process.execPath, [path.join(root, script), ...args], {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => {
      if (code === 0 || allowFail) resolve(code ?? 0);
      else reject(new Error(`exit ${code}: node ${script}`));
    });
    child.on("error", reject);
  });
}

function runPwsh(scriptRel, args = [], { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const ps1 = path.join(root, scriptRel);
    log(`RUN powershell -File ${scriptRel}`);
    const child = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, ...args],
      { cwd: root, stdio: "inherit" },
    );
    child.on("exit", (code) => {
      if (code === 0 || allowFail) resolve(code ?? 0);
      else reject(new Error(`exit ${code}: ${scriptRel}`));
    });
    child.on("error", reject);
  });
}

function runNodeCapture(script, args) {
  const r = spawnSync(process.execPath, [path.join(root, script), ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return { code: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function resolveBatchDir(opts) {
  if (opts.batchDir) return opts.batchDir;
  const base = path.join(root, "260506_distributed_network_benchmark");
  if (!fs.existsSync(base)) return path.join(root, DEFAULT_BATCH);
  const dirs = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name)
    .sort()
    .reverse();
  for (const name of dirs) {
    const p = path.join(base, name, "manifest.json");
    if (fs.existsSync(p)) return path.join(base, name);
  }
  return path.join(root, DEFAULT_BATCH);
}

function loadReadiness(batchDir) {
  const p = path.join(batchDir, "reports", "vrc_dual_readiness.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function phase24h(opts, batchDir) {
  const args = ["--matrix=round1", "--canaryBatch=2026-05-20T05-54-12", `--batchDir=${batchDir}`];
  if (opts.resume) args.push("--resume");
  await runNode("scripts/run_24h_distributed_network_experiment.mjs", args);
  return batchDir;
}

async function phaseAnalyze(batchDir) {
  await runNode("scripts/analyze_distributed_network_results.mjs", [`--batchDir=${batchDir}`]);
}

async function phaseGate(opts, batchDir) {
  const args = [`--batchDir=${batchDir}`, `--minCompletionPct=${opts.minCompletionPct}`];
  if (opts.relax24h) args.push("--relax24h");
  const cap = runNodeCapture("scripts/gate-check-vrc-dual-readiness.mjs", args);
  const report = loadReadiness(batchDir);
  return { ok: cap.code === 0, report, exitCode: cap.code };
}

async function applyAutoFixes(batchDir, report) {
  if (!report?.suggested_actions?.length) return 0;
  let n = 0;
  for (const a of report.suggested_actions) {
    if (!a.auto) continue;
    if (a.id === "resume_24h") {
      log(`AUTO-FIX: ${a.id}`);
      await phase24h({ resume: true }, batchDir);
      n++;
    } else if (a.id === "analyze_batch") {
      log(`AUTO-FIX: ${a.id}`);
      await phaseAnalyze(batchDir);
      n++;
    }
  }
  return n;
}

async function tryPushWorker2() {
  const ps1 = path.join(root, "vrc-paper/experiments/Push-Worker2ExperimentBundle.ps1");
  if (!fs.existsSync(ps1)) return false;
  log("AUTO-FIX: push Worker2 manifest");
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1],
    { cwd: root, encoding: "utf8", stdio: "inherit" },
  );
  return r.status === 0;
}

async function phaseVrcWithRetry(opts) {
  for (let attempt = 1; attempt <= opts.maxVrcAttempts; attempt++) {
    log(`vrc attempt ${attempt}/${opts.maxVrcAttempts}`);
    try {
      const pre = runNodeCapture("vrc-paper/experiments/distributed_hard_gate.mjs", ["--pre-run"]);
      if (pre.code !== 0) {
        log("pre-run failed — try Push-Worker2");
        await tryPushWorker2();
        if (attempt < opts.maxVrcAttempts) continue;
        throw new Error("distributed_hard_gate --pre-run failed");
      }
      await runPwsh("vrc-paper/hybrid_retest.ps1");
      const val = runNodeCapture("vrc-paper/experiments/distributed_hard_gate.mjs", ["--validate-last"]);
      if (val.code === 0) {
        log("vrc hybrid PASS + validate-last OK");
        return true;
      }
      log("validate-last failed — check VRC_RESULTS_ROOT raw/ and data_validation_report");
    } catch (e) {
      log(`vrc attempt failed: ${e?.message || e}`);
      await tryPushWorker2();
    }
    if (attempt < opts.maxVrcAttempts) {
      log("retry vrc after 30s");
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
  return false;
}

async function runLoop(opts) {
  let batchDir = resolveBatchDir(opts);
  for (let i = 1; i <= opts.maxLoops; i++) {
    log(`=== LOOP ${i}/${opts.maxLoops} ===`);

    const manifest = JSON.parse(fs.readFileSync(path.join(batchDir, "manifest.json"), "utf8"));
    const pending = (manifest.trials || []).filter((t) => t.status !== "completed").length;
    if (pending > 0 || i === 1) {
      await phase24h({ ...opts, resume: true }, batchDir);
    }
    await phaseAnalyze(batchDir);
    const gate = await phaseGate(opts, batchDir);

    const canVrc =
      gate.report?.ready_for_vrc_dual
      || gate.report?.ready_for_vrc_dual_hybrid_autostart;

    if (canVrc && !opts.skipVrc) {
      const vrcOk = await phaseVrcWithRetry(opts);
      if (vrcOk) {
        log("PIPELINE SUCCESS: 24h gate + vrc hybrid validated");
        return;
      }
      log("vrc failed after retries — need Claude/manual debug (06_debug_agent)");
      process.exitCode = 1;
      return;
    }

    if (gate.ok) {
      log("gate OK but skipVrc — done");
      return;
    }

    const fixes = await applyAutoFixes(batchDir, gate.report);
    if (fixes === 0) {
      log("NO AUTO-FIX available — stop for agent");
      log(`Read ${path.join(batchDir, "reports/vrc_dual_readiness.md")}`);
      process.exitCode = 1;
      return;
    }
  }
  log(`exhausted maxLoops=${opts.maxLoops}`);
  process.exitCode = 1;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(logDir, { recursive: true });
  log(`phase=${opts.phase} loop=${opts.loop}`);

  if (opts.loop || opts.phase === "loop") {
    await runLoop(opts);
    return;
  }

  let batchDir = resolveBatchDir(opts);

  if (opts.phase === "24h" || opts.phase === "all") {
    batchDir = await phase24h(opts, batchDir);
  }
  if (opts.phase === "analyze" || opts.phase === "all") {
    await phaseAnalyze(batchDir);
  }
  if (opts.phase === "gate" || opts.phase === "all") {
    const gate = await phaseGate(opts, batchDir);
    const canVrc =
      gate.report?.ready_for_vrc_dual || gate.report?.ready_for_vrc_dual_hybrid_autostart;
    if (!canVrc) {
      log("NOT READY — see reports/vrc_dual_readiness.md");
      await applyAutoFixes(batchDir, gate.report);
      process.exitCode = 1;
      return;
    }
  }
  if ((opts.phase === "vrc" || opts.phase === "all") && !opts.skipVrc) {
    const ok = await phaseVrcWithRetry(opts);
    if (!ok) process.exitCode = 1;
  }
  log("pipeline phase complete");
}

main().catch((e) => {
  log(`FATAL ${e?.message || e}`);
  process.exitCode = 2;
});
