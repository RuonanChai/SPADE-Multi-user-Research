/**
 * Sequentially runs pose-cdn experiments for A–D scenarios and analyzes each batch.
 * Requires a running Vite dev server (--app-base-url) and a public CDN URL (--cdn-base-url).
 *
 * CLI (only --key=value form): --runs=10 --output-root=260429/pose-matrix --cdn-base-url=... --app-base-url=...
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCENARIOS_DEFAULT = [
  "A_single_user",
  "B_lockstep_high_overlap",
  "C_nearcohort_partial_overlap",
  "D_divergent_low_overlap",
];

function parseArgs(argv) {
  const out = {
    runs: 10,
    outputRoot: path.join("260429", `pose-matrix-${Date.now()}`),
    cdnBaseUrl: "https://pub-0429777a95db48e192b4c665413f8eb2.r2.dev/assets/splats",
    appBaseUrl: "auto",
    scenarios: SCENARIOS_DEFAULT,
    tReadyMarkList:
      "first_acceptable_visible_render,interactive-ready,first-nonempty-frame",
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "runs") out.runs = Math.max(1, Number.parseInt(v || "10", 10));
    else if (k === "output-root") out.outputRoot = v || out.outputRoot;
    else if (k === "cdn-base-url") out.cdnBaseUrl = (v || out.cdnBaseUrl).replace(/\/$/, "");
    else if (k === "app-base-url") out.appBaseUrl = (v || out.appBaseUrl).replace(/\/$/, "");
    else if (k === "scenarios")
      out.scenarios = (v || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    else if (k === "t-ready-mark-list") out.tReadyMarkList = v || out.tReadyMarkList;
  }
  return out;
}

async function latestExpDir(logsRoot) {
  let dirs;
  try {
    dirs = await fs.readdir(logsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const expDirs = dirs.filter((d) => d.isDirectory() && d.name.startsWith("exp-")).map((d) => d.name);
  expDirs.sort();
  return expDirs.length ? path.join(logsRoot, expDirs[expDirs.length - 1]) : null;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const node = process.execPath;

  if (args.appBaseUrl === "auto") {
    const ports = [8090, 8091, 8092, 8093, 8094, 8095];
    let detected = null;
    for (const port of ports) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/examples/hello-world/main.ts`, { cache: "no-store" });
        if (res.ok) {
          detected = `http://127.0.0.1:${port}`;
          break;
        }
      } catch {
        // ignore
      }
    }
    if (!detected) throw new Error("auto-detect app-base-url failed (no Vite dev server detected)");
    args.appBaseUrl = detected.replace(/\/$/, "");
  }

  console.log(
    `[pose-matrix] runs=${args.runs} outputRoot=${args.outputRoot} cdn=${args.cdnBaseUrl} app=${args.appBaseUrl}`,
  );
  console.log(`[pose-matrix] scenarios: ${args.scenarios.join(", ")}`);

  await fs.mkdir(args.outputRoot, { recursive: true });
  await fs.writeFile(
    path.join(args.outputRoot, "matrix-metadata.json"),
    JSON.stringify(
      {
        created_at: new Date().toISOString(),
        runs: args.runs,
        scenarios: args.scenarios,
        cdn_base_url: args.cdnBaseUrl,
        app_base_url: args.appBaseUrl,
        t_ready_mark_list: args.tReadyMarkList,
      },
      null,
      2,
    ),
  );

  let aggregateHeader = "";
  const aggregateBodyLines = [];

  for (const scenario of args.scenarios) {
    const scenarioRoot = path.resolve(args.outputRoot, scenario);
    console.log(`\n[pose-matrix] >>> scenario ${scenario}`);

    const expArgs = [
      path.join(rootDir, "scripts/run-pose-cdn-experiment.mjs"),
      `--scenario=${scenario}`,
      `--runs=${args.runs}`,
      `--cdn-base-url=${args.cdnBaseUrl}`,
      `--app-base-url=${args.appBaseUrl}`,
      `--output-root=${scenarioRoot}`,
    ];
    const r1 = spawnSync(node, expArgs, { cwd: rootDir, stdio: "inherit" });
    if (r1.status !== 0) {
      throw new Error(`run-pose-cdn-experiment failed for ${scenario} (exit ${r1.status})`);
    }

    const expInput = await latestExpDir(path.join(scenarioRoot, "logs"));
    if (!expInput) {
      throw new Error(`no logs/exp-* under ${scenarioRoot}/logs after ${scenario}`);
    }

    const anArgs = [
      path.join(rootDir, "scripts/analyze-pose-cdn.mjs"),
      `--input=${expInput}`,
      `--t-ready-mark-list=${args.tReadyMarkList}`,
    ];
    const r2 = spawnSync(node, anArgs, { cwd: rootDir, stdio: "inherit" });
    if (r2.status !== 0) {
      throw new Error(`analyze-pose-cdn failed for ${scenario} (exit ${r2.status})`);
    }

    const cmpPath = path.join(expInput, "summary", "t-ready-mark-comparison.csv");
    try {
      const raw = await fs.readFile(cmpPath, "utf8");
      const lines = raw.trim().split("\n").filter(Boolean);
      if (lines.length >= 2) {
        if (!aggregateHeader) aggregateHeader = `scenario_id,${lines[0]}`;
        for (let i = 1; i < lines.length; i += 1) {
          aggregateBodyLines.push(`${scenario},${lines[i]}`);
        }
      }
    } catch (e) {
      console.warn(`[pose-matrix] skip aggregate row (${scenario}):`, e?.message || e);
    }

    console.log(`[pose-matrix] <<< done ${scenario} → analyze input ${expInput}`);
  }

  if (aggregateHeader && aggregateBodyLines.length) {
    const outAgg = path.join(args.outputRoot, "t-ready-mark-comparison-all-scenarios.csv");
    await fs.writeFile(outAgg, `${aggregateHeader}\n${aggregateBodyLines.join("\n")}\n`);
    console.log(`[pose-matrix] wrote ${outAgg}`);
  }

  console.log(`\n[pose-matrix] all completed under ${path.resolve(args.outputRoot)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
