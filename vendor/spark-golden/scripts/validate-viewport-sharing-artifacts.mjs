/**
 * 校验 viewport 共享实验产物是否齐全，并对照 generate-viewport-sharing-report.mjs 的消费关系。
 *
 *   node scripts/validate-viewport-sharing-artifacts.mjs --runRoot=<共享臂目录> [--pairedBaselineRoot=] [--comparisonJson=]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

function parseArgs(argv) {
  const o = { runRoot: "", pairedBaselineRoot: "", comparisonJson: "" };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    const k = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const v = eq === -1 ? "" : arg.slice(eq + 1);
    if (k === "runRoot") o.runRoot = v;
    else if (k === "pairedBaselineRoot") o.pairedBaselineRoot = v;
    else if (k === "comparisonJson") o.comparisonJson = v;
  }
  return o;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.runRoot) {
    console.error("需要 --runRoot=");
    process.exitCode = 1;
    return;
  }
  const runRoot = path.resolve(args.runRoot);
  const lines = [];

  const files = [
    {
      rel: "summary/viewport_trace_overlap.json",
      usedBy: "generate-viewport-sharing-report（轨迹桶重叠 / Q1）；classic B-lockstep 等非 viewport-* workload 可能不存在",
    },
    {
      rel: "summary/viewport_sharing_validation.json",
      usedBy: "generate-viewport-sharing-report（告警 / pairwise_overlap / Range URL）；validate-bcd-run-artifacts 在 SPARK_SHARED_OBJECT_PROXY=1 时写出",
    },
    {
      rel: "summary/viewport_sharing_gain.json",
      usedBy: "generate-viewport-sharing-report & compare-sharing-gain（核心计数与字节）；analyze-viewport-sharing-gain 生成",
    },
    {
      rel: "proxy/shared-proxy.jsonl",
      usedBy: "analyze-viewport-sharing-gain（共享臂）；instrumented 臂用 proxy/proxy.jsonl",
    },
    {
      rel: "summary/viewport_sharing_report.md",
      usedBy: "generate-viewport-sharing-report 输出",
    },
    {
      rel: "summary/viewport_sharing_report.json",
      usedBy: "generate-viewport-sharing-report 输出",
    },
  ];

  lines.push(`# Artifact checklist: ${runRoot.replace(/\\/g, "/")}\n`);
  for (const f of files) {
    const p = path.join(runRoot, f.rel);
    const ok = existsSync(p);
    lines.push(`- ${ok ? "[x]" : "[ ]"} \`${f.rel}\` — ${f.usedBy}`);
  }

  let cmp = args.comparisonJson ? path.resolve(args.comparisonJson) : "";
  if (!cmp) {
    const normalized = runRoot.replace(/[/\\]+$/, "");
    const base = normalized.toLowerCase().endsWith("-shared") ? normalized.slice(0, -"-shared".length) : "";
    const guess = base ? path.join(`${base}-compare`, "summary", "sharing_gain_comparison.json") : "";
    if (guess && existsSync(guess)) cmp = guess;
  }

  lines.push("");
  lines.push("## sharing_gain_comparison.json（配对 Δ 延迟）");
  if (cmp && existsSync(cmp)) {
    lines.push(`- [x] \`${cmp.replace(/\\/g, "/")}\` — compare-sharing-gain 产出；report Q6 / 矩阵 delta_*`);
  } else if (args.comparisonJson) {
    lines.push(`- [ ] \`${args.comparisonJson}\` — 路径不存在`);
  } else {
    lines.push("- [ ] （未传 --comparisonJson 且未能推断 *-compare/summary/sharing_gain_comparison.json）");
  }

  const out = lines.join("\n") + "\n";
  console.log(out);
  const rep = path.join(runRoot, "summary", "viewport_sharing_artifact_check.md");
  await fs.mkdir(path.dirname(rep), { recursive: true });
  await fs.writeFile(rep, out, "utf8");
  console.log(`[validate-artifacts] wrote ${rep}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
