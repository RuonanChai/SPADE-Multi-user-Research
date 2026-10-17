/**
 * 两节点（本机 + worker2，无 worker3）全量 B/C/D ×2 次重复 + 汇总分析，输出到项目内 260425/。
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const OUT = path.join(projectRoot, "260425");

function runNode(script, args, cwd, env = process.env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...args], { cwd, stdio: "inherit", env });
    p.on("error", () => resolve(1));
    p.on("exit", (c) => resolve(c ?? 1));
  });
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const logPath = path.join(OUT, "suite-run.log");
  const log = async (line) => {
    const s = `[${new Date().toISOString()}] ${line}\n`;
    await fs.appendFile(logPath, s, "utf8");
    process.stdout.write(s);
  };

  await log("=== 260425 two-worker suite start ===");

  const cfgLocal = path.join(OUT, "distributed-replay.config.json");
  if (!existsSync(cfgLocal)) {
    await log("ERROR: missing 260425/distributed-replay.config.json");
    process.exitCode = 1;
    return;
  }

  const durationMs = Number.parseInt(process.env.SUITE_DURATION_MS || "30000", 10);
  const repeatArgs = [
    `--outRoot=${OUT}`,
    `--durationMs=${durationMs}`,
    `--traceDir=scripts/traces/generated`,
  ];
  const baseEnv = { ...process.env, SPARK_DIST_CONFIG: cfgLocal };

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
    await log("WARN: no run_ids in repeatability-runs.json; skip aggregate analysis");
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

  const draftOut = path.join(OUT, "results_draft_multiplayer_3dgs.md");
  const cDraft = await runNode(
    path.join(projectRoot, "analysis", "generate-paper-results-draft.mjs"),
    [
      `--repeatability=${repSum}`,
      `--burst=${burstOut}`,
      `--compare=${cmpOut}`,
      `--service=${svcOut}`,
      `--out=${draftOut}`,
    ],
    projectRoot,
    baseEnv,
  );
  await log(`generate-paper-results-draft exit=${cDraft}`);

  const finalCode = [c, cBurst, cCmp, cSum, cSvc, cDraft].every((x) => x === 0) ? 0 : 2;
  await log(`=== suite done aggregate_exit=${finalCode} ===`);
  process.exitCode = finalCode;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
