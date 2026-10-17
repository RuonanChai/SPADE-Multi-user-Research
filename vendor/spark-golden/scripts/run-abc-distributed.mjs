import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

let sshCommand = "ssh";
let scpCommand = "scp";

function resolveBinary(name) {
  if (name === "ssh" && process.env.SPARK_SSH) return process.env.SPARK_SSH;
  if (name === "ssh" && process.env.GIT_SSH) return process.env.GIT_SSH;
  if (name === "scp" && process.env.SPARK_SCP) return process.env.SPARK_SCP;
  if (process.platform !== "win32") return name;
  const wherePath =
    process.env.SystemRoot && existsSync(path.join(process.env.SystemRoot, "System32", "where.exe"))
      ? path.join(process.env.SystemRoot, "System32", "where.exe")
      : "where";
  try {
    const out = execFileSync(wherePath, [name], { encoding: "utf8" });
    const first = out.trim().split(/\r?\n/)[0];
    if (first && existsSync(first)) return first;
  } catch {
    /* ignore */
  }
  return name;
}

function parseArgs(argv) {
  const out = {
    server: "http://10.4.158.143:8090",
    remoteHost: "10.4.146.68",
    remoteUser: "柴若楠",
    /** Worker2 上的仓库根目录（与「本机 localPath / --localPath」对应，勿填本机路径）。 */
    remotePath: "D:/Program Files/Spark-main",
    /** 用于 ssh / scp 的登录名，须 ASCII。覆盖 env SPARK_SSH_USER；不填时退化为 remoteUser（易错）。 */
    sshUser: process.env.SPARK_SSH_USER || "",
    localPath: process.cwd(),
    durationMs: 90000,
    outDir: "results/distributed",
    proxyOrigin: "http://127.0.0.1:8080",
    requireRemote: false,
    /** Optional identity file for passwordless ssh (e.g. .ssh/id_ed25519_spark_bench) */
    sshIdentity: "",
    proxyLog: "",
    analysisOut: "",
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "server") out.server = v || out.server;
    else if (k === "remoteHost") out.remoteHost = v || out.remoteHost;
    else if (k === "remoteUser") out.remoteUser = v || out.remoteUser;
    else if (k === "remotePath") out.remotePath = v || out.remotePath;
    else if (k === "localPath") out.localPath = v || out.localPath;
    else if (k === "durationMs") out.durationMs = Number.parseInt(v || "90000", 10);
    else if (k === "outDir") out.outDir = v || out.outDir;
    else if (k === "proxyOrigin") out.proxyOrigin = v || out.proxyOrigin;
    else if (k === "requireRemote" || k === "noFallback") out.requireRemote = v === "1" || v === "true" || v === "yes";
    else if (k === "sshUser") out.sshUser = v;
    else if (k === "sshIdentity") out.sshIdentity = v;
    else if (k === "proxyLog") out.proxyLog = v;
    else if (k === "analysisOut") out.analysisOut = v;
  }
  if (process.env.SPARK_SERVER) out.server = process.env.SPARK_SERVER;
  if (process.env.SPARK_REMOTE_HOST) out.remoteHost = process.env.SPARK_REMOTE_HOST;
  if (process.env.SPARK_REMOTE_USER) out.remoteUser = process.env.SPARK_REMOTE_USER;
  if (process.env.SPARK_REMOTE_PATH) out.remotePath = process.env.SPARK_REMOTE_PATH;
  if (process.env.SPARK_LOCAL_PATH) out.localPath = process.env.SPARK_LOCAL_PATH;
  if (process.env.SPARK_OUT_DIR) out.outDir = process.env.SPARK_OUT_DIR;
  if (process.env.SPARK_DURATION_MS) out.durationMs = Number.parseInt(process.env.SPARK_DURATION_MS, 10);
  if (process.env.SPARK_SSH_IDENTITY) out.sshIdentity = process.env.SPARK_SSH_IDENTITY;
  if (process.env.SPARK_SSH_USER) out.sshUser = process.env.SPARK_SSH_USER;
  if (process.env.SPARK_PROXY_LOG) out.proxyLog = process.env.SPARK_PROXY_LOG;
  if (process.env.SPARK_ANALYSIS_OUT) out.analysisOut = process.env.SPARK_ANALYSIS_OUT;
  if (process.env.SPARK_REQUIRE_REMOTE) out.requireRemote = /^(1|true|yes)$/i.test(process.env.SPARK_REQUIRE_REMOTE);
  return out;
}

