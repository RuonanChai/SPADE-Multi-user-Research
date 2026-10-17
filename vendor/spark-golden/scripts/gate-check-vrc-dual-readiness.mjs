/**
 * After 24h distributed-network batch: decide if lab is ready for vrc-paper dual-machine.
 *
 *   node scripts/gate-check-vrc-dual-readiness.mjs --batchDir=260506_distributed_network_benchmark/2026-05-20T06-20-11
 *   node scripts/gate-check-vrc-dual-readiness.mjs --batchDir=... --minCompletionPct=90
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const o = {
    batchDir: null,
    minCompletionPct: 95,
    relax24h: false,
    outJson: null,
  };
  for (const a of argv) {
    if (a.startsWith("--batchDir=")) o.batchDir = path.resolve(a.slice(11));
    else if (a.startsWith("--minCompletionPct=")) o.minCompletionPct = Number(a.slice(19));
    else if (a === "--relax24h") o.relax24h = true;
    else if (a.startsWith("--outJson=")) o.outJson = path.resolve(a.slice(10));
  }
  if (!o.batchDir) throw new Error("--batchDir required");
  return o;
}

function run(cmd, args, timeoutMs = 20000) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  return { ok: r.status === 0, status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

function loadLab() {
  const p = path.join(root, "vrc-paper/experiments/distributed_lab.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function checkSsh(lab) {
  const login = `${lab.ssh_user}@${lab.ssh_host}`;
  const port = lab.ssh_port ?? 22;
  const args = [
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=12", "-p", String(port),
  ];
  if (lab.ssh_key_path) args.push("-i", String(lab.ssh_key_path).replace(/\\/g, "/"));
  args.push(login, "echo SSH_OK");
  const r = run("ssh", args, 25000);
  return { ok: r.ok, login, detail: r.ok ? r.stdout : r.stderr };
}

function checkWorker2Http(lab, port, label) {
  const login = `${lab.ssh_user}@${lab.ssh_host}`;
  const portNum = lab.ssh_port ?? 22;
  const key = lab.ssh_key_path ? ["-i", String(lab.ssh_key_path).replace(/\\/g, "/")] : [];
  const cmd = `curl -s -o NUL -w "%{http_code}" --connect-timeout 5 http://${lab.controller_host}:${port}/ 2>NUL || echo 000`;
  const args = [
    "-o", "BatchMode=yes", "-p", String(portNum), ...key, login, cmd,
  ];
  const r = run("ssh", args, 30000);
  const code = (r.stdout || "").trim().split("\n").pop();
  const ok = /^[23]\d\d$/.test(code);
  return { ok, http_code: code, label, detail: ok ? "reachable" : r.stderr || r.stdout };
}

function loadManifest(batchDir) {
  return JSON.parse(fs.readFileSync(path.join(batchDir, "manifest.json"), "utf8"));
}

function trialStats(manifest) {
  const trials = manifest.trials || [];
  const total = trials.length;
  const completed = trials.filter((t) => t.status === "completed").length;
  const failed = trials.filter((t) => t.status === "failed").length;
  const pending = total - completed - failed;
  const pct = total ? (100 * completed) / total : 0;
  return { total, completed, failed, pending, completion_pct: pct };
}

function filterTrials(manifest, pred) {
  return (manifest.trials || []).filter(pred);
}

function anyPassing(manifest, pred) {
  const rows = filterTrials(manifest, (t) => t.status === "completed" && t.hard_gate_passed && pred(t));
  return { pass: rows.length > 0, count: rows.length };
}

function readTrialJson(t) {
  if (!t.trial_json || !fs.existsSync(t.trial_json)) return null;
  try {
    return JSON.parse(fs.readFileSync(t.trial_json, "utf8"));
  } catch {
    return null;
  }
}

function buildSuggestedActions(ctx) {
  const { batchDir, stats, ssh, vite, halted, cdn1, opts } = ctx;
  const actions = [];
  if (!opts.relax24h && stats.completion_pct < opts.minCompletionPct) {
    actions.push({
      id: "resume_24h",
      auto: true,
      reason: "24h batch incomplete",
      command: `node scripts/run_24h_distributed_network_experiment.mjs --resume --batchDir=${batchDir}`,
    });
  }
  if (halted) {
    actions.push({
      id: "inspect_halt",
      auto: false,
      reason: "batch halted — read halted.json and reports/run_failures.md",
      command: `type "${path.join(batchDir, "halted.json")}"`,
    });
  }
  if (!ssh.ok) {
    actions.push({
      id: "fix_ssh",
      auto: false,
      reason: "SSH to Worker2 failed",
      command: "node scripts/verify-worker2-connectivity.mjs",
    });
  }
  if (!vite.ok) {
    actions.push({
      id: "vite_or_run_hybrid",
      auto: false,
      reason: "Worker2 cannot reach controller :9200 — hybrid_retest starts Vite 0.0.0.0 on controller",
      command:
        "powershell -ExecutionPolicy Bypass -File vrc-paper/hybrid_retest.ps1  # or npm run dev:streaming-lod with VITE_DEV_HOST=0.0.0.0",
    });
  }
  if (!cdn1.pass && !opts.relax24h) {
    actions.push({
      id: "debug_cdn1",
      auto: false,
      reason: "cdn1_r2 E3 missing measure_rad — assign 02_cdn_agent",
      command: `node scripts/run_24h_distributed_network_experiment.mjs --resume --batchDir=${batchDir}`,
    });
  }
  actions.push({
    id: "analyze_batch",
    auto: true,
    reason: "refresh CSV/reports after any 24h progress",
    command: `node scripts/analyze_distributed_network_results.mjs --batchDir=${batchDir}`,
  });
  return actions;
}

function cdnE3Sanity(manifest, profileId) {
  const rows = filterTrials(
    manifest,
    (t) =>
      t.delivery_profile === profileId
      && t.arm_id === "E3_normal_streaming"
      && t.status === "completed"
      && t.hard_gate_passed,
  );
  for (const t of rows) {
    const j = readTrialJson(t);
    const rad = Number(j?.measure_rad_requests);
    if (Number.isFinite(rad) && rad > 50) return { pass: true, measure_rad: rad, count: rows.length };
  }
  return { pass: false, measure_rad: null, count: rows.length };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const batchDir = opts.batchDir;
  const lab = loadLab();
  const report = {
    generated_at: new Date().toISOString(),
    batch_dir: batchDir,
    ready_for_vrc_dual: false,
    relax_24h: opts.relax24h,
    min_completion_pct: opts.minCompletionPct,
    checks: {},
    blockers: [],
    next_commands: [],
  };

  let halted = false;
  try {
    const h = JSON.parse(fs.readFileSync(path.join(batchDir, "halted.json"), "utf8"));
    halted = true;
    report.checks.halted = { pass: false, reason: h.reason };
    report.blockers.push(`24h batch halted: ${h.reason}`);
  } catch {
    report.checks.halted = { pass: true };
  }

  const ssh = checkSsh(lab);
  report.checks.ssh_worker2 = ssh;
  if (!ssh.ok) report.blockers.push(`SSH failed: ${ssh.detail}`);

  const vite = checkWorker2Http(lab, lab.vite_port ?? 9200, "controller_vite");
  const sync = checkWorker2Http(lab, lab.sync_port ?? 9201, "controller_sync_health");
  report.checks.worker2_reach_controller_vite = vite;
  report.checks.worker2_reach_controller_sync = sync;
  if (!vite.ok) {
    report.blockers.push(
      `Worker2 cannot HTTP ${lab.controller_host}:${lab.vite_port} — start Vite 0.0.0.0 before vrc dual (not dev-only localhost)`,
    );
  }

  const manifest = loadManifest(batchDir);
  const stats = trialStats(manifest);
  report.checks.manifest_stats = stats;
  const completionOk = stats.completion_pct >= opts.minCompletionPct;
  report.checks.completion_pct = {
    pass: opts.relax24h || completionOk,
    required: opts.minCompletionPct,
    actual: stats.completion_pct,
  };
  if (!opts.relax24h && !completionOk) {
    report.blockers.push(`24h incomplete: ${stats.completed}/${stats.total} (${stats.completion_pct.toFixed(1)}%)`);
  }

  const localE3 = anyPassing(manifest, (t) => t.delivery_profile === "local_loopback" && t.arm_id === "E3_normal_streaming");
  const localE8 = anyPassing(manifest, (t) => t.delivery_profile === "local_loopback" && t.arm_id === "E8_pure_render");
  const cdn1 = cdnE3Sanity(manifest, "cdn1_r2");
  const hpc = cdnE3Sanity(manifest, "hpc_server");

  report.checks.local_loopback_E3 = localE3;
  report.checks.local_loopback_E8 = localE8;
  report.checks.cdn1_r2_E3_rad = cdn1;
  report.checks.hpc_server_E3_rad = hpc;

  if (!localE3.pass) report.blockers.push("Missing passing local_loopback E3 trial");
  if (!localE8.pass) report.blockers.push("Missing passing local_loopback E8 trial");
  if (!opts.relax24h && !cdn1.pass) report.blockers.push("Missing passing cdn1_r2 E3 with measure_rad>50");

  const infraOk = ssh.ok && vite.ok;
  const networkOk =
    !halted
    && (opts.relax24h || completionOk)
    && localE3.pass
    && localE8.pass
    && (opts.relax24h || cdn1.pass);

  const onlyViteBlocker =
    report.blockers.length === 1
    && report.blockers[0].includes(String(lab.vite_port ?? 9200));
  report.ready_for_vrc_dual = infraOk && networkOk && report.blockers.length === 0;
  report.ready_for_vrc_dual_hybrid_autostart =
    ssh.ok
    && networkOk
    && (report.ready_for_vrc_dual || onlyViteBlocker);

  report.suggested_actions = buildSuggestedActions({
    batchDir,
    lab,
    stats,
    ssh,
    vite,
    halted,
    localE3,
    localE8,
    cdn1,
    opts,
  });

  report.next_commands = report.ready_for_vrc_dual
    ? [
        "node vrc-paper/experiments/distributed_hard_gate.mjs --pre-run",
        "powershell -ExecutionPolicy Bypass -File vrc-paper/hybrid_retest.ps1",
        "# full 72: vrc-paper/run_autonomous_pipeline_detached.ps1 (after hybrid H1-H4 PASS)",
      ]
    : [
        "node scripts/run_24h_distributed_network_experiment.mjs --resume --batchDir=<batch>",
        "node scripts/analyze_distributed_network_results.mjs --batchDir=<batch>",
        "node scripts/verify-worker2-connectivity.mjs",
        "# fix Worker2->controller:9200: npm run dev:streaming-lod with --host 0.0.0.0 or vrc Vite",
      ];

  const outPath =
    opts.outJson || path.join(batchDir, "reports", "vrc_dual_readiness.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const md = [
    "# VRC dual-machine readiness",
    "",
    `- **ready**: ${report.ready_for_vrc_dual ? "YES" : "NO"}`,
    `- **batch**: \`${batchDir}\``,
    `- **24h completion**: ${stats.completed}/${stats.total} (${stats.completion_pct.toFixed(1)}%)`,
    `- **SSH Worker2**: ${ssh.ok ? "OK" : "FAIL"}`,
    `- **Worker2 → Vite :9200**: ${vite.ok ? "OK" : "FAIL"} (http ${vite.http_code})`,
    `- **local_loopback E3/E8**: ${localE3.pass}/${localE8.pass}`,
    `- **cdn1_r2 E3 measure_rad**: ${cdn1.pass ? "OK" : "FAIL"}`,
    `- **hybrid autostart OK**: ${report.ready_for_vrc_dual_hybrid_autostart ? "YES" : "NO"} (Vite may be started by vrc runner)`,
    "",
    "## Suggested actions",
    ...(report.suggested_actions.length
      ? report.suggested_actions.map(
          (a) => `- **${a.id}** (${a.auto ? "auto" : "manual"}): ${a.reason} → \`${a.command}\``,
        )
      : ["- (none)"]),
    "",
    "## Blockers",
    ...(report.blockers.length ? report.blockers.map((b) => `- ${b}`) : ["- (none)"]),
    "",
    "## Next",
    ...report.next_commands.map((c) => `- \`${c}\``),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(batchDir, "reports", "vrc_dual_readiness.md"), `${md}\n`, "utf8");

  console.log(JSON.stringify(report, null, 2));
  console.log(`\n[gate] wrote ${outPath}`);
  process.exitCode = report.ready_for_vrc_dual ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 2;
});
