/**
 * 全自动「直连」测量（不经 instrumented-reverse-proxy），**无人值守排错**：
 * - 同步 scripts/distributed-replay.config.json → outRoot
 * - **若配置中的 upstream 在短时探测内不可达**：本机起 Vite（0.0.0.0:动态端口），upstream_origin 写为 **局域网可达**（client_server_url 主机名或 SPARK_LOCAL_UPSTREAM_ADVERTISE_HOST），供 worker2 直连
 * - 缺 dist 时自动 `npm run build:dev`（供 hello-world importmap）
 * - 默认 **SPARK_LOCAL_FALLBACK_ON_SSH_FAIL=1**（worker2 SSH 失败则单机四用户跑完；拓扑仅本机 worker1 + 远端 worker2，勿配第三机）
 * - SPARK_DIRECT_CLIENT=1 + 聚合与 e2e 分析
 *
 * 关闭本机兜底上游：`SPARK_AUTO_LOCAL_UPSTREAM=0`
 * 关闭 SSH 回退：`SPARK_LOCAL_FALLBACK_ON_SSH_FAIL=0`
 * **R2 / 公开 CDN splat**：`distributed-replay.config.json` 中 `r2_public_origin`（或 `r2_assets_origin`）存在时，run-distributed-replay 会为 replay-worker 自动加 `cdn_base_url`（hello-world 从 `<origin>/butterfly.spz` 拉场景）。关闭：`SPARK_USE_R2_PUBLIC_CDN=0`；覆盖 URL：`SPARK_CDN_BASE_URL=https://...`
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import fs from "node:fs/promises";
import { copyFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const defaultTemplate = path.join(projectRoot, "scripts", "distributed-replay.config.json");

function parseArgs(argv) {
  let outRoot = "260429_direct_auto";
  let repeats = 1;
  let durationMs = 45000;
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "outRoot") outRoot = v || outRoot;
    else if (k === "repeats") repeats = Math.max(1, Number.parseInt(v || "1", 10));
    else if (k === "durationMs") durationMs = Number.parseInt(v || "45000", 10);
  }
  return { outRoot, repeats, durationMs };
}

function runNode(script, args, cwd, env = process.env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...args], { cwd, stdio: "inherit", env });
    p.on("error", () => resolve(1));
    p.on("exit", (c) => resolve(c ?? 1));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

async function fetchWithTimeout(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { redirect: "follow", signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

/** 任一成功（2xx–4xx 有响应体通道）即 true，用于判断「网络可达」 */
async function probeUrlOk(url, totalMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < totalMs) {
    try {
      const r = await fetchWithTimeout(url, 3500);
      if (r.status > 0 && r.status < 600) return true;
    } catch {
      /* */
    }
    await sleep(400);
  }
  return false;
}

/** 供 worker2 访问编排机上的本机 Vite（不能用 127.0.0.1） */
function pickLanIPv4() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "";
}