function loginForSsh(a) {
  return a.sshUser || a.remoteUser;
}

function run(cmd, args, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: "inherit", shell: false });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

function runCapture(cmd, args, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || stdout))));
  });
}

/** OpenSSH for Windows accepts C:/x/y for -i; backslashes in argv can mangle the path. */
function normalizeSshIdentity(identity) {
  if (!identity) return identity;
  return process.platform === "win32" ? identity.replace(/\\/g, "/") : identity;
}

/** Remote cmd: forward slashes in paths to avoid spurious cmd escapes. */
function toRemoteCmdPath(p) {
  if (!p) return p;
  return p.replace(/\\/g, "/");
}

/**
 * 远端应写入的路径：本机 outDir 若在 localPath 下，则按相同相对路径挂到 remotePath（与 Worker1/Worker2 不同盘符、不同根时必需）。
 * 例: local D:/a/proj + outDir D:/a/proj/260424_v2/logs/runs, remote D:/b/clone → D:/b/clone/260424_v2/logs/runs
 */
function toRemoteOutDirLocalPath({ localPath, remotePath, outDir }) {
  const base = path.resolve(localPath);
  const outAbs = path.resolve(outDir);
  const rel = path.relative(base, outAbs);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return toRemoteCmdPath(path.join(remotePath, rel));
  }
  return toRemoteCmdPath(outAbs);
}

/** Windows cmd: 路径含空格时给 `cd` / 参数加双引号。 */
function quoteCmdPathForCd(p) {
  const x = toRemoteCmdPath(p);
  if (!x) return '""';
  if (/[ \t&()[\]^]/.test(x)) {
    return `"${x.replace(/"/g, '""')}"`;
  }
  return x;
}

/** 无人值守：免 yes/no 指纹、免 BatchMode 密码。设 SPARK_SSH_STRICT_HOSTS=1 则走 known_hosts 严格模式（可能首次需你手动连一次）。 */
function nonInteractiveSshOpts() {
  const a = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=12"];
  if (process.env.SPARK_SSH_STRICT_HOSTS !== "1") {
    a.push("-o", "StrictHostKeyChecking=accept-new");
  }
  return a;
}

function sshBaseArgs(identity) {
  const base = [...nonInteractiveSshOpts()];
  const i = normalizeSshIdentity(identity);
  if (i) {
    base.push("-i", i, "-o", "IdentitiesOnly=yes");
  }
  return base;
}

function scpNonInteractiveArgs(identity) {
  const out = ["-r", ...nonInteractiveSshOpts()];
  const i = normalizeSshIdentity(identity);
  if (i) {
    out.push("-i", i, "-o", "IdentitiesOnly=yes");
  }
  return out;
}

/** 在 Worker2 上预建与 outDir 对应的路径（同相对路径，挂到 remotePath）。 */
async function ensureRemoteOutDirOnWorker(args) {
  if (!args.requireRemote) return;
  const rel = path.relative(path.resolve(args.localPath), path.resolve(args.outDir));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
  const remoteOut = path.join(args.remotePath, rel);
  const script = `require("node:fs").mkdirSync(${JSON.stringify(remoteOut)}, { recursive: true })`;
  const remoteArg = "node -e " + JSON.stringify(script);
  const t = `${loginForSsh(args)}@${args.remoteHost}`;
  try {
    await runCapture(sshCommand, sshBaseArgs(args.sshIdentity).concat([t, remoteArg]), args.localPath);
    console.log(`[remote] ensure out: ${toRemoteCmdPath(path.normalize(remoteOut))}`);
  } catch (e) {
    console.warn(`[warn] 远端预建 outDir: ${e.message}`);
  }
}

