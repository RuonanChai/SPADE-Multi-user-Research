/**
 * 自动化重跑 260429_v2（worker2 分布式）。
 *
 * 做三件事：
 * 1) 读取 `scripts/distributed-replay.config.json` 中 worker2 SSH 配置，先做 passwordless SSH 探测；
 * 2) 失败则写 ssh 诊断日志，并尝试运行 `setup-ssh-key-worker2.ps1` 后重试；
 * 3) 通过 `run-bcd-repeatability.mjs` 重跑 A/B/C/D（repeat10）到 outRoot=260429_v2。
 *
 * 如果 worker2 最终仍不可达，会自动开启 `SPARK_LOCAL_FALLBACK_ON_SSH_FAIL=1`
 * 以确保实验能产出数据（但不保证所有请求都真的经过 worker2）。
 *
 * CLI:
 *   node scripts/run-260429_v2-distributed-automation.mjs --outRoot=260429_v2 --repeats=10 --durationMs=90000
 */

import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const defaultCfg = path.join(projectRoot, "scripts", "distributed-replay.config.json");

function parseArgs(argv) {
  const out = {
    outRoot: "260429_v2",
    repeats: 10,
    durationMs: 90_000,
    traceDir: "scripts/traces/generated",
    distConfigPath: "",
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "outRoot") out.outRoot = v || out.outRoot;
    else if (k === "repeats") out.repeats = Math.max(1, Number.parseInt(v || String(out.repeats), 10));
    else if (k === "durationMs") out.durationMs = Math.max(1, Number.parseInt(v || String(out.durationMs), 10));
    else if (k === "traceDir") out.traceDir = v || out.traceDir;
    else if (k === "distConfigPath") out.distConfigPath = v || out.distConfigPath;
  }
  return out;
}

function normKeyPath(p) {
  return p ? String(p).replace(/\\/g, "/") : "";
}

/** SSH 连接选项（不含 user@host 与远端命令）。 */
function sshConnOpts({ keyPath, sshHost, sshPort }) {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-p",
    String(sshPort || 22),
  ];
  const i = normKeyPath(keyPath);
  if (i) args.push("-i", i, "-o", "IdentitiesOnly=yes");
  return args;
}

function sshRemoteArgs(cfgLike, remoteShellLine) {
  const { keyPath, sshUser, sshHost, sshPort } = cfgLike;
  return [...sshConnOpts({ keyPath, sshHost, sshPort }), `${sshUser}@${sshHost}`, remoteShellLine];
}

function sshProbeEchoOk(cfgLike) {
  return sshRemoteArgs(cfgLike, "echo SPARK_WORKER2_SSH_OK");
}

