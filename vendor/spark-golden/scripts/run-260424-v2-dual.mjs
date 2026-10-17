/**
 * 260424_v2: 一键真双机 — 自动起 instrumented proxy + requireRemote + SSH 身份 + 分析输出。
 * 零终端输入: 在仓库根目录双击 `oneclick-260424v2.cmd`（或 `oneclick-260424v2.ps1` / `npm run oneclick:260424v2`），勿再敲子命令。SSH/SCP 已设 accept-new 主机指纹、BatchMode 免问密码。
 * 依赖: Worker2 免密 SSH；`--remotePath` 为 **Worker2** 上仓库根（默认 `D:/Program Files/Spark-main`；勿与 Worker1 本机路径 D:/Program/spark-main/... 混用）；
 * 本机为 Worker1 时用本仓库本地路径。远端已 npm install 与 npx playwright install chromium。分析前会 scp 拉回各次 run 的 `remote` 子目录。控制端自动起/复用 :8092 的 instrumented 代理，除非用 `--startProxy=0`。
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const defaults = {
  server: "http://10.4.158.143:8092",
  origin: "http://10.120.17.176:8090",
  remoteHost: "10.4.146.68",
  remoteUser: "柴若楠",
  /** Worker2 仓库根，含空格路径需用正斜杠或原样。 */
  remotePath: "D:/Program Files/Spark-main",
  outRoot: "260424_v2",
  durationMs: 60000,
  startProxy: true,
};

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || "";
}

function defaultIdentity() {
  return path.join(homeDir(), ".ssh", "id_ed25519_spark_bench");
}

function parseArgs(argv) {
  const out = { ...defaults, sshIdentity: defaultIdentity() };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "server") out.server = v;
    else if (k === "origin") out.origin = v;
    else if (k === "remoteHost") out.remoteHost = v;
    else if (k === "remoteUser") out.remoteUser = v;
    else if (k === "remotePath") out.remotePath = v;
    else if (k === "outRoot") out.outRoot = v;
    else if (k === "durationMs") out.durationMs = Number.parseInt(v || String(defaults.durationMs), 10);
    else if (k === "sshIdentity") out.sshIdentity = v;
    else if (k === "startProxy") out.startProxy = v === "1" || v === "true" || v === "yes";
  }
  if (process.env.SPARK_SERVER) out.server = process.env.SPARK_SERVER;
  if (process.env.SPARK_ORIGIN) out.origin = process.env.SPARK_ORIGIN;
  if (process.env.SPARK_REMOTE_HOST) out.remoteHost = process.env.SPARK_REMOTE_HOST;
  if (process.env.SPARK_REMOTE_USER) out.remoteUser = process.env.SPARK_REMOTE_USER;
  if (process.env.SPARK_REMOTE_PATH) out.remotePath = process.env.SPARK_REMOTE_PATH;
  if (process.env.SPARK_SSH_IDENTITY) out.sshIdentity = process.env.SPARK_SSH_IDENTITY;
  if (process.env.SPARK_260424_OUT) out.outRoot = process.env.SPARK_260424_OUT;
  if (process.env.SPARK_DURATION_MS) out.durationMs = Number.parseInt(process.env.SPARK_DURATION_MS, 10);
  if (process.env.SPARK_START_PROXY === "0" || process.env.SPARK_START_PROXY === "false") out.startProxy = false;
  return out;
}

function runNode(args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { cwd, stdio: "inherit" });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
}

