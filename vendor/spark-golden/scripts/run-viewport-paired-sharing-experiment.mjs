/**
 * Viewport 配对实验：同一 workload 先后跑 no_share_proxy（instrumented-reverse-proxy）
 * 与 shared_object_proxy（viewport-shared-edge-proxy），共用同一 --startAtMs / traces / duration / users。
 *
 *   node scripts/run-viewport-paired-sharing-experiment.mjs \
 *     --scenario=B-viewport-lockstep \
 *     --distributed=1 \
 *     --durationMs=60000 \
 *     --outParent=results/paired-viewport \
 *     [--traceDir=scripts/traces/generated] [--server=http://host:port] [--config=path/to/distributed-replay.config.json]
 *
 * 产出：`<outParent>/paired-<scenario>-<batchTs>-no_share|shared/` 以及对比报告目录 `...-compare/summary/sharing_gain_comparison.*`
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const o = {
    scenario: "B-viewport-lockstep",
    distributed: "1",
    durationMs: 60_000,
    traceDir: "scripts/traces/generated",
    outParent: "results/paired-viewport",
    server: "",
    config: "",
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "scenario") o.scenario = v || o.scenario;
    else if (k === "distributed") o.distributed = v || o.distributed;
    else if (k === "durationMs") o.durationMs = Number.parseInt(v || "60000", 10);
    else if (k === "traceDir") o.traceDir = v || o.traceDir;
    else if (k === "outParent") o.outParent = v || o.outParent;
    else if (k === "server") o.server = v;
    else if (k === "config") o.config = v;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(__dirname, "..");
  const outParent = path.isAbsolute(args.outParent) ? args.outParent : path.join(projectRoot, args.outParent);
  await fs.mkdir(outParent, { recursive: true });

  let cfgPath = args.config;
  if (!cfgPath) {
    const localCfg = path.join(outParent, "distributed-replay.config.json");
    const fallbackCfg = path.join(projectRoot, "scripts", "distributed-replay.config.json");
    cfgPath = existsSync(localCfg) ? localCfg : fallbackCfg;
  }
  if (!existsSync(cfgPath)) {
    console.error(`缺少配置文件: ${cfgPath}（请传 --config= 或在 outParent 下放 distributed-replay.config.json）`);
    process.exitCode = 1;
    return;
  }

  const batchTs = Date.now();
  const slug = args.scenario.replace(/[^a-zA-Z0-9-]+/g, "_");
  const pairedRunId = `paired-${slug}-${batchTs}`;
  const startOffsetMs = Math.max(0, Number.parseInt(process.env.SPARK_REPLAY_START_OFFSET_MS || "25000", 10));
  const startAtMs = Date.now() + startOffsetMs;

  const noShareRoot = path.join(outParent, `${pairedRunId}-no_share`);
  const sharedRoot = path.join(outParent, `${pairedRunId}-shared`);
  const compareRoot = path.join(outParent, `${pairedRunId}-compare`);

  const traceArg = `/${args.traceDir.replaceAll("\\", "/").replace(/^\/+/, "")}`;
  const baseReplayArgs = [
    `--scenario=${args.scenario}`,
    `--distributed=${args.distributed}`,
    `--durationMs=${args.durationMs}`,
    `--runId=${pairedRunId}`,
    `--startAtMs=${startAtMs}`,
    `--traceBase=${traceArg}`,
    ...(args.server ? [`--server=${args.server}`] : []),
  ];

  const envBase = { ...process.env, SPARK_DIST_CONFIG: cfgPath };

  console.log(`[paired-sharing] run_id=${pairedRunId} startAtMs=${startAtMs}`);
  console.log(`[paired-sharing] no_share → ${noShareRoot}`);
  /** 显式关闭共享代理，避免继承 shell 中的 SPARK_SHARED_OBJECT_PROXY */
  const envNo = { ...envBase, SPARK_SHARED_OBJECT_PROXY: "0" };

  const cNo = await runNode(
    path.join(projectRoot, "scripts", "run-distributed-replay.mjs"),
    [...baseReplayArgs, `--outRoot=${noShareRoot}`],
    projectRoot,
    envNo,
  );
  if (cNo !== 0) {
    console.error(`[paired-sharing] no_share arm failed exit=${cNo}`);
    process.exitCode = cNo;
    return;
  }

  console.log(`[paired-sharing] shared → ${sharedRoot}`);
  const envSh = { ...envBase, SPARK_SHARED_OBJECT_PROXY: "1" };
  const cSh = await runNode(
    path.join(projectRoot, "scripts", "run-distributed-replay.mjs"),
    [...baseReplayArgs, `--outRoot=${sharedRoot}`],
    projectRoot,
    envSh,
  );
  if (cSh !== 0) {
    console.error(`[paired-sharing] shared arm failed exit=${cSh}`);
    process.exitCode = cSh;
    return;
  }

  const analyzeScript = path.join(projectRoot, "scripts", "analyze-viewport-sharing-gain.mjs");
  const cAnNo = await runNode(analyzeScript, [`--runRoot=${noShareRoot}`], projectRoot, envBase);
  const cAnSh = await runNode(analyzeScript, [`--runRoot=${sharedRoot}`], projectRoot, envBase);
  if (cAnNo !== 0 || cAnSh !== 0) {
    console.error(`[paired-sharing] analyze-viewport-sharing-gain no=${cAnNo} shared=${cAnSh}`);
    process.exitCode = cAnNo || cAnSh;
    return;
  }

  await fs.mkdir(compareRoot, { recursive: true });
  const cCmp = await runNode(
    path.join(projectRoot, "scripts", "compare-sharing-gain.mjs"),
    [`--noShareRoot=${noShareRoot}`, `--sharedRoot=${sharedRoot}`, `--outDir=${compareRoot}`],
    projectRoot,
    envBase,
  );
  if (cCmp !== 0) {
    process.exitCode = cCmp;
    return;
  }

  const cmpJson = path.join(compareRoot, "summary", "sharing_gain_comparison.json");
  const cRep = await runNode(
    path.join(projectRoot, "scripts", "generate-viewport-sharing-report.mjs"),
    [
      `--runRoot=${sharedRoot}`,
      `--pairedBaselineRoot=${noShareRoot}`,
      `--comparisonJson=${cmpJson}`,
    ],
    projectRoot,
    envBase,
  );
  if (cRep !== 0) {
    console.warn(`[paired-sharing] generate-viewport-sharing-report exit=${cRep}`);
  }

  console.log(`[paired-sharing] done. comparison → ${path.join(compareRoot, "summary", "sharing_gain_comparison.md")}`);
  console.log(`[paired-sharing] viewport report → ${path.join(sharedRoot, "summary", "viewport_sharing_report.md")}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
