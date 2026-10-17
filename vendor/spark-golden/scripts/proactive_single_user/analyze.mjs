#!/usr/bin/env node
/**
 *   node scripts/proactive_single_user/analyze.mjs --batchDir=... [--writeChapter]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { writeChapter3 } from "./write_chapter.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  let batchDir = null;
  let writeChapter = false;
  for (const a of argv) {
    if (a.startsWith("--batchDir=")) batchDir = path.resolve(a.slice(11));
    else if (a === "--writeChapter") writeChapter = true;
  }
  if (!batchDir) throw new Error("--batchDir required");
  return { batchDir, writeChapter };
}

function csv(rows, keys) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [keys.join(","), ...rows.map((r) => keys.map((k) => esc(r[k])).join(","))].join("\n") + "\n";
}

function mean(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function countByBaseline(trials) {
  const m = {};
  for (const t of trials) {
    const k = t.baseline_id;
    if (!m[k]) m[k] = { pass: 0, fail: 0 };
    if (t.hard_gate_passed) m[k].pass += 1;
    else m[k].fail += 1;
  }
  return m;
}

async function main() {
  const { batchDir, writeChapter } = parseArgs(process.argv.slice(2));
  const matDir = path.join(batchDir, "per_trial_json");
  const files = (await fs.readdir(matDir)).filter((f) => f.endsWith(".json"));
  const trials = [];
  for (const f of files) {
    trials.push(JSON.parse(await fs.readFile(path.join(matDir, f), "utf8")));
  }

  const outMat = path.join(root, "paper_materials", "proactive_single_user");
  const figDir = path.join(root, "vrc-paper", "paper", "figures", "proactive_single_user");
  await fs.mkdir(outMat, { recursive: true });
  await fs.mkdir(figDir, { recursive: true });

  const keys = [
    "trial_id",
    "phase",
    "delivery_key",
    "baseline_id",
    "status",
    "hard_gate_passed",
    "measure_fps",
    "frame_p95_ms",
    "request_total_p95_ms",
    "ttfb_p95_ms",
    "parse_p95_ms",
    "parse_total_ms",
    "first_visible_splat_ms",
    "useful_chunks_before_demand",
    "demanded_chunks",
    "deadline_miss_ratio_50ms",
    "deadline_miss_ratio_100ms",
    "wasted_prefetch_bytes",
    "total_received_bytes",
    "useful_bytes_ratio",
    "normalized_useful_content_score",
    "fast_but_empty_detected",
    "measure_rad_requests",
    "cdp_rad_206_count",
  ];
  await fs.writeFile(path.join(outMat, "proactive_single_user_summary.csv"), csv(trials, keys), "utf8");

  const byBase = {};
  for (const t of trials.filter((x) => x.hard_gate_passed)) {
    const k = `${t.delivery_key}|${t.baseline_id}`;
    if (!byBase[k]) byBase[k] = [];
    byBase[k].push(t);
  }

  const phaseStatus = {};
  for (const ph of ["phase0_canary", "phase1_origin_full", "phase2_remote_reduced"]) {
    const sub = trials.filter((t) => t.phase === ph);
    phaseStatus[ph] = {
      total: sub.length,
      passed: sub.filter((t) => t.hard_gate_passed).length,
    };
  }

  const lines = [
    "# Proactive single-user audit",
    "",
    `- batch: \`${batchDir}\``,
    `- trials: ${trials.length}`,
    `- passed gates: ${trials.filter((t) => t.hard_gate_passed).length}`,
    "",
    "## Phase completion",
    "",
    "| phase | trials | passed |",
    "|-------|--------|--------|",
  ];
  for (const [ph, st] of Object.entries(phaseStatus)) {
    lines.push(`| ${ph} | ${st.total} | ${st.passed} |`);
  }

  lines.push("", "## Per-baseline pass/fail", "", "| baseline | pass | fail |", "|----------|------|------|");
  for (const [bid, c] of Object.entries(countByBaseline(trials)).sort()) {
    lines.push(`| ${bid} | ${c.pass} | ${c.fail} |`);
  }

  lines.push("", "## Aggregates (gate-passed means)", "", "| delivery | baseline | n | miss50% | miss100% | useful_before | useful_bytes_ratio | fps | wasted_MB |", "|----------|----------|---|---------|----------|---------------|-------------------|-----|-----------|");

  for (const [k, rows] of Object.entries(byBase).sort()) {
    const [delivery, baseline] = k.split("|");
    lines.push(
      `| ${delivery} | ${baseline} | ${rows.length} | ${(mean(rows.map((r) => r.deadline_miss_ratio_50ms)) * 100)?.toFixed(1) ?? "—"} | ${(mean(rows.map((r) => r.deadline_miss_ratio_100ms)) * 100)?.toFixed(1) ?? "—"} | ${mean(rows.map((r) => r.useful_chunks_before_demand))?.toFixed(1) ?? "—"} | ${mean(rows.map((r) => r.useful_bytes_ratio))?.toFixed(2) ?? "—"} | ${mean(rows.map((r) => r.measure_fps))?.toFixed(1) ?? "—"} | ${((mean(rows.map((r) => r.wasted_prefetch_bytes)) ?? 0) / 1e6).toFixed(2)} |`,
    );
  }

  const b0o = trials.filter((t) => t.baseline_id === "B0_on_demand" && t.delivery_key === "origin_server" && t.hard_gate_passed);
  const b3o = trials.filter((t) => t.baseline_id === "B3_vrc_single" && t.delivery_key === "origin_server" && t.hard_gate_passed);

  lines.push("", "## Decision hints", "");
  if (b0o.length && b3o.length) {
    const m0 = mean(b0o.map((r) => r.deadline_miss_ratio_50ms));
    const m3 = mean(b3o.map((r) => r.deadline_miss_ratio_50ms));
    lines.push(`- Origin B0 mean miss50: ${(m0 * 100).toFixed(1)}%`);
    lines.push(`- Origin B3 mean miss50: ${(m3 * 100).toFixed(1)}%`);
    lines.push(m3 < m0 - 0.05 ? "- B3 improves deadline vs B0 → timing benefit" : "- B3 does NOT beat B0 on miss50");
  }

  await fs.writeFile(path.join(outMat, "proactive_single_user_audit.md"), lines.join("\n"), "utf8");

  const figPy = path.join(figDir, "gen_proactive_figures.py");
  spawnSync("python", [figPy, `--batchDir=${batchDir}`], { stdio: "inherit", cwd: root });

  let chapter = null;
  if (writeChapter || trials.length >= 20) {
    chapter = await writeChapter3({ root, batchDir, trials });
    const decision = [
      "# Final decision",
      "",
      `- batch: \`${batchDir}\``,
      `- phases: ${JSON.stringify(phaseStatus)}`,
      "",
      "## 1. Proactive improves single-user timing?",
      chapter.improves ? "**Yes** (origin B3 miss50 < B0)" : "**No / inconclusive**",
      "",
      "## 2. Early arrival vs more bytes?",
      `See useful_bytes_ratio and wasted_prefetch_bytes in summary.csv.`,
      "",
      "## 3. B3 vs Oracle gap",
      `Origin B3 miss50 ${pct(mean(b3o.map((r) => r.deadline_miss_ratio_50ms)))}% vs B4 in audit table.`,
      "",
      "## 4. Multi-user overlap/dedup?",
      chapter.multiUserOk ? "**Yes — proceed**" : "**No — fix B3 scheduling/metrics first**",
      "",
    ].join("\n");
    await fs.writeFile(path.join(outMat, "final_decision.md"), decision, "utf8");
  }

  console.log(`[analyze] ${path.join(outMat, "proactive_single_user_summary.csv")}`);
  console.log(`[analyze] ${path.join(outMat, "proactive_single_user_audit.md")}`);
  if (chapter) {
    console.log(`[analyze] chapter3: vrc-paper/paper/sections/chapter3_single_proactive_delivery.tex`);
  }
}

function pct(x) {
  return x == null ? "—" : `${(x * 100).toFixed(1)}`;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
