/**
 * 单用户 streaming-lod 位姿 Range 诊断连续跑 3 次（phaseMs=20000），汇总 range_jaccard 等。
 *
 *   node scripts/run-streaming-lod-pose-diagnostic-triplicate.mjs [--outParent=DIR] [--outDir=DIR] [--phaseMs=20000]
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const o = {
    outParent: path.join(projectRoot, "260506_v4_multi-users", "pose_diagnostic_3x"),
    phaseMs: 20_000,
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "outParent" || k === "outDir") o.outParent = v || o.outParent;
    else if (k === "phaseMs") o.phaseMs = Math.max(3000, Number.parseInt(v || "20000", 10));
  }
  return o;
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { cwd: projectRoot, stdio: "inherit" });
    p.on("error", reject);
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`exit ${c}`))));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outParent = path.isAbsolute(opts.outParent) ? opts.outParent : path.join(projectRoot, opts.outParent);
  const phaseMs = opts.phaseMs;
  await fs.mkdir(path.join(outParent, "summary"), { recursive: true });

  const runs = [];
  for (let i = 1; i <= 3; i++) {
    const outDir = path.join(outParent, `run-${i}-${Date.now()}`);
    await runNode([
      path.join(projectRoot, "scripts", "diagnose-streaming-lod-range-by-pose.mjs"),
      `--outDir=${outDir}`,
      `--phaseMs=${phaseMs}`,
    ]);
    const summaryPath = path.join(outDir, "summary", "streaming_lod_range_by_pose.json");
    const j = JSON.parse(await fs.readFile(summaryPath, "utf8"));
    runs.push({
      run_index: i,
      out_dir: outDir,
      range_jaccard: j.range_jaccard,
      ranges_only_in_A: j.ranges_only_in_A,
      ranges_only_in_B: j.ranges_only_in_B,
      whether_pose_changes_network_requests: j.whether_pose_changes_network_requests,
      verdict_en: j.verdict_en,
    });
  }

  const allDifferent =
    runs.length === 3 &&
    runs.every((r) => r.whether_pose_changes_network_requests === true) &&
    runs.every((r) => (r.ranges_only_in_A?.length || 0) + (r.ranges_only_in_B?.length || 0) > 0);

  const agg = {
    generated_at: new Date().toISOString(),
    out_parent: outParent,
    phase_ms_each: phaseMs,
    runs,
    all_three_runs_show_different_range_sets_vs_pose: allDifferent,
    note: "若三项均为 whether_pose_changes_network_requests=true 且 A/B Range 集合有差，则满足「多步实施 multi-user streaming-lod」的前提。",
  };
  await fs.writeFile(
    path.join(outParent, "summary", "pose_diagnostic_triplicate.json"),
    `${JSON.stringify(agg, null, 2)}\n`,
    "utf8",
  );

  const md = [
    "# streaming-lod 位姿诊断 ×3（phaseMs=20000）",
    "",
    ...runs.map(
      (r) =>
        `## Run ${r.run_index}\n\n- **range_jaccard**: ${JSON.stringify(r.range_jaccard)}\n- **ranges_only_in_A**: ${JSON.stringify(r.ranges_only_in_A)}\n- **ranges_only_in_B**: ${JSON.stringify(r.ranges_only_in_B)}\n- **whether_pose_changes_network_requests**: ${r.whether_pose_changes_network_requests}\n- **verdict**: ${r.verdict_en}\n`,
    ),
    "",
    `**all_three_runs_show_different_range_sets_vs_pose**: ${allDifferent}`,
    "",
    agg.note,
    "",
  ].join("\n");
  await fs.writeFile(path.join(outParent, "summary", "pose_diagnostic_triplicate.md"), md, "utf8");
  console.log(`Wrote ${path.join(outParent, "summary", "pose_diagnostic_triplicate.json")}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
