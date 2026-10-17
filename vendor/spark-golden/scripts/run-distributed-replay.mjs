/**
 * 单次实验、唯一 outRoot：results/distributed/<ms>-<label>/
 * 默认本机起 instrumented-reverse-proxy。若 **SPARK_DIRECT_CLIENT=1**（或 --directClient=1），
 * 不起代理，worker **直连 config.upstream_origin**（或 SPARK_DIRECT_BASE_URL / --server），事后由 CDP 合成 proxy.jsonl。
 * **SPARK_DIRECT_CDN=1**（或 **--directCdn=1**）：主 CDN 测量模式——不启 instrumented / viewport-shared 代理，全员打开 **同一 CDN 源**（`SPARK_CDN_BASE_URL` 或 config 中 r2 公开域）；跑完后执行 **validate-direct-cdn-run** 与 **analyze-direct-cdn-delivery**。
 * **--directCdnStreamingLod=1**（或 **SPARK_DIRECT_CDN_STREAMING_LOD=1**）：在 direct CDN 下打开 **streaming-lod**，相机 trace 由 **replay-worker** 从仓库 `scripts/traces/generated` **addInitScript 内联**（无需 CDN 托管 traces）；单机 B/C/D 自动四用户；额外产出 **summary/streaming_lod_range_overlap.{json,md}**。可选 **`--streamingLodPageServer=`** / **`SPARK_STREAMING_LOD_PAGE_SERVER`**：HTML 基址（未部署到 sparkjs.dev 时用上游 Vite 等）。
 * 若配置含 **r2_public_origin**（或 r2_assets_origin），replay-worker 自动带 **cdn_base_url**，hello-world 的 splat 与正式 Range 探针走该公开域名（可 SPARK_USE_R2_PUBLIC_CDN=0 关闭，SPARK_CDN_BASE_URL 覆盖）。
 * 分布式时仅用 config.ssh_user（ASCII）作为 ssh / scp 登录名。
 *
 * **配对实验**：可对两次 `run-distributed-replay` 传入相同 **`--startAtMs=<unix_ms>`**，以保证与 **同一 traces / duration / users / 上游** 对齐（两臂仅差 `SPARK_SHARED_OBJECT_PROXY`）。详见 `scripts/run-viewport-paired-sharing-experiment.mjs`。
 *
 * **SPARK_SHARED_OBJECT_PROXY=1**：强制关闭直连模式，改起 **viewport-shared-edge-proxy**（非 instrumented-reverse-proxy）；
 * 浏览器与远端 worker 仍连 **client_server_url + 监听端口**（与常规代理一致）；**--origin** 使用 config.upstream_origin → SPARK_DIRECT_BASE_URL → --server。
 * 详见 metadata 中 delivery_mode / shared_object_proxy_enabled。
 * 可调：**SPARK_SHARED_PROXY_CACHE_TTL_MS**、**SPARK_SHARED_PROXY_COALESCE_MS**、**SPARK_SHARED_PROXY_MAX_CACHE_BYTES**（默认同 viewport-shared-edge-proxy 示例）。
 *
 * **固定代理端口调试**：`--proxyPort=8092` 等价强制 **SPARK_FIXED_PROXY_PORT** 行为：分布式不再 pickFreePort；本机 worker 用 **http://127.0.0.1:<port>**，远端 SSH 行用 **config.client_server_url 主机名 + 该端口**（或 `--remoteProxyHost=` 覆盖）。`--skipShared=true` 强制 **instrumented**（忽略环境变量 SPARK_SHARED_OBJECT_PROXY）。若传 `--proxyPort`，在起 Playwright 前会做本机 fetch 预检 + **worker2** SSH `curl -f` 预检，且要求响应头 **X-Spark-Proxy: instrumented-reverse**（见 proxy/instrumented-reverse-proxy.mjs）。
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const defaultConfigPath = path.join(__dirname, "distributed-replay.config.json");

function loadConfig() {
  const p = process.env.SPARK_DIST_CONFIG || defaultConfigPath;
  if (!existsSync(p)) {
    if (process.env.SPARK_DIST_CONFIG) throw new Error(`Missing config: ${p}`);
    return null;
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

function whereBin(name) {
  if (process.platform !== "win32") return name;
  const root = process.env.SystemRoot || "C:\\Windows";
  const wexe = path.join(root, "System32", "where.exe");
  try {
    const o = execFileSync(wexe, [name], { encoding: "utf8" });
    const f = o.trim().split(/\r?\n/)[0];
    if (f && existsSync(f)) return f;
  } catch {
    /* */
  }
  return name;
}

function normKey(p) {
  return p ? p.replace(/\\/g, "/") : "";
}

function sshBase(key, port) {
  const a = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=12",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-p",
    String(port),
  ];
  const i = normKey(key);
  if (i) a.push("-i", i, "-o", "IdentitiesOnly=yes");
  return a;
}

/** scp 端口为 -P（大写），与 ssh -p 不同 */
function scpBase(key, port) {
  const a = [
    "-P",
    String(port),
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=12",
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
  const i = normKey(key);
  if (i) a.push("-i", i, "-o", "IdentitiesOnly=yes");
  return a;
}

function runNode(args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { cwd, stdio: "inherit" });
    p.on("error", reject);
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`node exit ${c}`))));
  });
}