async function waitHttpOk(url, maxMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(url, { method: "GET" });
      if (r.ok || r.status === 404) return true;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function getListenPortFromServerUrl(serverStr) {
  const u = new URL(serverStr);
  if (u.port) return Number.parseInt(u.port, 10);
  return u.protocol === "https:" ? 443 : 80;
}

function startProxyProcess({ proxyScript, port, origin, logJsonl, processLog }) {
  return new Promise((resolve, reject) => {
    const logS = createWriteStream(processLog, { flags: "a" });
    const child = spawn(
      process.execPath,
      [proxyScript, `--port=${port}`, `--origin=${origin}`, `--log=${logJsonl}`],
      {
        cwd: projectRoot,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    child.on("error", reject);
    const w = (b) => logS.write(b);
    child.stdout.on("data", w);
    child.stderr.on("data", w);
    child.on("spawn", () => {
      child.unref();
      resolve(child);
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outRoot = path.isAbsolute(opts.outRoot) ? opts.outRoot : path.join(projectRoot, opts.outRoot);
  const runDir = path.join(outRoot, "logs", "runs");
  const proxyLog = path.join(outRoot, "logs", "proxy-logs.jsonl");
  const analysisOut = path.join(outRoot, "analysis", "distributed-summary.json");
  const traceOut = path.join(outRoot, "runtime", "traces");
  const processLog = path.join(outRoot, "logs", "proxy-process.log");
  const statusOut = path.join(outRoot, "analysis", "automation-status.json");
  const proxyScript = path.join(projectRoot, "proxy/instrumented-reverse-proxy.mjs");
  const listenPort = getListenPortFromServerUrl(opts.server);
  const checkUrl = new URL(opts.server);
  checkUrl.pathname = "/";
  checkUrl.search = "";
  checkUrl.hash = "";

  await fs.mkdir(path.join(outRoot, "logs"), { recursive: true });
  await fs.mkdir(path.join(outRoot, "analysis"), { recursive: true });
  await fs.mkdir(path.join(outRoot, "runtime"), { recursive: true });
  await fs.mkdir(runDir, { recursive: true });

  const started = new Date().toISOString();
  if (opts.startProxy) {
    if (await waitHttpOk(checkUrl.toString(), 3000)) {
      await fs.appendFile(processLog, `\n[${started}] proxy already up at ${checkUrl} — skip start\n`, "utf8");
      console.log(`[auto] reusing existing proxy at ${checkUrl}`);
    } else {
      await fs.appendFile(processLog, `\n[${started}] starting proxy :${listenPort} -> ${opts.origin}\n`, "utf8");
      try {
        await fs.unlink(proxyLog);
      } catch {
        // none
      }
      await startProxyProcess({
        proxyScript,
        port: listenPort,
        origin: opts.origin,
        logJsonl: proxyLog,
        processLog,
      });
      const up = await waitHttpOk(checkUrl.toString(), 25000);
      if (!up) {
        throw new Error(`Proxy did not become ready at ${checkUrl} (see ${processLog})`);
      }
      await fs.appendFile(processLog, `[${new Date().toISOString()}] proxy ready\n`, "utf8");
      console.log(`[auto] instrumented proxy OK -> ${checkUrl} (log ${proxyLog})`);
    }
  } else {
    console.log("[auto] skip startProxy; ensure proxy is already running for", opts.server);
  }

  await runNode(
    [path.join(projectRoot, "scripts/generate-workload-traces.mjs"), `--master=${path.join(projectRoot, "scripts/traces/master-trace.example.json")}`, `--out=${traceOut}`, "--users=4"],
    projectRoot,
  );
  const genRoot = path.join(projectRoot, "scripts/traces/generated");
  await fs.mkdir(genRoot, { recursive: true });
  for (const name of await fs.readdir(traceOut, { withFileTypes: true })) {
    if (name.isDirectory()) {
      const from = path.join(traceOut, name.name);
      const to = path.join(genRoot, name.name);
      await fs.rm(to, { recursive: true, force: true }).catch(() => {});
      await fs.cp(from, to, { recursive: true });
    }
  }

  const runDirAbs = runDir;
  const proxyLogAbs = proxyLog;
  const analysisOutAbs = analysisOut;

  const note = [
    `out_root: ${outRoot}`,
    `proxy_log: ${proxyLogAbs}`,
    `server (clients): ${opts.server}`,
    `origin: ${opts.origin}`,
    `requireRemote: 1`,
    `sshIdentity: ${opts.sshIdentity}`,
    `automation: ${new Date().toISOString()}`,
  ].join("\n");
  await fs.writeFile(path.join(outRoot, "logs", "prereq.txt"), note, "utf8");

  await runNode(
    [
      path.join(projectRoot, "scripts/run-abc-distributed.mjs"),
      `--server=${opts.server}`,
      `--remoteHost=${opts.remoteHost}`,
      `--remoteUser=${opts.remoteUser}`,
      `--remotePath=${opts.remotePath}`,
      `--localPath=${projectRoot}`,
      `--durationMs=${opts.durationMs}`,
      `--outDir=${runDirAbs}`,
      "--requireRemote=1",
      `--sshIdentity=${opts.sshIdentity}`,
      `--proxyLog=${proxyLogAbs}`,
      `--analysisOut=${analysisOutAbs}`,
    ],
    projectRoot,
  );

  let summary = null;
  try {
    const raw = await fs.readFile(analysisOutAbs, "utf8");
    summary = JSON.parse(raw);
  } catch {
    // ignore
  }

  const done = {
    finished_at: new Date().toISOString(),
    out_root: outRoot,
    analysis: analysisOutAbs,
    proxy_log: proxyLogAbs,
    run_logs: runDirAbs,
    significance: summary?.significance ?? null,
  };
  await fs.writeFile(statusOut, JSON.stringify(done, null, 2), "utf8");
  console.log(`\n[auto] Done. Analysis: ${analysisOutAbs}`);
  console.log(`[auto] Status: ${statusOut}`);
  if (done.significance) console.log(`[auto] significance: ${JSON.stringify(done.significance)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