/** 优先 SPARK_LOCAL_UPSTREAM_ADVERTISE_HOST，其次 config.client_server_url 主机名，再 os 网卡 */
function pickAdvertiseHost(cfgJson) {
  const fromEnv = process.env.SPARK_LOCAL_UPSTREAM_ADVERTISE_HOST && String(process.env.SPARK_LOCAL_UPSTREAM_ADVERTISE_HOST).trim();
  if (fromEnv) return fromEnv;
  try {
    const u = new URL(String(cfgJson?.client_server_url || ""));
    if (u.hostname && u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return u.hostname;
  } catch {
    /* */
  }
  return pickLanIPv4();
}

async function ensureSparkDist(log) {
  const dev = path.join(projectRoot, "dist", "spark.module.js");
  const prod = path.join(projectRoot, "dist", "spark.module.min.js");
  if (existsSync(dev) || existsSync(prod)) return;
  await log("dist 缺失，执行 npm run build:dev …");
  const shell = process.platform === "win32";
  const c = await new Promise((resolve) => {
    const p = spawn("npm", ["run", "build:dev"], { cwd: projectRoot, stdio: "inherit", shell });
    p.on("error", () => resolve(1));
    p.on("exit", (x) => resolve(x ?? 1));
  });
  if (c !== 0) throw new Error(`npm run build:dev exit=${c}`);
}

async function startViteUpstream(port, log) {
  const viteJs = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteJs)) throw new Error(`缺少 Vite：${viteJs}（请先 npm install）`);
  const bindHost = (process.env.SPARK_LOCAL_VITE_BIND_HOST || "0.0.0.0").trim();
  const child = spawn(process.execPath, [viteJs, "--host", bindHost, "--port", String(port), "--strictPort", "true", "--clearScreen", "false"], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  let stderrBuf = "";
  let stdoutBuf = "";
  child.stderr?.on("data", (d) => {
    stderrBuf += d.toString();
    if (stderrBuf.length > 12_000) stderrBuf = stderrBuf.slice(-6000);
  });
  child.stdout?.on("data", (d) => {
    stdoutBuf += d.toString();
    if (stdoutBuf.length > 12_000) stdoutBuf = stdoutBuf.slice(-6000);
  });
  const readyMs = Math.max(60_000, Number.parseInt(process.env.SPARK_LOCAL_VITE_READY_MS || "300000", 10));
  const deadline = Date.now() + readyMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null && child.exitCode !== 0) {
      throw new Error(
        `Vite 进程退出 code=${child.exitCode} stderr=${stderrBuf.slice(-2000)} stdout=${stdoutBuf.slice(-2000)}`,
      );
    }
    try {
      const r = await fetchWithTimeout(`http://127.0.0.1:${port}/examples/hello-world/index.html`, 8000);
      if (r.status >= 200 && r.status < 500) {
        await log(`Vite 就绪 bind=${bindHost} port=${port}（本机探测 127.0.0.1；对外请用局域网 upstream_origin）`);
        return child;
      }
    } catch {
      /* */
    }
    await sleep(600);
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* */
  }
  throw new Error(
    `Vite 在 ${readyMs}ms 内未就绪 port=${port}；stderr=${stderrBuf.slice(-1200)} stdout=${stdoutBuf.slice(-1200)}`,
  );
}

function scenarioKeyLabel(scenario) {
  if (scenario === "A-baseline") return "A";
  if (scenario === "B-lockstep") return "B";
  if (scenario === "C-nearcohort") return "C";
  if (scenario === "D-divergent") return "D";
  return scenario;
}

