import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const o = {
    server: "",
    traceDir: "scripts/traces/generated",
    outRoot: "results/distributed/p3-real-run",
    /** 每场景独立重复次数；260425 默认 2，repeat10 套件传 10 */
    repeats: 2,
    durationMs: 30000,
    pageSize: 262144,
    worker2Host: "",
    worker2User: "",
    worker2Key: "",
    remoteRepo: "",
    worker3Host: "",
    worker3User: "",
    worker3Key: "",
    worker3Repo: "",
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "server") o.server = v;
    else if (k === "traceDir") o.traceDir = v || o.traceDir;
    else if (k === "outRoot") o.outRoot = v || o.outRoot;
    else if (k === "repeats" || k === "repeat") o.repeats = Math.max(1, Number.parseInt(v || "2", 10));
    else if (k === "durationMs") o.durationMs = Number.parseInt(v || "30000", 10);
    else if (k === "pageSize") o.pageSize = Number.parseInt(v || "262144", 10);
    else if (k === "worker2Host") o.worker2Host = v;
    else if (k === "worker2User") o.worker2User = v;
    else if (k === "worker2Key") o.worker2Key = v;
    else if (k === "remoteRepo") o.remoteRepo = v;
    else if (k === "worker3Host") o.worker3Host = v;
    else if (k === "worker3User") o.worker3User = v;
    else if (k === "worker3Key") o.worker3Key = v;
    else if (k === "worker3Repo") o.worker3Repo = v;
  }
  return o;
}

function runNode(script, args, cwd, env = process.env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...args], { cwd, stdio: "inherit", env });
    p.on("error", () => resolve(1));
    p.on("exit", (c) => resolve(c ?? 1));
  });
}

