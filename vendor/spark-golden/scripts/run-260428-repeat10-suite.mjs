/**
 * 与 bench:260425:repeat10 相同流水线，输出目录为 **260428_repeat10/**（经 instrumented proxy 的分布式 **A/B/C/D**×repeat10）。
 * 配置优先从已跑通的 **260425_repeat10/distributed-replay.config.json** 复制；否则 260428 → 260425 模板。
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const OUT = path.join(projectRoot, "260428_repeat10");
const CFG_PRIORITY = [
  path.join(projectRoot, "260425_repeat10", "distributed-replay.config.json"),
  path.join(projectRoot, "260428", "distributed-replay.config.json"),
  path.join(projectRoot, "260425", "distributed-replay.config.json"),
];

function runNode(script, args, cwd, env = process.env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...args], { cwd, stdio: "inherit", env });
    p.on("error", () => resolve(1));
    p.on("exit", (c) => resolve(c ?? 1));
  });
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const outCfg = path.join(OUT, "distributed-replay.config.json");
  if (!existsSync(outCfg)) {
    const src = CFG_PRIORITY.find((p) => existsSync(p));
    if (src) {
      copyFileSync(src, outCfg);
      console.log(`[260428_repeat10] copied ${path.relative(projectRoot, src)} -> ${path.relative(projectRoot, outCfg)}`);
    } else {
      console.error(
        "ERROR: 缺少 260428_repeat10/distributed-replay.config.json，且无可用模板（260425_repeat10 / 260428 / 260425）。",
      );
      process.exitCode = 1;
      return;
    }
  }

  const logPath = path.join(OUT, "suite-run.log");
  const log = async (line) => {
    const s = `[${new Date().toISOString()}] ${line}\n`;
    await fs.appendFile(logPath, s, "utf8");
    process.stdout.write(s);
  };

  const dry = process.env.REPEAT10_DRY === "1" || process.env.REPEAT10_DRY === "true";
  const repeats = dry ? 1 : 10;
  await log(`=== 260428_repeat10 start repeats_per_scenario=${repeats} dry=${dry} ===`);

  const durationMs = Number.parseInt(process.env.SUITE_DURATION_MS || "30000", 10);
  const repeatArgs = [
    `--outRoot=${OUT}`,
    `--repeats=${repeats}`,
    `--durationMs=${durationMs}`,
    `--traceDir=scripts/traces/generated`,
  ];
  const baseEnv = {
    ...process.env,
    SPARK_DIST_CONFIG: outCfg,
    SPARK_BROWSER_FRAME_DIAG: process.env.SPARK_BROWSER_FRAME_DIAG || "1",
  };
  if (process.env.SPARK_FIXED_PROXY_PORT == null) {
    baseEnv.SPARK_FIXED_PROXY_PORT = "1";
  }

  let c = await runNode(path.join(projectRoot, "scripts", "run-bcd-repeatability.mjs"), repeatArgs, projectRoot, baseEnv);
  await log(`run-bcd-repeatability exit=${c}`);

  const repJson = path.join(OUT, "repeatability-runs.json");
  const raw = await fs.readFile(repJson, "utf8").catch(() => "{}");
  let runIds = [];
  try {
    const j = JSON.parse(raw);
    runIds = (j.runs || []).map((r) => r.run_id).filter(Boolean);
  } catch {
    /* */
  }
  if (!runIds.length) {
    await log("WARN: no run_ids; skip aggregate");
    process.exitCode = c !== 0 ? c : 2;
    return;
  }

  const burstOut = path.join(OUT, "burst_queue_diagnosis.json");
  const cBurst = await runNode(
    path.join(projectRoot, "analysis", "analyze-burst-queue-diagnosis.mjs"),
    [`--root=${OUT}`, `--runIds=${runIds.join(",")}`, "--windowMs=250", `--out=${burstOut}`],
    projectRoot,
    baseEnv,
  );
  await log(`analyze-burst-queue-diagnosis exit=${cBurst}`);

  const cmpOut = path.join(OUT, "bcd_timing_shape_comparison.json");
  const cCmp = await runNode(
    path.join(projectRoot, "analysis", "compare-bcd-timing-shape.mjs"),
    [`--input=${burstOut}`, `--out=${cmpOut}`],
    projectRoot,
    baseEnv,
  );
  await log(`compare-bcd-timing-shape exit=${cCmp}`);

  const repSum = path.join(OUT, "repeatability_summary.json");
  const cSum = await runNode(
    path.join(projectRoot, "analysis", "summarize-bcd-repeatability.mjs"),
    [`--root=${OUT}`, "--patterns=rep-", `--out=${repSum}`],
    projectRoot,
    baseEnv,
  );
  await log(`summarize-bcd-repeatability exit=${cSum}`);

  const svcOut = path.join(OUT, "service_vs_bytes.json");
  const cSvc = await runNode(
    path.join(projectRoot, "analysis", "analyze-service-vs-bytes.mjs"),
    [`--root=${OUT}`, `--runIds=${runIds.join(",")}`, `--out=${svcOut}`],
    projectRoot,
    baseEnv,
  );
  await log(`analyze-service-vs-bytes exit=${cSvc}`);

  const paperPy = path.join(projectRoot, "scripts", "analyze_bcd_repeatability_paper.py");
  let cPy = 0;
  if (existsSync(paperPy)) {
    const { spawn: spawn0 } = await import("node:child_process");
    const py = process.env.PYTHON || "python";
    cPy = await new Promise((resolve) => {
      const p = spawn0(py, [paperPy, "--root", OUT], { cwd: projectRoot, stdio: "inherit", env: baseEnv });
      p.on("error", (e) => {
        console.error(e);
        resolve(1);
      });
      p.on("exit", (code) => resolve(code ?? 1));
    });
    await log(`analyze_bcd_repeatability_paper.py exit=${cPy}`);
  }

  const finalCode = [c, cBurst, cCmp, cSum, cSvc, cPy].every((x) => x === 0) ? 0 : 2;
  await log(`=== 260428_repeat10 done aggregate_exit=${finalCode} ===`);
  process.exitCode = finalCode;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