function runCmd(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: "inherit" });
    p.on("error", reject);
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exit ${c}`))));
  });
}

function runCmdLogged(cmd, args, cwd, logFile, tag) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => {
      const s = d.toString();
      out += s;
      process.stdout.write(s);
    });
    p.stderr.on("data", (d) => {
      const s = d.toString();
      err += s;
      process.stderr.write(s);
    });
    p.on("error", async (e) => {
      await fs.appendFile(logFile, `[${new Date().toISOString()}] ${tag}\nCMD=${cmd} ${args.join(" ")}\nERROR=${e.message}\n\n`, "utf8");
      reject(e);
    });
    p.on("exit", async (c) => {
      await fs.appendFile(
        logFile,
        `[${new Date().toISOString()}] ${tag}\nCMD=${cmd} ${args.join(" ")}\nEXIT=${c}\nSTDOUT=\n${out}\nSTDERR=\n${err}\n\n`,
        "utf8",
      );
      if (c === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`${cmd} exit ${c}`));
    });
  });
}

async function waitHttp(u, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(u);
      if (r.status > 0) return true;
    } catch {
      /* */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** 直连时部分上游对 `GET /` 不友好；轮询多个 URL，任一返回 HTTP 状态即视为就绪 */
async function waitHttpAny(urls, ms) {
  const uniq = [...new Set(urls.map((u) => String(u).trim()).filter(Boolean))];
  if (!uniq.length) return false;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    for (const u of uniq) {
      try {
        const r = await fetch(u, { redirect: "follow" });
        if (r.status > 0) return true;
      } catch {
        /* */
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** 分布式时避免与已占用端口（如 8092 上旧代理）冲突 */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const p = typeof a === "object" && a && "port" in a ? a.port : 0;
      s.close((err) => (err ? reject(err) : resolve(p)));
    });
    s.on("error", reject);
  });
}

/** SPARK_FIXED_PROXY_PORT 时：占用中的端口会导致新起的代理无法 bind，waitHttp 仍连到旧进程 → 本 run 的 proxy.jsonl 只有 init */
function assertTcpPortAvailable(port, host = "0.0.0.0") {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", (e) => {
      if (e && e.code === "EADDRINUSE") {
        reject(
          new Error(
            `端口 ${port} 已被占用：请先结束占用该端口的进程（常见于上次 instrumented-reverse-proxy / Vite 未退出），再跑 replay；或取消环境变量 SPARK_FIXED_PROXY_PORT 以使用动态端口。`,
          ),
        );
      } else reject(e);
    });
    s.listen(port, host, () => {
      s.close(() => resolve());
    });
  });
}

function waitProxyProcessStarted(child, ms = 2500, label = "reverse-proxy") {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve();
      }
    }, ms);
    child.once("exit", (code, sig) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(
        new Error(
          `${label} 进程已退出 (code=${code ?? "null"}, signal=${sig ?? ""})，无法监听。多为端口占用(EADDRINUSE)或脚本异常。`,
        ),
      );
    });
  });
}

function envTruthy(name) {
  const v = process.env[name];
  return v === "1" || v === "true";
}

function envTruthyStreamingLod() {
  const v = process.env.SPARK_DIRECT_CDN_STREAMING_LOD;
  return v === "1" || v === "true";
}

function parseArgs(argv) {
  const o = {
    scenario: "A-baseline",
    durationMs: 60_000,
    distributed: "0",
    outRoot: "",
    runId: "",
    traceBase: "",
    clientBase: "",
    directClient: false,
    /** 主 CDN 实验：浏览器直打 CDN，不启代理；见 --directCdn=1 */
    directCdn: false,
    /** 与 directCdn 联用：多用户 streaming-lod + 相机 trace，研究 HTTP Range 对象重叠 */
    directCdnStreamingLod: false,
    /** 可选：HTML 页基址（如含最新 streaming-lod 的上游）；缺省与 CDN 同源 */
    streamingLodPageServer: "",
    /** 配对实验：两次 run 共用同一 wall-clock 起始时刻（毫秒 Unix）；未传则 Date.now()+offset */
    startAtMs: /** @type {number | null} */ (null),
    /** 若设置：强制该监听端口 + 固定口模式（分布式不再动态选口） */
    proxyPort: /** @type {number | null} */ (null),
    /** true：强制 instrumented，忽略 SPARK_SHARED_OBJECT_PROXY */
    skipShared: false,
    /** 远端 worker --server 主机名（不含端口）；默认取 config.client_server_url 的 hostname */
    remoteProxyHost: "",
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, v] = arg.slice(2).split("=");
    if (k === "scenario") o.scenario = v ?? o.scenario;
    else if (k === "durationMs") o.durationMs = Number.parseInt(v || "60000", 10);
    else if (k === "distributed") o.distributed = v ?? "0";
    else if (k === "outRoot") o.outRoot = v ?? "";
    else if (k === "runId") o.runId = v ?? "";
    else if (k === "traceBase") o.traceBase = v ?? "";
    else if (k === "clientBase" || k === "server") o.clientBase = v ?? "";
    else if (k === "directClient") o.directClient = v === "1" || v === "true";
    else if (k === "startAtMs") o.startAtMs = Number.parseInt(v ?? "", 10);
    else if (k === "proxyPort") {
      const n = Number.parseInt(v ?? "", 10);
      o.proxyPort = Number.isFinite(n) ? n : null;
    } else if (k === "skipShared") o.skipShared = v === "1" || v === "true" || v === "";
    else if (k === "remoteProxyHost") o.remoteProxyHost = (v ?? "").trim();
    else if (k === "directCdn") o.directCdn = v === "1" || v === "true" || v === "";
    else if (k === "directCdnStreamingLod") o.directCdnStreamingLod = v === "1" || v === "true" || v === "";
    else if (k === "streamingLodPageServer") o.streamingLodPageServer = (v ?? "").trim();
  }
  return o;
}

/**
 * @param {string} s
 * @param {{ directCdnStreamingLod?: boolean }} [opts]
 */
function mapScenario(s, opts = {}) {
  /** A-baseline-4local：单机同进程起 user0–3，模拟四用户 lockstep（与分布式四机对照） */
  if (s.startsWith("A-baseline-4local")) return { workload: "lockstep", label: "A-baseline-4local" };
  /** 须在通用 B-/C-/D- 分支之前匹配 */
  if (s.startsWith("B-viewport-lockstep")) return { workload: "B-viewport-lockstep", label: "B-viewport-lockstep" };
  if (s.startsWith("C-viewport-nearcohort")) return { workload: "C-viewport-nearcohort", label: "C-viewport-nearcohort" };
  if (s.startsWith("D-viewport-divergent")) return { workload: "D-viewport-divergent", label: "D-viewport-divergent" };
  /**
   * streaming-lod 多用户：使用 viewport 专用 trace（`scripts/traces/generated/B-viewport-*`），
   * 避免 lockstep/divergent 小位移轨迹在 .rad 分页上「看起来都重叠」。
   */
  if (opts.directCdnStreamingLod) {
    if (s === "B-lockstep") return { workload: "B-viewport-lockstep", label: "B-lockstep" };
    if (s === "C-nearcohort") return { workload: "C-viewport-nearcohort", label: "C-nearcohort" };
    if (s === "D-divergent") return { workload: "D-viewport-divergent", label: "D-divergent" };
  }
  if (s.startsWith("A-")) return { workload: "lockstep", label: "A-baseline" };
  if (s.startsWith("B-")) return { workload: "lockstep", label: "B-lockstep" };
  if (s.startsWith("C-")) return { workload: "near-cohort", label: "C-nearcohort" };
  if (s.startsWith("D-")) return { workload: "divergent", label: "D-divergent" };
  return { workload: "lockstep", label: s };
}

const VIEWPORT_SHARING_WORKLOADS = new Set(["B-viewport-lockstep", "C-viewport-nearcohort", "D-viewport-divergent"]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const dist = args.distributed === "1" || args.distributed === "true";
  if (dist) {
    if (!cfg) throw new Error("分布式需要 distributed-replay.config.json");
    if (!cfg.ssh_user || /[^\x00-\x7F]/.test(String(cfg.ssh_user))) {
      throw new Error("config.ssh_user 须为纯 ASCII 登录名（如 Windows 账户名，勿用展示中文名）");
    }
  }

  const directCdnStreamingLod =
    args.directCdnStreamingLod === true ||
    args.directCdnStreamingLod === "1" ||
    envTruthyStreamingLod();
  const { workload, label } = mapScenario(args.scenario, { directCdnStreamingLod });
  const ts = Date.now();
  const runRoot = args.outRoot
    ? path.isAbsolute(args.outRoot)
      ? path.normalize(args.outRoot)
      : path.join(projectRoot, args.outRoot)
    : path.join(projectRoot, "results", "distributed", `${ts}-${label}`);
  const proxyLog = path.join(runRoot, "proxy", "proxy.jsonl");
  const expectedUsers = label === "A-baseline" ? 1 : 4; /* A-baseline-4local → 4 */
  const runId = args.runId || `${label}-${ts}`;
  const startOffsetMs = Math.max(0, Number.parseInt(process.env.SPARK_REPLAY_START_OFFSET_MS || "25000", 10));
  const startAtMs =
    args.startAtMs != null && Number.isFinite(args.startAtMs) ? Math.trunc(args.startAtMs) : Date.now() + startOffsetMs;
  const traceBaseArg = args.traceBase || "/scripts/traces/generated";

  await fs.mkdir(path.join(runRoot, "proxy"), { recursive: true });
  await fs.mkdir(path.join(runRoot, "local"), { recursive: true });
  await fs.mkdir(path.join(runRoot, "remote"), { recursive: true });
  await fs.mkdir(path.join(runRoot, "summary"), { recursive: true });
  const remoteExecLog = path.join(runRoot, "remote-exec-log.txt");
  // 先创建 proxy.jsonl，避免代理进程未产生任何条目前 analyze-abc 报「找不到 proxy」
  await fs.writeFile(
    proxyLog,
    `${JSON.stringify({ event: "proxy_log_init", run_root: runRoot, t: Date.now() })}\n`,
    "utf8",
  );

  let useFixedProxyPort = process.env.SPARK_FIXED_PROXY_PORT === "1";
  let explicitClient = "";
  if (args.clientBase) {
    try {
      explicitClient = new URL(String(args.clientBase).replace(/\/$/, "")).toString().replace(/\/$/, "");
    } catch {
      /* */
    }
  }

  if (args.proxyPort != null && Number.isFinite(args.proxyPort)) {
    useFixedProxyPort = true;
  }
  let directCdn =
    args.directCdn === true ||
    args.directCdn === "1" ||
    envTruthy("SPARK_DIRECT_CDN");
  if (directCdnStreamingLod) directCdn = true;

  const slPageSrv = (args.streamingLodPageServer || process.env.SPARK_STREAMING_LOD_PAGE_SERVER || "").trim();
  const replayPage = directCdnStreamingLod ? "/examples/streaming-lod/index.html" : "/examples/hello-world/index.html";
  const localStreamingLodFour = !dist && directCdnStreamingLod && !label.startsWith("A-");

  const sharedObjectProxy = !directCdn && !args.skipShared && envTruthy("SPARK_SHARED_OBJECT_PROXY");
  const directEnv =
    process.env.SPARK_DIRECT_CLIENT === "1" || process.env.SPARK_DIRECT_CLIENT === "true";
  /** 共享对象代理开启时禁止直连（即使设置了 SPARK_DIRECT_CLIENT）；directCdn 强制直连 CDN */
  const directClient = directCdn || (!sharedObjectProxy && (directEnv || args.directClient));

  const instrumentedUpstreamOrigin = cfg?.upstream_origin ?? "http://10.120.17.176:8090";

  /** viewport-shared-edge-proxy 的 --origin（仅 SPARK_SHARED_OBJECT_PROXY=1） */
  let sharedProxyOrigin = "";
  if (sharedObjectProxy) {
    const fromCfg = String(cfg?.upstream_origin || "").trim().replace(/\/$/, "");
    const fromEnv = process.env.SPARK_DIRECT_BASE_URL && String(process.env.SPARK_DIRECT_BASE_URL).trim();
    const raw = fromCfg || fromEnv || explicitClient || "";
    if (!raw) {
      throw new Error(
        "SPARK_SHARED_OBJECT_PROXY=1 需要 config.upstream_origin、SPARK_DIRECT_BASE_URL 或 --server=（有效上游 URL）",
      );
    }
    try {
      sharedProxyOrigin = new URL(String(raw).replace(/\/$/, "")).toString().replace(/\/$/, "");
    } catch {
      throw new Error(`shared proxy --origin URL 无效: ${raw}`);
    }
  }

  const cacheTtlMsShared = Math.max(0, Number.parseInt(process.env.SPARK_SHARED_PROXY_CACHE_TTL_MS || "30000", 10));
  const coalesceWindowMsShared = Math.max(0, Number.parseInt(process.env.SPARK_SHARED_PROXY_COALESCE_MS || "2000", 10));
  const maxCacheObjectBytesShared = Math.max(
    0,
    Number.parseInt(process.env.SPARK_SHARED_PROXY_MAX_CACHE_BYTES || "104857600", 10),
  );
  const sharedProxyLogAbs = path.join(runRoot, "proxy", "shared-proxy.jsonl");

  const r2Pub = cfg?.r2_public_origin || cfg?.r2_assets_origin;
  const cdnBaseReplay =
    r2Pub && process.env.SPARK_USE_R2_PUBLIC_CDN !== "0" && process.env.SPARK_USE_R2_PUBLIC_CDN !== "false"
      ? String(process.env.SPARK_CDN_BASE_URL || r2Pub).replace(/\/$/, "")
      : "";

  const cdnDirectOrigin =
    (process.env.SPARK_CDN_BASE_URL && String(process.env.SPARK_CDN_BASE_URL).trim().replace(/\/$/, "")) ||
    (r2Pub ? String(r2Pub).trim().replace(/\/$/, "") : "");
  if (directCdn && !cdnDirectOrigin) {
    throw new Error(
      "directCdn 需要 CDN 源：请在 distributed-replay.config.json 配置 r2_public_origin（或 r2_assets_origin），或设置环境变量 SPARK_CDN_BASE_URL",
    );
  }

  const origin = instrumentedUpstreamOrigin;

  let proxyPort = cfg?.proxy_port ?? 8092;
  let clientBase;
  let localProxyBase;

  if (directCdn) {
    try {
      clientBase = new URL(String(cdnDirectOrigin).replace(/\/$/, "")).toString().replace(/\/$/, "");
    } catch {
      throw new Error(`directCdn: CDN URL 无效: ${cdnDirectOrigin}`);
    }
    if (directCdnStreamingLod && slPageSrv) {
      try {
        clientBase = new URL(String(slPageSrv).replace(/\/$/, "")).toString().replace(/\/$/, "");
      } catch {
        throw new Error(`streamingLodPageServer / SPARK_STREAMING_LOD_PAGE_SERVER 无效: ${slPageSrv}`);
      }
    }
    localProxyBase = clientBase;
    try {
      const u = new URL(clientBase);
      proxyPort = u.port ? Number.parseInt(u.port, 10) : u.protocol === "https:" ? 443 : u.protocol === "http:" ? 80 : 443;
    } catch {
      proxyPort = 443;
    }
  } else if (directClient) {
    const raw =
      explicitClient ||
      (process.env.SPARK_DIRECT_BASE_URL && String(process.env.SPARK_DIRECT_BASE_URL).trim()) ||
      String(origin).replace(/\/$/, "");
    if (!raw) throw new Error("直连模式需要 config.upstream_origin、SPARK_DIRECT_BASE_URL 或 --server=");
    try {
      clientBase = new URL(String(raw).replace(/\/$/, "")).toString().replace(/\/$/, "");
    } catch {
      throw new Error(`直连模式 URL 无效: ${raw}`);
    }
    localProxyBase = clientBase;
    try {
      const u = new URL(clientBase);
      proxyPort = u.port ? Number.parseInt(u.port, 10) : u.protocol === "https:" ? 443 : 80;
    } catch {
      proxyPort = 8090;
    }
  } else {
    if (explicitClient && !(args.proxyPort != null && Number.isFinite(args.proxyPort))) {
      try {
        const u = new URL(explicitClient);
        if (u.port) proxyPort = Number.parseInt(u.port, 10);
      } catch {
        /* */
      }
    }
    // 分布式 + 非固定口：必须动态监听，不能沿用配置里的 8092（易被其它进程占用 → 子进程未接到流量、CDP 全 502、proxy.jsonl 仅 init）
    if (dist && !useFixedProxyPort) {
      proxyPort = await pickFreePort();
    }
    if (args.proxyPort != null && Number.isFinite(args.proxyPort)) {
      proxyPort = Math.trunc(args.proxyPort);
    }
    const serverHint = explicitClient || (cfg?.client_server_url ? String(cfg.client_server_url).replace(/\/$/, "") : "");
    if (serverHint) {
      const u = new URL(serverHint);
      u.port = String(proxyPort);
      clientBase = u.toString().replace(/\/$/, "");
    } else {
      clientBase = `http://127.0.0.1:${proxyPort}`;
    }
    /** 本机 worker / waitHttp 固定走环回 */
    localProxyBase = (() => {
      try {
        const u = new URL(String(clientBase));
        const port = u.port || (u.protocol === "https:" ? "443" : "80");
        return `${u.protocol}//127.0.0.1:${port}`;
      } catch {
        return `http://127.0.0.1:${proxyPort}`;
      }
    })();
    /** --proxyPort：显式分离远端可达 URL 与本机 127.0.0.1（避免误用动态口 + LAN 主机不一致） */
    if (!directClient && dist && useFixedProxyPort && args.proxyPort != null && Number.isFinite(args.proxyPort)) {
      let host = "";
      if (args.remoteProxyHost) {
        host = String(args.remoteProxyHost).replace(/^https?:\/\//i, "").split("/")[0].split(":")[0].trim();
      } else if (cfg?.client_server_url) {
        try {
          host = new URL(String(cfg.client_server_url).replace(/\/$/, "")).hostname;
        } catch {
          host = "";
        }
      }
      if (host) {
        clientBase = `http://${host}:${proxyPort}`.replace(/\/$/, "");
        localProxyBase = `http://127.0.0.1:${proxyPort}`;
      }
    }
  }
  const worker2 = {
    name: "worker2",
    key: cfg?.ssh_key_path ?? "",
    sshUser: cfg?.ssh_user ?? "",
    sshHost: cfg?.ssh_host ?? "",
    sshPort: cfg?.ssh_port ?? 22,
    remoteRepo: cfg?.remote_repo_path ?? "",
    remoteOutRoot: cfg?.remote_output_root || "D:/SparkRuns",
  };
  const worker3Enabled = Boolean(cfg?.worker3_ssh_host);
  const worker3 = {
    name: "worker3",
    key: cfg?.worker3_ssh_key_path ?? worker2.key,
    sshUser: cfg?.worker3_ssh_user ?? worker2.sshUser,
    sshHost: cfg?.worker3_ssh_host ?? "",
    sshPort: cfg?.worker3_ssh_port ?? worker2.sshPort,
    remoteRepo: cfg?.worker3_remote_repo_path ?? worker2.remoteRepo,
    remoteOutRoot: cfg?.worker3_remote_output_root ?? worker2.remoteOutRoot,
  };
  const relRun = path.relative(projectRoot, runRoot);
  const meta = {
    run_id: runId,
    scenario: label,
    expected_users: expectedUsers,
    duration_ms: args.durationMs,
    start_at_unix_ms: startAtMs,
    run_root: runRoot,
    distributed: dist,
    proxy_listen_port: proxyPort,
    client_base: clientBase,
    local_proxy_base: directClient ? null : localProxyBase,
    direct_client: directClient,
    cdn_base_url: cdnBaseReplay || null,
    proxy_experiment_mode: directCdn ? "direct_cdn" : sharedObjectProxy ? "shared_object_proxy" : "no_share_proxy",
    ...(directCdn
      ? {
          delivery_mode: "direct_cdn",
          direct_cdn: true,
          cdn_origin: cdnDirectOrigin,
          measurement_note:
            "主 CDN 结果以 direct_cdn 与 analyze-direct-cdn-delivery 为准；代理模式仅作调试/对照，不作为论文主 CDN 数字。",
        }
      : {}),
    ...(sharedObjectProxy
      ? {
          delivery_mode: "shared_object_proxy",
          shared_object_proxy_enabled: true,
          proxy_type: "viewport_shared_edge",
          origin: sharedProxyOrigin,
          share_key_normalization: "method+path+semantic_query+range",
          cacheTtlMs: cacheTtlMsShared,
          coalesceWindowMs: coalesceWindowMsShared,
          shared_proxy_log: sharedProxyLogAbs.replace(/\\/g, "/"),
        }
      : {}),
    ...(VIEWPORT_SHARING_WORKLOADS.has(workload)
      ? { viewport_trace_overlap_path: "summary/viewport_trace_overlap.json" }
      : {}),
    ...(directCdnStreamingLod
      ? {
          direct_cdn_streaming_lod: true,
          streaming_lod_example_page: replayPage,
          streaming_lod_page_server_override: slPageSrv || null,
          measurement_note_streaming_lod:
            "多用户 streaming-lod：相机 trace 由 replay-worker 经 addInitScript 注入（无需 CDN 托管 /scripts/traces）。.rad 等资产可能为第三方存储主机，与 HTML 源主机不同属预期；不据此推断 CDN 缓存命中。",
        }
      : {}),
  };
  await fs.writeFile(path.join(runRoot, "metadata.json"), JSON.stringify(meta, null, 2), "utf8");

  if (VIEWPORT_SHARING_WORKLOADS.has(workload)) {
    const genArgs = [
      path.join(projectRoot, "scripts", "generate-viewport-trace-overlap-summary.mjs"),
      `--workload=${workload}`,
      `--traceRoot=${path.join(projectRoot, "scripts", "traces", "generated")}`,
      `--out=${path.join(runRoot, "summary", "viewport_trace_overlap.json")}`,
    ];
    if (workload === "C-viewport-nearcohort") {
      genArgs.push(
        `--cohortStepMs=${Number.parseInt(process.env.SPARK_VIEWPORT_NEAR_COHORT_STEP_MS || "300", 10)}`,
      );
    }
    await runNode(genArgs, projectRoot);
  }

  const instrumentedProxyScript = path.join(projectRoot, "proxy", "instrumented-reverse-proxy.mjs");
  const viewportSharedProxyScript = path.join(projectRoot, "scripts", "proxy", "viewport-shared-edge-proxy.mjs");
  let pc = null;
  if (!directClient) {
    if (useFixedProxyPort) {
      await assertTcpPortAvailable(proxyPort);
    }
    if (sharedObjectProxy) {
      const proxyArgs = [
        viewportSharedProxyScript,
        `--port=${proxyPort}`,
        `--origin=${sharedProxyOrigin}`,
        `--log=${sharedProxyLogAbs}`,
        `--cacheTtlMs=${cacheTtlMsShared}`,
        `--coalesceWindowMs=${coalesceWindowMsShared}`,
        `--maxCacheObjectBytes=${maxCacheObjectBytesShared}`,
      ];
      pc = spawn(process.execPath, proxyArgs, {
        cwd: projectRoot,
        stdio: "ignore",
      });
      await waitProxyProcessStarted(pc, 2500, "viewport-shared-edge-proxy");
    } else {
      const proxyArgs = [instrumentedProxyScript, `--port=${proxyPort}`, `--origin=${origin}`, `--log=${proxyLog}`];
      if (r2Pub) proxyArgs.push(`--r2Origin=${String(r2Pub)}`);
      pc = spawn(process.execPath, proxyArgs, {
        cwd: projectRoot,
        stdio: "ignore",
      });
      await waitProxyProcessStarted(pc, 2500, "instrumented-reverse-proxy");
    }
  }
  const shutdownProxy = () => {
    if (pc && !pc.killed) {
      try {
        pc.kill("SIGTERM");
      } catch {
        /* */
      }
    }
  };

  try {
    const probeBase = directClient ? clientBase : localProxyBase;
    let origin;
    try {
      origin = new URL(probeBase).origin.replace(/\/$/, "");
    } catch {
      origin = "";
    }
    const envProbe = process.env.SPARK_DIRECT_ORIGIN_PROBE_URL && String(process.env.SPARK_DIRECT_ORIGIN_PROBE_URL).trim();
    const directProbeUrls = directClient
      ? [
          envProbe,
          origin && `${origin}/examples/hello-world/index.html`,
          ...(directCdnStreamingLod && origin ? [`${origin}${replayPage}`] : []),
          origin && `${origin}/assets/splats/butterfly.spz`,
          cdnBaseReplay && `${cdnBaseReplay}/butterfly.spz`,
          origin && `${origin}/`,
        ].filter(Boolean)
      : origin
        ? [`${origin}/`]
        : [];
    const originWaitMs = directClient
      ? Math.max(5_000, Number.parseInt(process.env.SPARK_DIRECT_WAIT_ORIGIN_MS || "180000", 10))
      : 25_000;
    const probeOk =
      directClient && directProbeUrls.length
        ? await waitHttpAny(directProbeUrls, originWaitMs)
        : origin
          ? await waitHttp(`${origin}/`, originWaitMs)
          : false;
    if (!probeOk) {
      const relax =
        directClient &&
        (process.env.SPARK_DIRECT_CONTINUE_ON_PROBE_FAIL === "1" || process.env.SPARK_DIRECT_CONTINUE_ON_PROBE_FAIL === "true");
      if (relax) {
        console.warn(
          `[direct] 上游 Node 探测在 ${originWaitMs}ms 内未成功，仍继续（SPARK_DIRECT_CONTINUE_ON_PROBE_FAIL）；` +
            `若后续 coverage 失败，请检查 upstream_origin 与网络，或增大 SPARK_DIRECT_WAIT_ORIGIN_MS。`,
        );
      } else {
        throw new Error(
          directClient
            ? `直连上游未在时限内就绪（已尝试: ${directProbeUrls.join(" | ")}）；可设置 SPARK_DIRECT_WAIT_ORIGIN_MS、` +
                `SPARK_DIRECT_ORIGIN_PROBE_URL 或 SPARK_DIRECT_CONTINUE_ON_PROBE_FAIL=1`
            : "代理未在时限内就绪",
        );
      }
    }

    /** 固定 --proxyPort：确认 8092 上为 instrumented 代理（响应头 X-Spark-Proxy），非 Python SimpleHTTPServer 等 */
    if (!directClient && !sharedObjectProxy && args.proxyPort != null && Number.isFinite(args.proxyPort)) {
      const uLocal = `${String(localProxyBase).replace(/\/$/, "")}/examples/hello-world/index.html`;
      const rLocal = await fetch(uLocal, { redirect: "follow" });
      const mLocal = rLocal.headers.get("x-spark-proxy") || rLocal.headers.get("X-Spark-Proxy");
      if (!mLocal || !String(mLocal).toLowerCase().includes("instrumented")) {
        throw new Error(
          `[preflight] 本机 GET ${uLocal}: 期望 X-Spark-Proxy: instrumented-reverse（Spark 代理），实际: ${mLocal ?? "(无)"}，status=${rLocal.status}。请先释放端口上的非 Spark 进程。`,
        );
      }
      if (!rLocal.ok) {
        console.warn(
          `[preflight] 本机 GET ${uLocal}: 已确认 Spark 代理（X-Spark-Proxy），但 HTTP ${rLocal.status}（多为上游不可达）；将继续启动 worker。`,
        );
      } else {
        console.log(`[preflight] local OK ${uLocal} (X-Spark-Proxy: ${mLocal})`);
      }

      if (dist && worker2.sshHost && worker2.sshUser) {
        const uRemote = `${String(clientBase).replace(/\/$/, "")}/examples/hello-world/index.html`;
        /** 不用 curl -f：上游 502 时仍需根据 X-Spark-Proxy 判定命中的是 Spark 代理 */
        const curlCmd = `curl -sS -D - ${JSON.stringify(uRemote)} -o NUL`;
        const sshCmd = [].concat(sshBase(worker2.key, worker2.sshPort), [`${worker2.sshUser}@${worker2.sshHost}`, curlCmd]);
        const out = await runCmdLogged(whereBin("ssh"), sshCmd, projectRoot, remoteExecLog, "worker2_remote_curl_preflight");
        const combined = `${out.stdout || ""}\n${out.stderr || ""}`;
        if (!/x-spark-proxy:\s*instrumented-reverse/i.test(combined)) {
          throw new Error(
            `[preflight] worker2 远端 curl 未命中 X-Spark-Proxy: instrumented-reverse（请确认 worker 访问的 URL 即 Spark 代理）。URL=${uRemote}\n----\n${combined.slice(0, 2000)}`,
          );
        }
        console.log(`[preflight] worker2 remote curl OK → ${uRemote}`);
      }
    }

    const rworker = (users, outSlot, machineId, serverUrl) => {
      const row = [
        path.join(projectRoot, "scripts", "replay-worker.mjs"),
        `--server=${serverUrl}`,
        `--page=${replayPage}`,
        `--workload=${workload}`,
        `--runId=${runId}`,
        `--users=${users}`,
        `--startAtMs=${startAtMs}`,
        `--durationMs=${args.durationMs}`,
        `--outDir=${runRoot}`,
        `--outSlot=${outSlot}`,
        `--machineId=${machineId}`,
        `--traceBase=${traceBaseArg}`,
      ];
      if (cdnBaseReplay && !directCdn) row.push(`--cdnBaseUrl=${cdnBaseReplay}`);
      if (directCdn) row.push("--directCdn=1");
      if (directCdnStreamingLod) {
        row.push("--directCdnStreamingLod=1");
        row.push(`--experimentScenario=${label}`);
      }
      return row;
    };

    if (!dist) {
      if (label === "A-baseline-4local" || localStreamingLodFour) {
        await runNode(rworker("user0,user1,user2,user3", "local", "local", localProxyBase), projectRoot);
      } else {
        await runNode(rworker("user0", "local", "local", localProxyBase), projectRoot);
      }
    } else if (label === "A-baseline") {
      /** A 仅 1 user：分布式模式下也只在本机起 user0（不经 SSH），与 expected_users=1 / validate 一致 */
      await runNode(rworker("user0", "local", "local", localProxyBase), projectRoot);
    } else if (label === "A-baseline-4local") {
      /** 与单机套件一致：即使误传 --distributed=1，也只在本机起四用户 */
      await runNode(rworker("user0,user1,user2,user3", "local", "local", localProxyBase), projectRoot);
    } else {
      const useLocalFallbackOnSshFail =
        process.env.SPARK_LOCAL_FALLBACK_ON_SSH_FAIL === "1" || process.env.SPARK_LOCAL_FALLBACK_ON_SSH_FAIL === "true";
      const runDistributedRemotes = async () => {
        const usersLocal = worker3Enabled ? ["user0"] : ["user0", "user1"];
        const remotes = worker3Enabled
          ? [
              { ...worker2, users: ["user1"] },
              { ...worker3, users: ["user2", "user3"] },
            ]
          : [{ ...worker2, users: ["user2", "user3"] }];

        for (const rm of remotes) {
          if (!rm.sshUser || !rm.sshHost || !rm.remoteRepo) throw new Error(`${rm.name} 配置不完整`);
        }

        const remoteRunners = [];
        const remoteCopies = [];
        for (const rm of remotes) {
          const remoteRunAbs = path.join(rm.remoteOutRoot, relRun);
          const mkdirNode = `require("node:fs").mkdirSync(${JSON.stringify(path.normalize(remoteRunAbs))}, { recursive: true })`;
          const pre = "node -e " + JSON.stringify(mkdirNode);
          const rpath = `"${String(rm.remoteRepo).replace(/"/g, '""')}"`;
          const sshPrep = [].concat(sshBase(rm.key, rm.sshPort), [`${rm.sshUser}@${rm.sshHost}`, `cd /d ${rpath} && ${pre}`]);
          await runCmdLogged(whereBin("ssh"), sshPrep, projectRoot, remoteExecLog, `${rm.name}_prepare_output_dir`);

          const remoteOutDirNorm = String(remoteRunAbs).replace(/\\/g, "/");
          const oDirArg = `"${remoteOutDirNorm.replace(/"/g, '""')}"`;
          const remoteLine =
            `cd /d ${rpath} && node scripts\\replay-worker.mjs --server=${clientBase} --page=${replayPage} --workload=${workload} --runId=${runId} --users=${rm.users.join(",")} --startAtMs=${startAtMs} --durationMs=${args.durationMs} --outDir=${oDirArg} --outSlot=remote --machineId=${rm.name} --traceBase=${traceBaseArg}` +
            (cdnBaseReplay && !directCdn ? ` --cdnBaseUrl=${cdnBaseReplay}` : "") +
            (directCdn ? " --directCdn=1" : "") +
            (directCdnStreamingLod ? " --directCdnStreamingLod=1" : "") +
            (directCdnStreamingLod ? ` --experimentScenario=${label}` : "");
          const sshRun = [].concat(sshBase(rm.key, rm.sshPort), [`${rm.sshUser}@${rm.sshHost}`, remoteLine]);
          remoteRunners.push(runCmdLogged(whereBin("ssh"), sshRun, projectRoot, remoteExecLog, `${rm.name}_run_worker`));

          remoteCopies.push({ rm, remoteRunAbs, oDirArg });
        }

        await Promise.all([
          runNode(rworker(usersLocal.join(","), "local", "local", localProxyBase), projectRoot),
          ...remoteRunners,
        ]);

        for (const rc of remoteCopies) {
          const { rm, remoteRunAbs, oDirArg } = rc;
          const checkCmd = `cd /d ${oDirArg} && dir /b remote`;
          const sshCheck = [].concat(sshBase(rm.key, rm.sshPort), [`${rm.sshUser}@${rm.sshHost}`, checkCmd]);
          const listing = await runCmdLogged(whereBin("ssh"), sshCheck, projectRoot, remoteExecLog, `${rm.name}_list_remote_dir`);
          const mustFiles = rm.users.map((u) => `client-${u}.jsonl`);
          const miss = mustFiles.filter((n) => !listing.stdout.includes(n));
          if (miss.length) throw new Error(`${rm.name} missing files: ${miss.join(", ")}`);

          for (const u of rm.users) {
            const rem = String(path.join(remoteRunAbs, "remote", `client-${u}.jsonl`)).replace(/\\/g, "/");
            const loc = path.join(runRoot, "remote", `client-${u}.jsonl`);
            const from = `${rm.sshUser}@${rm.sshHost}:` + rem;
            const sca = [].concat(scpBase(rm.key, rm.sshPort), [from, loc]);
            await runCmdLogged(whereBin("scp"), sca, projectRoot, remoteExecLog, `${rm.name}_scp_${u}`);
          }
        }
      };

      try {
        await runDistributedRemotes();
      } catch (e) {
        if (!useLocalFallbackOnSshFail) throw e;
        console.warn(`[warn] 分布式远端执行失败，回退单机四用户: ${e?.message || e}`);
        await runNode(rworker("user0,user1,user2,user3", "local", "local", localProxyBase), projectRoot);
      }
    }
  } finally {
    shutdownProxy();
  }

  /** 直连或无 instrumented proxy 写入时，从 CDP 追加 synthetic request_complete，供 validate / analyze-abc */
  if (directClient || sharedObjectProxy) {
    await runNode(
      [
        path.join(projectRoot, "scripts", "synthesize-proxy-log-from-cdp.mjs"),
        `--runRoot=${runRoot}`,
        `--proxyLog=${proxyLog}`,
        `--runId=${runId}`,
      ],
      projectRoot,
    );
  }

  if (directCdn) {
    try {
      await runNode(
        [
          path.join(projectRoot, "scripts", "validate-direct-cdn-run.mjs"),
          `--runDir=${runRoot}`,
          `--expectedUsers=${expectedUsers}`,
          `--runId=${runId}`,
        ],
        projectRoot,
      );
    } catch {
      process.exitCode = 2;
    }
    try {
      await runNode(
        [path.join(projectRoot, "scripts", "analyze-direct-cdn-delivery.mjs"), `--runRoot=${runRoot}`],
        projectRoot,
      );
    } catch {
      process.exitCode = 2;
    }
    if (directCdnStreamingLod) {
      try {
        await runNode(
          [path.join(projectRoot, "scripts", "analyze-streaming-lod-cdn-range-overlap.mjs"), `--runRoot=${runRoot}`],
          projectRoot,
        );
      } catch {
        process.exitCode = 2;
      }
    }
  } else {
    const valArgs = [
      path.join(projectRoot, "scripts", "validate-run-coverage.mjs"),
      `--runDir=${runRoot}`,
      `--expectedUsers=${expectedUsers}`,
      `--proxyLog=${proxyLog}`,
      `--runId=${runId}`,
    ];
    await runNode(valArgs, projectRoot).catch(() => process.exitCode = 2);

    const anPath = path.join(runRoot, "summary", "distributed-summary.json");
    const anArgs = [
      path.join(projectRoot, "analysis", "analyze-abc-distributed.mjs"),
      `--runRoot=${runRoot}`,
      `--proxyLog=${proxyLog}`,
      `--out=${anPath}`,
      `--expectedUsers=${expectedUsers}`,
      `--pageSizes=262144`,
      `--runId=${runId}`,
    ];
    await runNode(anArgs, projectRoot);
  }

  const dbgArgs = [
    path.join(projectRoot, "scripts", "build-debug-network-summary.mjs"),
    `--runDir=${runRoot}`,
    `--runId=${runId}`,
    `--serverBase=${clientBase}`,
  ];
  await runNode(dbgArgs, projectRoot);
  console.log(`[done] ${runRoot}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