async function buildE2eManifest(outAbs, repPath) {
  const raw = await fs.readFile(repPath, "utf8").catch(() => "{}");
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    j = {};
  }
  const byScenario = new Map();
  for (const r of j.runs || []) {
    if (!r?.valid || !r.run_id || !r.scenario) continue;
    byScenario.set(r.scenario, r);
  }
  const order = ["A-baseline", "B-lockstep", "C-nearcohort", "D-divergent"];
  const scenarios = [];
  for (const scenario of order) {
    const r = byScenario.get(scenario);
    if (!r) continue;
    const run_root = path.relative(projectRoot, path.join(outAbs, r.run_id)).replace(/\\/g, "/");
    scenarios.push({
      key: scenarioKeyLabel(scenario),
      scenario,
      run_root,
      run_id: r.run_id,
    });
  }
  return {
    generated_at: new Date().toISOString(),
    suite_profile: "direct-client-automation",
    trace_base: "scripts/traces/generated",
    direct_client: true,
    scenarios,
  };
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const outAbs = path.isAbsolute(cli.outRoot) ? path.normalize(cli.outRoot) : path.join(projectRoot, cli.outRoot);
  await fs.mkdir(outAbs, { recursive: true });

  const outCfg = path.join(outAbs, "distributed-replay.config.json");
  if (!existsSync(defaultTemplate)) {
    console.error(`缺少模板配置: ${defaultTemplate}`);
    process.exitCode = 1;
    return;
  }
  copyFileSync(defaultTemplate, outCfg);

  let cfgJson = {};
  try {
    cfgJson = JSON.parse(await fs.readFile(outCfg, "utf8"));
  } catch {
    cfgJson = {};
  }

  const logPath = path.join(outAbs, "suite-direct-auto.log");
  const log = async (line) => {
    const s = `[${new Date().toISOString()}] ${line}\n`;
    await fs.appendFile(logPath, s, "utf8");
    process.stdout.write(s);
  };

  await log(`synced config -> ${path.relative(projectRoot, outCfg)}`);

  let cfgProbeUrl = "";
  const uoOrig = String(cfgJson.upstream_origin || "").replace(/\/$/, "");
  if (uoOrig) cfgProbeUrl = `${uoOrig}/examples/hello-world/index.html`;

  let viteChild = null;
  const killVite = () => {
    if (viteChild && !viteChild.killed) {
      try {
        viteChild.kill("SIGTERM");
      } catch {
        /* */
      }
    }
    viteChild = null;
  };
  process.on("SIGINT", killVite);
  process.on("SIGTERM", killVite);

  const autoLocal =
    process.env.SPARK_AUTO_LOCAL_UPSTREAM !== "0" && process.env.SPARK_AUTO_LOCAL_UPSTREAM !== "false";
  let usedLocalUpstream = false;
  try {
    if (autoLocal && cfgProbeUrl) {
      const ok = await probeUrlOk(cfgProbeUrl, 18_000);
      await log(`upstream probe ${ok ? "ok" : "fail"}: ${cfgProbeUrl}`);
      if (!ok) {
        await log("自动排错: 启动本机 Vite 作为 upstream_origin …");
        await ensureSparkDist(log);
        let lastErr = null;
        for (let attempt = 1; attempt <= 4; attempt++) {
          const port = await pickFreePort();
          try {
            viteChild = await startViteUpstream(port, log);
            const advertise = pickAdvertiseHost(cfgJson);
            if (!advertise) {
              killVite();
              throw new Error(
                "无法解析 worker2 可达的上游地址：请设置 SPARK_LOCAL_UPSTREAM_ADVERTISE_HOST，或在 distributed-replay.config.json 填写可路由的 client_server_url 主机名",
              );
            }
            cfgJson.upstream_origin = `http://${advertise}:${port}`.replace(/\/$/, "");
            await fs.writeFile(outCfg, `${JSON.stringify(cfgJson, null, 2)}\n`, "utf8");
            cfgProbeUrl = `${cfgJson.upstream_origin}/examples/hello-world/index.html`;
            usedLocalUpstream = true;
            await log(`已重写 upstream_origin=${cfgJson.upstream_origin}（worker1+worker2 直连；Vite 尝试 ${attempt}/4）`);
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            killVite();
            await log(`Vite 启动失败 attempt ${attempt}/4: ${e?.message || e}`);
            await sleep(1500);
          }
        }
        if (lastErr) throw lastErr;
      }
    }

    const dry = process.env.REPEAT10_DRY === "1" || process.env.REPEAT10_DRY === "true";
    const repeats = dry ? 1 : cli.repeats;
    const durationMs = Number.parseInt(process.env.SUITE_DURATION_MS || String(cli.durationMs), 10);

    await log(
      `start repeats=${repeats} durationMs=${durationMs} SPARK_DIRECT_CLIENT=1 dry=${dry} local_upstream=${usedLocalUpstream} probe=${cfgProbeUrl || "—"}`,
    );

    const baseEnv = {
      ...process.env,
      SPARK_DIST_CONFIG: outCfg,
      SPARK_BROWSER_FRAME_DIAG: process.env.SPARK_BROWSER_FRAME_DIAG || "1",
      SPARK_DIRECT_CLIENT: "1",
      SPARK_DIRECT_WAIT_ORIGIN_MS: process.env.SPARK_DIRECT_WAIT_ORIGIN_MS || "240000",
      SPARK_DIRECT_CONTINUE_ON_PROBE_FAIL: process.env.SPARK_DIRECT_CONTINUE_ON_PROBE_FAIL || "1",
      /** SSH 不可达时自动单机跑完 B/C/D，无需人工改配置 */
      SPARK_LOCAL_FALLBACK_ON_SSH_FAIL: process.env.SPARK_LOCAL_FALLBACK_ON_SSH_FAIL || "1",
      /** commit 下失败也应较快返回；避免 90s×4 次拖死无人值守流水线 */
      SPARK_REPLAY_GOTO_WAIT_UNTIL: process.env.SPARK_REPLAY_GOTO_WAIT_UNTIL || "commit",
      SPARK_REPLAY_GOTO_TIMEOUT_MS: process.env.SPARK_REPLAY_GOTO_TIMEOUT_MS || "35000",
      SPARK_REPLAY_GOTO_RETRIES: process.env.SPARK_REPLAY_GOTO_RETRIES || "3",
      /** 本机 Vite 时缩短 lockstep 对齐等待 */
      ...(usedLocalUpstream
        ? {
            SPARK_REPLAY_START_OFFSET_MS: process.env.SPARK_REPLAY_START_OFFSET_MS || "4000",
            SPARK_CHROMIUM_RELAX_LAN: process.env.SPARK_CHROMIUM_RELAX_LAN || "1",
          }
        : {}),
      ...(cfgProbeUrl && !process.env.SPARK_DIRECT_ORIGIN_PROBE_URL
        ? { SPARK_DIRECT_ORIGIN_PROBE_URL: cfgProbeUrl }
        : {}),
    };
    delete baseEnv.SPARK_FIXED_PROXY_PORT;

    const repeatArgs = [`--outRoot=${outAbs}`, `--repeats=${repeats}`, `--durationMs=${durationMs}`, `--traceDir=scripts/traces/generated`];

    const c = await runNode(path.join(projectRoot, "scripts", "run-bcd-repeatability.mjs"), repeatArgs, projectRoot, baseEnv);
    await log(`run-bcd-repeatability exit=${c}`);

    const repJsonPath = path.join(outAbs, "repeatability-runs.json");
    const rawRuns = await fs.readFile(repJsonPath, "utf8").catch(() => "{}");
    let runIds = [];
    try {
      const j = JSON.parse(rawRuns);
      runIds = (j.runs || []).filter((r) => r.valid).map((r) => r.run_id).filter(Boolean);
    } catch {
      /* */
    }

    if (!runIds.length) {
      await log("WARN: no valid run_ids; skip aggregates");
      process.exitCode = c !== 0 ? c : 2;
      return;
    }

    const burstOut = path.join(outAbs, "burst_queue_diagnosis.json");
    const cBurst = await runNode(
      path.join(projectRoot, "analysis", "analyze-burst-queue-diagnosis.mjs"),
      [`--root=${outAbs}`, `--runIds=${runIds.join(",")}`, "--windowMs=250", `--out=${burstOut}`],
      projectRoot,
      baseEnv,
    );
    await log(`analyze-burst-queue-diagnosis exit=${cBurst}`);

    const cmpOut = path.join(outAbs, "bcd_timing_shape_comparison.json");
    const cCmp = await runNode(
      path.join(projectRoot, "analysis", "compare-bcd-timing-shape.mjs"),
      [`--input=${burstOut}`, `--out=${cmpOut}`],
      projectRoot,
      baseEnv,
    );
    await log(`compare-bcd-timing-shape exit=${cCmp}`);

    const repSum = path.join(outAbs, "repeatability_summary.json");
    const cSum = await runNode(
      path.join(projectRoot, "analysis", "summarize-bcd-repeatability.mjs"),
      [`--root=${outAbs}`, "--patterns=rep-", `--out=${repSum}`],
      projectRoot,
      baseEnv,
    );
    await log(`summarize-bcd-repeatability exit=${cSum}`);

    const svcOut = path.join(outAbs, "service_vs_bytes.json");
    const cSvc = await runNode(
      path.join(projectRoot, "analysis", "analyze-service-vs-bytes.mjs"),
      [`--root=${outAbs}`, `--runIds=${runIds.join(",")}`, `--out=${svcOut}`],
      projectRoot,
      baseEnv,
    );
    await log(`analyze-service-vs-bytes exit=${cSvc}`);

    const man = await buildE2eManifest(outAbs, repJsonPath);
    const manPath = path.join(outAbs, "e2e_latency_direct_manifest.json");
    await fs.writeFile(manPath, JSON.stringify(man, null, 2), "utf8");
    await log(`wrote manifest scenarios=${man.scenarios.length}`);

    const e2eJson = path.join(outAbs, "analysis", "e2e_latency_direct_breakdown.json");
    const e2eMd = path.join(outAbs, "analysis", "e2e_latency_direct_breakdown_bottleneck_analysis.md");
    await fs.mkdir(path.dirname(e2eJson), { recursive: true });
    const cE2e = await runNode(
      path.join(projectRoot, "analysis", "analyze-e2e-latency-breakdown.mjs"),
      [`--manifest=${path.relative(projectRoot, manPath)}`, `--out=${path.relative(projectRoot, e2eJson)}`, `--outMd=${path.relative(projectRoot, e2eMd)}`],
      projectRoot,
      baseEnv,
    );
    await log(`analyze-e2e-latency-breakdown exit=${cE2e}`);

    const summaryPath = path.join(outAbs, "DIRECT_AUTO_RESULTS.md");
    const lines = [
      `# 直连测量自动化结果`,
      ``,
      `- 生成时间: ${new Date().toISOString()}`,
      `- 输出目录: \`${path.relative(projectRoot, outAbs).replace(/\\/g, "/")}\``,
      `- **direct_client**: 是`,
      `- **本机兜底上游 (Vite)**: ${usedLocalUpstream ? "是（配置中的 upstream 探测失败时自动启动）" : "否"}`,
      `- **SSH 失败单机回退**: 默认开启（SPARK_LOCAL_FALLBACK_ON_SSH_FAIL）`,
      `- repeats / durationMs: ${repeats} / ${durationMs}`,
      ``,
      `## 直连（不经 instrumented proxy）时延看哪里`,
      ``,
      `- **单请求 CDP**：各 \`rep-*/local/client-*.jsonl\`（及 worker2 拉回后的 \`rep-*/remote/client-*.jsonl\`）中 \`source: cdp_network\` 行的 \`duration_ms\`、\`resource_timing\`（DNS/TCP/TLS/send→headers 分段）。`,
      `- **汇总 p95**：\`rep-*/summary/distributed-summary.json\` 里 \`latency.client_p95\` / \`latency.upstream_p95\`（由 \`analysis/analyze-abc-distributed.mjs\` 从 CDP 聚合）。`,
      `- **类 proxy 时间线（仍无真实 reverse proxy）**：\`rep-*/proxy/proxy.jsonl\` 在直连模式下由 \`scripts/synthesize-proxy-log-from-cdp.mjs\` 从 CDP **事后合成**，供 \`analysis/analyze-e2e-latency-breakdown.mjs\` 与闸口脚本对齐字段；不是浏览器走本地代理。`,
      `- **端到端分层解读**：套件跑完后看 \`analysis/e2e_latency_direct_breakdown.json\` 与 \`*_bottleneck_analysis.md\`（或手动 \`npm run analysis:e2e:breakdown -- --runRoot=...\`）。`,
      `- **导航/主线程**：\`rep-*/local/client-local-summary.json\` 中的 \`navigation_timing_page\`、\`browser_frame_diag\`（需 \`SPARK_BROWSER_FRAME_DIAG=1\`）。`,
      `- **大 JSON 排障**：\`rep-*/debug-network-summary.json\`（\`scripts/build-debug-network-summary.mjs\`）。`,
      ``,
      `## 产物`,
      ``,
      `- 各次原始 run: \`rep-*\``,
      `- \`repeatability-runs.json\` / \`repeatability_summary.json\``,
      `- \`burst_queue_diagnosis.json\` / \`bcd_timing_shape_comparison.json\` / \`service_vs_bytes.json\``,
      `- \`analysis/e2e_latency_direct_breakdown.json\` / \`analysis/e2e_latency_direct_breakdown_bottleneck_analysis.md\``,
      `- \`suite-direct-auto.log\``,
      ``,
      `## 子进程退出码`,
      ``,
      `- run-bcd-repeatability: ${c}`,
      `- burst / compare / summarize / service-vs-bytes / e2e: ${cBurst} / ${cCmp} / ${cSum} / ${cSvc} / ${cE2e}`,
      ``,
    ];
    await fs.writeFile(summaryPath, lines.join("\n") + "\n", "utf8");
    await log(`wrote ${path.relative(projectRoot, summaryPath)}`);

    const finalCode = [c, cBurst, cCmp, cSum, cSvc, cE2e].every((x) => x === 0) ? 0 : 2;
    process.exitCode = finalCode;
  } finally {
    killVite();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