function runCmdExit(cmd, args, cwd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: "ignore" });
    p.on("error", () => resolve(1));
    p.on("exit", (c) => resolve(c ?? 1));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(__dirname, "..");
  const outRoot = path.isAbsolute(args.outRoot) ? path.normalize(args.outRoot) : path.join(projectRoot, args.outRoot);
  await fs.mkdir(outRoot, { recursive: true });
  const cfgPath = path.join(outRoot, "repeatability-distributed-replay.config.json");
  const outLocalCfg = path.join(outRoot, "distributed-replay.config.json");
  const fallbackCfg = path.join(projectRoot, "scripts", "distributed-replay.config.json");
  const baseCfg = existsSync(outLocalCfg)
    ? JSON.parse(readFileSync(outLocalCfg, "utf8"))
    : existsSync(fallbackCfg)
      ? JSON.parse(readFileSync(fallbackCfg, "utf8"))
      : {};
  const cfg = {
    ssh_user: args.worker2User || baseCfg.ssh_user || "",
    ssh_host: args.worker2Host || baseCfg.ssh_host || "",
    ssh_port: baseCfg.ssh_port ?? 22,
    ssh_key_path: args.worker2Key || baseCfg.ssh_key_path || "",
    remote_repo_path: args.remoteRepo || baseCfg.remote_repo_path || "",
    remote_output_root: baseCfg.remote_output_root || "D:/SparkRuns",
    worker3_ssh_user: args.worker3User || baseCfg.worker3_ssh_user || "",
    worker3_ssh_host: args.worker3Host || baseCfg.worker3_ssh_host || "",
    worker3_ssh_port: baseCfg.worker3_ssh_port || 22,
    worker3_ssh_key_path: args.worker3Key || baseCfg.worker3_ssh_key_path || "",
    worker3_remote_repo_path: args.worker3Repo || baseCfg.worker3_remote_repo_path || "",
    worker3_remote_output_root: baseCfg.worker3_remote_output_root || baseCfg.remote_output_root || "D:/SparkRuns",
    client_server_url: args.server || baseCfg.client_server_url || "http://10.4.158.143:8092",
    upstream_origin: baseCfg.upstream_origin || "http://10.120.17.176:8090",
    r2_public_origin: baseCfg.r2_public_origin || baseCfg.r2_assets_origin || "",
    proxy_port: baseCfg.proxy_port || 8092,
  };

  if (cfg.worker3_ssh_host) {
    const sshArgs = [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-p",
      String(cfg.worker3_ssh_port || 22),
    ];
    if (cfg.worker3_ssh_key_path) sshArgs.push("-i", String(cfg.worker3_ssh_key_path), "-o", "IdentitiesOnly=yes");
    sshArgs.push(`${cfg.worker3_ssh_user}@${cfg.worker3_ssh_host}`, "echo spark-ok");
    const cSsh = await runCmdExit("ssh", sshArgs, projectRoot);
    if (cSsh !== 0) {
      console.warn(
        `[repeatability] 第三机 SSH 不可达（${cfg.worker3_ssh_user}@${cfg.worker3_ssh_host}:${cfg.worker3_ssh_port}），已忽略第三机，仅本机 + worker2。`,
      );
      cfg.worker3_ssh_host = "";
      cfg.worker3_ssh_user = "";
      cfg.worker3_ssh_key_path = "";
      cfg.worker3_remote_repo_path = "";
    }
  }
  await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  const env = { ...process.env, SPARK_DIST_CONFIG: cfgPath };

  const plans = [
    { scenario: "A-baseline", expectedUsers: 1 },
    { scenario: "B-lockstep", expectedUsers: 4 },
    { scenario: "C-nearcohort", expectedUsers: 4 },
    { scenario: "D-divergent", expectedUsers: 4 },
  ];
  const runs = [];
  let hasInvalid = false;
  for (const plan of plans) {
    let successCount = 0;
    let attemptCount = 0;
    const maxAttempts = Math.max(args.repeats, args.repeats * 4);
    while (successCount < args.repeats && attemptCount < maxAttempts) {
      attemptCount += 1;
      const ts = Date.now();
      const runId = `rep-${plan.scenario}-${ts}`;
      const runRoot = path.join(outRoot, runId);
      const proxyLog = path.join(runRoot, "proxy", "proxy.jsonl");
      const summaryPath = path.join(runRoot, "summary", "distributed-summary.json");
      const c1 = await runNode(
        path.join(projectRoot, "scripts", "run-distributed-replay.mjs"),
        [
          `--scenario=${plan.scenario}`,
          "--distributed=1",
          `--durationMs=${args.durationMs}`,
          `--outRoot=${runRoot}`,
          `--runId=${runId}`,
          `--traceBase=/${args.traceDir.replaceAll("\\", "/").replace(/^\/+/, "")}`,
          // 不传 --server：否则会把端口锁死在 client_server_url 的 8092 上，与 run-distributed-replay 内动态端口冲突
          ...(args.server ? [`--server=${args.server}`] : []),
        ],
        projectRoot,
        env,
      );
      const c2 = await runNode(
        path.join(projectRoot, "scripts", "validate-run-coverage.mjs"),
        [`--runDir=${runRoot}`, `--expectedUsers=${plan.expectedUsers}`, `--proxyLog=${proxyLog}`, `--runId=${runId}`],
        projectRoot,
        env,
      );
      const c3 = await runNode(
        path.join(projectRoot, "analysis", "analyze-abc-distributed.mjs"),
        [`--runRoot=${runRoot}`, `--proxyLog=${proxyLog}`, `--out=${summaryPath}`, `--expectedUsers=${plan.expectedUsers}`, `--pageSizes=${args.pageSize}`, `--runId=${runId}`],
        projectRoot,
        env,
      );
      const c3View = await runNode(
        path.join(projectRoot, "scripts", "analyze-viewport-sharing-gain.mjs"),
        [`--runRoot=${runRoot}`],
        projectRoot,
        env,
      );
      if (c3View !== 0) {
        console.warn(`[repeatability] analyze-viewport-sharing-gain exit=${c3View} run_id=${runId}`);
      }
      const c4 = await runNode(
        path.join(projectRoot, "scripts", "export-run-artifacts.mjs"),
        [`--root=${outRoot}`, `--runId=${runId}`, `--out=${path.join(outRoot, "repeatability-exports")}`],
        projectRoot,
        env,
      );
      const c5 = await runNode(
        path.join(projectRoot, "analysis", "analyze-burst-queue-diagnosis.mjs"),
        [`--root=${outRoot}`, `--runIds=${runId}`, "--windowMs=250", `--out=${path.join(runRoot, "summary", "burst_queue.json")}`],
        projectRoot,
        env,
      );
      const cArtifact = await runNode(
        path.join(projectRoot, "scripts", "validate-bcd-run-artifacts.mjs"),
        [`--runDir=${runRoot}`, `--runId=${runId}`],
        projectRoot,
        env,
      );
      const val = JSON.parse(await fs.readFile(path.join(runRoot, "validate-run-coverage.json"), "utf8").catch(() => "{}"));
      const sum = JSON.parse(await fs.readFile(summaryPath, "utf8").catch(() => "{}"));
      const run = (sum.runs || []).find((r) => String(r.run_id) === runId) || {};
      const valid = Boolean(
        c1 === 0 &&
          c2 === 0 &&
          c3 === 0 &&
          c4 === 0 &&
          c5 === 0 &&
          cArtifact === 0 &&
          val.coverage_ok === true &&
          !run?.validity?.run_invalid,
      );

      if (valid) {
        successCount += 1;
        runs.push({
          run_id: runId,
          scenario: plan.scenario,
          exit_codes: {
            run: c1,
            validate: c2,
            analyze: c3,
            viewport_sharing_gain: c3View,
            export: c4,
            burst: c5,
            artifacts: cArtifact,
          },
          valid,
        });
        console.log(
          `[repeatability] ${plan.scenario}: success ${successCount}/${args.repeats} (attempt ${attemptCount}/${maxAttempts}) run_id=${runId}`,
        );
      } else {
        hasInvalid = true;
        console.warn(
          `[repeatability] ${plan.scenario}: invalid attempt ${attemptCount}/${maxAttempts}, will retry run_id=${runId}`,
        );
        await sleep(2000);
      }
    }
    if (successCount < args.repeats) {
      hasInvalid = true;
      console.error(
        `[repeatability] ${plan.scenario}: only ${successCount}/${args.repeats} successful runs after ${attemptCount} attempts`,
      );
    }
  }
  await fs.writeFile(path.join(outRoot, "repeatability-runs.json"), JSON.stringify({ generated_at: new Date().toISOString(), runs }, null, 2), "utf8");
  if (hasInvalid) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