async function runSpawnCapture(cmd, args, cwd, timeoutMs) {
  const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let done = false;

  const killTimer = timeoutMs
    ? setTimeout(() => {
        if (done) return;
        try {
          p.kill("SIGTERM");
        } catch {
          /* */
        }
      }, timeoutMs)
    : null;

  p.stdout.on("data", (d) => {
    stdout += d.toString();
  });
  p.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  const code = await new Promise((resolve) => {
    p.on("exit", (c) => {
      done = true;
      if (killTimer) clearTimeout(killTimer);
      resolve(c ?? 1);
    });
    p.on("error", () => {
      done = true;
      if (killTimer) clearTimeout(killTimer);
      resolve(1);
    });
  });

  return { code, stdout, stderr };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outRoot = path.isAbsolute(args.outRoot) ? path.normalize(args.outRoot) : path.join(projectRoot, args.outRoot);
  await fs.mkdir(outRoot, { recursive: true });
  const logDir = path.join(outRoot, "logs");
  await fs.mkdir(logDir, { recursive: true });

  const cfgPath = args.distConfigPath || defaultCfg;
  if (!existsSync(cfgPath)) throw new Error(`Missing dist config: ${cfgPath}`);
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));

  const sshUser = cfg.ssh_user || "";
  const sshHost = cfg.ssh_host || "";
  const sshKeyPath = cfg.ssh_key_path || "";
  const sshPort = cfg.ssh_port ?? 22;

  if (!sshUser || !sshHost) throw new Error(`Invalid cfg.ssh_user/ssh_host in ${cfgPath}`);

  const sshProbe = async () =>
    runSpawnCapture("ssh", sshProbeEchoOk({ keyPath: sshKeyPath, sshUser, sshHost, sshPort }), projectRoot, 20_000);

  const debugWrite = async (name, content) => {
    await fs.writeFile(path.join(logDir, name), content, "utf8");
  };

  const probe1 = await sshProbe();
  await debugWrite(
    "worker2_ssh_probe_1.txt",
    `[probe1] code=${probe1.code}\n\nSTDOUT:\n${probe1.stdout}\n\nSTDERR:\n${probe1.stderr}\n`,
  );

  let worker2Ok = probe1.code === 0 && /SPARK_WORKER2_SSH_OK/i.test(probe1.stdout + "\n" + probe1.stderr);

  if (!worker2Ok) {
    // 额外写一次 verbose（不依赖顺序，仅用于定位失败原因）
    const verbose = await runSpawnCapture(
      "ssh",
      [...sshConnOpts({ keyPath: sshKeyPath, sshHost, sshPort }), "-vvv", `${sshUser}@${sshHost}`, "echo SPARK_WORKER2_SSH_OK"],
      projectRoot,
      20_000,
    );
    await debugWrite(
      "worker2_ssh_probe_1_verbose.txt",
      `[verbose] code=${verbose.code}\n\nSTDOUT:\n${verbose.stdout}\n\nSTDERR:\n${verbose.stderr}\n`,
    );

    // 如果 key 文件不存在，尝试 run setup 脚本（可能需要密码；若无法无交互则会失败并继续回退）
    const keyExists = sshKeyPath ? existsSync(path.normalize(sshKeyPath)) : false;
    if (!keyExists) {
      console.warn(`[warn] worker2 ssh key not found locally: ${sshKeyPath}; try setup-ssh-key-worker2.ps1`);
      const psArgs = [
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(projectRoot, "scripts", "setup-ssh-key-worker2.ps1"),
        "-RemoteHost",
        sshHost,
        "-RemoteUser",
        sshUser,
      ];
      const rSetup = await runSpawnCapture("powershell", psArgs, projectRoot, 180_000);
      await debugWrite(
        "worker2_setup_attempt.txt",
        `code=${rSetup.code}\n\nSTDOUT:\n${rSetup.stdout}\n\nSTDERR:\n${rSetup.stderr}\n`,
      );
    } else {
      console.warn(`[warn] worker2 ssh key exists, but ssh still failed; skip setup-ssh-key-worker2.ps1`);
    }

    const probe2 = await sshProbe();
    await debugWrite(
      "worker2_ssh_probe_2.txt",
      `[probe2] code=${probe2.code}\n\nSTDOUT:\n${probe2.stdout}\n\nSTDERR:\n${probe2.stderr}\n`,
    );

    worker2Ok = probe2.code === 0 && /SPARK_WORKER2_SSH_OK/i.test(probe2.stdout + "\n" + probe2.stderr);
  }

  const env = { ...process.env };
  if (!worker2Ok) {
    console.warn(`[warn] worker2 ssh still not reachable. Enable local fallback to keep data flowing.`);
    env.SPARK_LOCAL_FALLBACK_ON_SSH_FAIL = "1";
  } else {
    console.log(`[ok] worker2 ssh reachable`);
  }

  // 同步远端仓库（使 worker2 上的 replay-worker / distributed-replay 与本机修复一致）
  const remoteRepo = cfg.remote_repo_path || "";
  if (worker2Ok && remoteRepo) {
    const quotedRepo = String(remoteRepo).replace(/"/g, '""');
    const pullLine = `cd /d "${quotedRepo}" && git pull --ff-only`;
    const pull = await runSpawnCapture("ssh", sshRemoteArgs({ keyPath: sshKeyPath, sshUser, sshHost, sshPort }, pullLine), projectRoot, 120_000);
    await debugWrite(
      "worker2_git_pull.txt",
      `[git pull] code=${pull.code}\n\nSTDOUT:\n${pull.stdout}\n\nSTDERR:\n${pull.stderr}\n`,
    );
    if (pull.code !== 0) console.warn(`[warn] worker2 git pull failed (see logs/worker2_git_pull.txt); continuing anyway`);

    // 非 git 仓库或 pull 失败时，用 scp 同步关键脚本到远端（与分布式 replay-worker 路径一致）。
    const remoteNorm = String(remoteRepo).replace(/\\/g, "/").replace(/\/$/, "");
    const scriptsToSync = ["replay-worker.mjs", "run-distributed-replay.mjs", "run-abc-distributed.mjs"];
    const scpLogs = [];
    for (const fname of scriptsToSync) {
      const localFile = path.join(projectRoot, "scripts", fname);
      if (!existsSync(localFile)) {
        scpLogs.push(`${fname}: skip missing local`);
        continue;
      }
      // Windows：spawn 不把 argv 再走一层 shell，整条 remote 目标放在一个参数里即可承载空格路径。
      const dest = `${sshUser}@${sshHost}:${remoteNorm}/scripts/${fname}`;
      const scpArgs = [
        "-P",
        String(sshPort || 22),
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=30",
        "-o",
        "StrictHostKeyChecking=accept-new",
      ];
      const ki = normKeyPath(sshKeyPath);
      if (ki) scpArgs.push("-i", ki, "-o", "IdentitiesOnly=yes");
      scpArgs.push(localFile, dest);
      const scpR = await runSpawnCapture("scp", scpArgs, projectRoot, 120_000);
      scpLogs.push(
        `${fname}: exit=${scpR.code}\nSTDOUT:\n${scpR.stdout}\nSTDERR:\n${scpR.stderr}`,
      );
      if (scpR.code !== 0) console.warn(`[warn] scp ${fname} failed (see worker2_scp_scripts.txt)`);
    }
    await debugWrite("worker2_scp_scripts.txt", scpLogs.join("\n---\n"));
  }

  // 重跑 260429_v2：A/B/C/D × repeat10
  const durationMs = args.durationMs;
  const repeats = args.repeats;

  const outRootArg = outRoot;
  const runCmd = [
    path.join(projectRoot, "scripts", "run-bcd-repeatability.mjs"),
    `--outRoot=${outRootArg}`,
    `--repeats=${repeats}`,
    `--durationMs=${durationMs}`,
    `--traceDir=${args.traceDir}`,
    // 保持不传 server，避免端口锁死；distributed-replay 会动态端口
  ];

  console.log(`[run] ${runCmd.join(" ")}`);

  // 由于 run-bcd-repeatability 运行时间较长，这里用前台 spawn 直连输出。
  await new Promise((resolve, reject) => {
    const sp = spawn(process.execPath, runCmd, { cwd: projectRoot, env, stdio: "inherit" });
    sp.on("error", reject);
    sp.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`run-bcd-repeatability exit ${c ?? 1}`))));
  });

  await fs.writeFile(
    path.join(outRoot, "automation-status.json"),
    JSON.stringify(
      {
        created_at: new Date().toISOString(),
        outRoot,
        worker2_ssh_ok: worker2Ok,
        durationMs,
        repeats,
        distConfigPath: cfgPath,
        logsDir: logDir,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`[done] automation finished -> ${outRoot}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