/** scp 不可用时，经 ssh 在远端打 tar 流，本机解到 <runs>/<runId>/。 */
async function pullWithTarFromRemote(args, rBase, id, out) {
  const t = `${loginForSsh(args)}@${args.remoteHost}`;
  const rBaseQ = quoteCmdPathForCd(rBase);
  const remoteCmd = `cd /d ${rBaseQ} && C:/Windows/System32/tar.exe -cf - ${id}/remote 2>NUL`;
  const destParent = path.join(path.resolve(out), id);
  await fs.mkdir(destParent, { recursive: true });
  const a = sshBaseArgs(args.sshIdentity).concat([t, remoteCmd]);
  const tBin = existsSync("C:\\Windows\\System32\\tar.exe") ? "C:\\Windows\\System32\\tar.exe" : "tar";
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    };
    const ok = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const c = spawn(sshCommand, a, { cwd: args.localPath, stdio: ["ignore", "pipe", "pipe"] });
    const x = spawn(tBin, ["-xf", "-", "-C", destParent], { stdio: ["pipe", "ignore", "pipe"] });
    let tErr = "";
    if (!c.stdout || !x.stdin) {
      fail(new Error("ssh/tar: stdio 管道不可用"));
      return;
    }
    c.stderr.on("data", (d) => {
      process.stderr.write(d);
    });
    if (x.stderr) x.stderr.on("data", (d) => (tErr += d.toString()));
    c.stdout.pipe(x.stdin);
    c.on("error", fail);
    x.on("error", fail);
    c.on("exit", (code) => {
      if (code != null && code !== 0) {
        x.stdin?.end();
        fail(new Error(`ssh ${code}`));
      }
    });
    x.on("exit", (code) => (code === 0 ? ok() : fail(new Error(tErr || `tar ${code}`))));
  });
}

/** 将 Worker2 上已重映射的 outDir 里各次 run 的 `remote` 子目录拉回本机，供 analyze 扫到 user2/3 的 client JSON。 */
async function pullRemoteClientTrees(args, runIds) {
  if (!args.requireRemote) return;
  const rBase = toRemoteOutDirLocalPath({
    localPath: args.localPath,
    remotePath: args.remotePath,
    outDir: args.outDir,
  });
  const out = path.resolve(args.outDir);
  for (const id of runIds) {
    if (id === "A-baseline" || !id) continue;
    const from = `${loginForSsh(args)}@${args.remoteHost}:${rBase.replace(/\/$/, "")}/${id}/remote`
      .replace(/\\/g, "/");
    const localDest = path.join(out, id, "remote");
    try {
      await fs.mkdir(localDest, { recursive: true });
      await run(scpCommand, scpNonInteractiveArgs(args.sshIdentity).concat([from, localDest]), args.localPath);
      console.log(`[remote pull] scp ${id}/remote -> ${localDest}`);
    } catch (e1) {
      console.warn(`[warn] scp 失败, 回退 tar: ${e1.message}`);
      try {
        await pullWithTarFromRemote(args, rBase, id, out);
        console.log(`[remote pull] tar ${id}/remote -> ${path.join(out, id, "remote")}`);
      } catch (e2) {
        console.warn(`[warn] 未能拉回 ${id}/remote: ${e2.message}（将缺少远端 client JSON）`);
      }
    }
  }
}

async function runScenario(args, scenarioId, workload, localUsers, remoteUsers) {
  const runId = `${scenarioId}-${Date.now()}`;
  const startAt = Date.now() + 20000;
  const rPath = quoteCmdPathForCd(args.remotePath);
  const oDir = toRemoteOutDirLocalPath({
    localPath: args.localPath,
    remotePath: args.remotePath,
    outDir: args.outDir,
  });
  const oDirArg = /[ \t&()[\]^]/.test(oDir) ? `"${oDir.replace(/"/g, '""')}"` : oDir;
  const outLocal = path.join(args.outDir, runId);
  const localArgs = [
    "scripts/replay-worker.mjs",
    `--server=${args.server}`,
    "--page=/examples/hello-world/index.html",
    `--workload=${workload}`,
    `--runId=${runId}`,
    `--users=${localUsers.join(",")}`,
    `--startAtMs=${startAt}`,
    `--durationMs=${args.durationMs}`,
    `--outDir=${outLocal}`,
    "--outSlot=local",
    "--machineId=local",
  ];
  const remoteCmd = [
    `cd /d ${rPath}`,
    `node scripts/replay-worker.mjs --server=${args.server} --page=/examples/hello-world/index.html --workload=${workload} --runId=${runId} --users=${remoteUsers.join(",")} --startAtMs=${startAt} --durationMs=${args.durationMs} --outDir=${oDirArg} --outSlot=remote --machineId=remote`,
  ].join(" && ");

  const localPromise = run("node", localArgs, args.localPath);
  const sshArgs = sshBaseArgs(args.sshIdentity).concat([`${loginForSsh(args)}@${args.remoteHost}`, remoteCmd]);
  let remotePromise = Promise.resolve();
  let fallbackLocalPromise = Promise.resolve();
  try {
    remotePromise = run(sshCommand, sshArgs, args.localPath);
    await Promise.all([localPromise, remotePromise]);
  } catch (error) {
    if (args.requireRemote) {
      console.error(`[fatal] requireRemote=1, remote failed for ${scenarioId}: ${error.message}`);
      throw error;
    }
    console.warn(`[warn] remote worker unavailable, fallback to local users for ${scenarioId}: ${error.message}`);
    const fallbackArgs = [
      "scripts/replay-worker.mjs",
      `--server=${args.server}`,
      "--page=/examples/hello-world/index.html",
      `--workload=${workload}`,
      `--runId=${runId}`,
      `--users=${remoteUsers.join(",")}`,
      `--startAtMs=${startAt}`,
      `--durationMs=${args.durationMs}`,
      `--outDir=${outLocal}`,
      "--outSlot=local",
      "--machineId=local-fallback",
    ];
    fallbackLocalPromise = run("node", fallbackArgs, args.localPath);
    await Promise.all([localPromise.catch(() => {}), fallbackLocalPromise]);
  }
  return runId;
}

