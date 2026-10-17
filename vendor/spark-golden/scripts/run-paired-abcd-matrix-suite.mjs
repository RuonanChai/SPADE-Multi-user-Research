/**
 * 依次跑 A-baseline / B-lockstep / C-nearcohort / D-divergent 配对实验，每场景 repeats 次（默认 3），最后聚合矩阵。
 *
 *   node scripts/run-paired-abcd-matrix-suite.mjs [--outParent=results/paired-abcd-matrix] [--repeats=3] [--durationMs=60000] [--config=...]
 *
 * 依赖 SSH/远端（distributed=1）或与 SPARK_LOCAL_FALLBACK_ON_SSH_FAIL 等既有机制一致。
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const o = {
    outParent: "results/paired-abcd-matrix",
    repeats: 3,
    durationMs: 60_000,
    distributed: "1",
    traceDir: "scripts/traces/generated",
    server: "",
    config: "",
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "outParent") o.outParent = v || o.outParent;
    else if (k === "repeats") o.repeats = Math.max(1, Number.parseInt(v || "3", 10));
    else if (k === "durationMs") o.durationMs = Number.parseInt(v || "60000", 10);
    else if (k === "distributed") o.distributed = v || o.distributed;
    else if (k === "traceDir") o.traceDir = v || o.traceDir;
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

  const scenarios = ["A-baseline", "B-lockstep", "C-nearcohort", "D-divergent"];
  const pairedScript = path.join(projectRoot, "scripts", "run-viewport-paired-sharing-experiment.mjs");
  const matrixScript = path.join(projectRoot, "scripts", "build-viewport-experiment-matrix.mjs");

  let failures = 0;
  for (const scenario of scenarios) {
    for (let i = 0; i < args.repeats; i += 1) {
      const tag = `${scenario.replace(/[^a-zA-Z0-9-]+/g, "_")}_rep${i + 1}`;
      console.log(`\n[suite] === ${tag} ===\n`);
      const c = await runNode(
        pairedScript,
        [
          `--scenario=${scenario}`,
          `--distributed=${args.distributed}`,
          `--durationMs=${args.durationMs}`,
          `--outParent=${outParent}`,
          `--traceDir=${args.traceDir}`,
          ...(args.server ? [`--server=${args.server}`] : []),
          ...(args.config ? [`--config=${args.config}`] : []),
        ],
        projectRoot,
        process.env,
      );
      if (c !== 0) {
        failures += 1;
        console.warn(`[suite] FAILED ${tag} exit=${c}`);
      }
    }
  }

  const mc = await runNode(matrixScript, [`--scanRoot=${outParent}`, `--outDir=${outParent}`], projectRoot, process.env);
  if (mc !== 0) failures += 1;

  if (failures) process.exitCode = 2;
  console.log(`\n[suite] done outParent=${outParent} failures=${failures}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