async function checkRemotePath(args) {
  if (!args.requireRemote) return;
  const rPath = quoteCmdPathForCd(args.remotePath);
  const preCmd = `cd /d ${rPath} && (if exist package.json (node -p process.version) else (echo REMOTE_ERROR_no_package&exit 1))`;
  const sshTarget = `${loginForSsh(args)}@${args.remoteHost}`;
  try {
    const { stdout } = await runCapture(sshCommand, sshBaseArgs(args.sshIdentity).concat([sshTarget, preCmd]), args.localPath);
    if (stdout) console.log(`[remote] node on worker: ${String(stdout).trim()}`);
  } catch (e) {
    const hintGbk = " 若错误信息为乱码，在 cmd 中多为「系统找不到指定的路径」: 对方机器上无此目录。 ";
    const showPath = toRemoteCmdPath(args.remotePath);
    console.error(
      `[fatal] 无法在远端进入 ${showPath} 或缺少 package.json。` +
        ` 在 Worker2 上准备仓库（--remotePath= 是 Worker2 上含 package.json 的根，勿填本机 D:/Program/spark-main/... 路径）。` +
        `  自测: ssh -i <key> ${sshTarget} "cd /d ${rPath} && node -v"\n` +
        hintGbk +
        `原始: ${e.message}`,
    );
    throw e;
  }
}

async function main() {
  sshCommand = resolveBinary("ssh");
  scpCommand = resolveBinary("scp");
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(args.outDir, { recursive: true });
  await checkRemotePath(args);
  await ensureRemoteOutDirOnWorker(args);

  // checks 1/2: fetch coverage + cache policy with single user
  const abl = path.join(args.outDir, "A-baseline");
  await run("node", [
    "scripts/replay-worker.mjs",
    `--server=${args.server}`,
    "--page=/examples/hello-world/index.html",
    "--workload=lockstep",
    "--runId=A-baseline",
    "--users=user0",
    `--startAtMs=${Date.now() + 5000}`,
    "--durationMs=30000",
    `--outDir=${abl}`,
    "--outSlot=local",
    "--machineId=local",
  ], args.localPath);

  const runs = ["A-baseline"];
  runs.push(await runScenario(args, "B-lockstep", "lockstep", ["user0", "user1"], ["user2", "user3"]));
  runs.push(await runScenario(args, "C-nearcohort", "near-cohort", ["user0", "user1"], ["user2", "user3"]));
  runs.push(await runScenario(args, "D-divergent", "divergent", ["user0", "user1"], ["user2", "user3"]));

  await pullRemoteClientTrees(args, runs);

  const proxyLog = args.proxyLog || path.join("proxy", "proxy-logs.jsonl");
  const analysisOut = args.analysisOut || path.join("analysis", "distributed-summary.json");
  const analysisPath = path.isAbsolute(analysisOut) ? analysisOut : path.join(args.localPath, analysisOut);
  const proxyPath = path.isAbsolute(proxyLog) ? proxyLog : path.join(args.localPath, proxyLog);

  await run(
    "node",
    [
      "analysis/analyze-abc-distributed.mjs",
      `--runRoot=${args.outDir}`,
      `--proxyLog=${proxyPath}`,
      `--out=${analysisPath}`,
      "--pageSizes=131072,262144,524288",
    ],
    args.localPath,
  );

  const summary = JSON.parse(await fs.readFile(analysisPath, "utf8"));
  console.log(`Runs done: ${runs.join(", ")}`);
  console.log(JSON.stringify(summary.significance, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
