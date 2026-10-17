/**
 * 汇总 V5 formal：`streaming-lod-matrix-manifest.json` → figures_ready_tables 主表 + per-user 公平性表。
 *
 *   node scripts/aggregate-v5-streaming-lod-formal-tables.mjs --manifest=260506_v5_streaming_lod_directcdn/streaming-lod-bcd-formal/streaming-lod-matrix-manifest.json
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const o = { manifest: "" };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "manifest") o.manifest = v || "";
  }
  return o;
}

function mean(xs) {
  const a = xs.filter((x) => Number.isFinite(x));
  if (!a.length) return null;
  return a.reduce((s, x) => s + x, 0) / a.length;
}

function meanPairwiseJaccard(jobj) {
  if (!jobj || typeof jobj !== "object") return null;
  const vals = Object.values(jobj).filter((x) => Number.isFinite(x));
  return mean(vals);
}

async function readOverlap(runRootAbs) {
  const p = path.join(runRootAbs, "summary", "streaming_lod_range_overlap.json");
  return JSON.parse(await fs.readFile(p, "utf8"));
}

async function readValidate(runRootAbs) {
  const p = path.join(runRootAbs, "validate-direct-cdn-run.json");
  return JSON.parse(await fs.readFile(p, "utf8").catch(() => "{}"));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.manifest) {
    console.error("需要 --manifest=");
    process.exitCode = 1;
    return;
  }
  const manifestPath = path.isAbsolute(opts.manifest) ? opts.manifest : path.join(projectRoot, opts.manifest);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const outFig = path.join(projectRoot, "260506_v5_streaming_lod_directcdn", "figures_ready_tables");
  await fs.mkdir(outFig, { recursive: true });

  const byScenario = new Map();
  for (const r of manifest.runs || []) {
    if (!r.ok) continue;
    const abs = path.isAbsolute(r.out_root) ? r.out_root : path.join(projectRoot, r.out_root);
    if (!byScenario.has(r.scenario)) byScenario.set(r.scenario, []);
    byScenario.get(r.scenario).push(abs);
  }

  const scenarios = ["B-lockstep", "C-nearcohort", "D-divergent"];
  const mainRows = [];
  const fairnessRows = [];

  for (const scenario of scenarios) {
    const roots = (byScenario.get(scenario) || []).sort();
    const overlaps = [];
    const validates = [];
    for (const root of roots) {
      overlaps.push(await readOverlap(root));
      validates.push(await readValidate(root));
    }
    const validRuns = overlaps.length;
    const total_range_requests_mean = mean(overlaps.map((o) => o.total_range_requests));
    const unique_range_objects_mean = mean(overlaps.map((o) => o.unique_range_objects));
    const repeated_range_request_ratio_mean = mean(overlaps.map((o) => o.repeated_range_request_ratio));
    const range_overlap_mean = mean(overlaps.map((o) => o.range_overlap_mean));
    const range_overlap_p50_mean = mean(overlaps.map((o) => o.range_overlap_p50));
    const range_overlap_p95_mean = mean(overlaps.map((o) => o.range_overlap_p95));
    const pairwise_user_range_jaccard_mean = mean(overlaps.map((o) => meanPairwiseJaccard(o.pairwise_user_range_jaccard)));
    const duration_p50_mean = mean(overlaps.map((o) => o.duration_ms?.p50));
    const duration_p95_mean = mean(overlaps.map((o) => o.duration_ms?.p95));
    const duration_p99_mean = mean(overlaps.map((o) => o.duration_ms?.p99));
    const ttfb_p95_mean = mean(overlaps.map((o) => o.ttfb_p95));
    const download_p95_mean = mean(overlaps.map((o) => o.download_p95));

    const perRunOkMeans = overlaps.map((o) => {
      const pu = o.per_user || {};
      const users = Object.keys(pu).sort();
      const counts = users.map((u) => pu[u]?.ok_count ?? 0);
      return mean(counts);
    });
    const per_user_ok_count_mean = mean(perRunOkMeans);

    const perRunP95Gap = overlaps.map((o) => {
      const pu = o.per_user || {};
      const p95s = Object.values(pu)
        .map((x) => x?.duration_ms?.p95)
        .filter((x) => Number.isFinite(x));
      if (p95s.length < 2) return null;
      return Math.max(...p95s) - Math.min(...p95s);
    });
    const per_user_p95_gap = mean(perRunP95Gap);

    const warnings_count = mean(validates.map((v) => (Array.isArray(v.warnings) ? v.warnings.length : 0)));

    const main_validity_notes = `9 formal runs, ${scenario}: validation_ok=${validates.every((v) => v.validation_ok)}; viewport traces under directCdnStreamingLod; see validate-direct-cdn-run.json per run.`;

    mainRows.push({
      scenario,
      valid_runs: validRuns,
      total_range_requests_mean,
      unique_range_objects_mean,
      repeated_range_request_ratio_mean,
      range_overlap_mean,
      range_overlap_p50_mean,
      range_overlap_p95_mean,
      pairwise_user_range_jaccard_mean,
      duration_p50_mean,
      duration_p95_mean,
      duration_p99_mean,
      ttfb_p95_mean,
      download_p95_mean,
      per_user_ok_count_mean,
      per_user_p95_gap,
      warnings_count,
      main_validity_notes,
    });

    const userIds = new Set();
    for (const o of overlaps) {
      for (const u of Object.keys(o.per_user || {})) userIds.add(u);
    }
    for (const uid of [...userIds].sort()) {
      const ok_count_mean = mean(overlaps.map((o) => o.per_user?.[uid]?.ok_count));
      const duration_p95_mean_u = mean(overlaps.map((o) => o.per_user?.[uid]?.duration_ms?.p95));
      const duration_p99_mean_u = mean(overlaps.map((o) => o.per_user?.[uid]?.duration_ms?.p99));
      const range_request_count_mean = mean(overlaps.map((o) => o.per_user?.[uid]?.request_count));
      fairnessRows.push({
        scenario,
        user_id: uid,
        ok_count_mean,
        duration_p95_mean: duration_p95_mean_u,
        duration_p99_mean: duration_p99_mean_u,
        range_request_count_mean,
        unique_range_object_count_mean: null,
      });
    }
  }

  for (const scenario of scenarios) {
    const roots = (byScenario.get(scenario) || []).sort();
    const overlaps = [];
    for (const root of roots) overlaps.push(await readOverlap(root));
    const userIds = [...new Set(overlaps.flatMap((o) => Object.keys(o.per_user || {})))].sort();
    for (const uid of userIds) {
      const idx = fairnessRows.findIndex((r) => r.scenario === scenario && r.user_id === uid);
      if (idx < 0) continue;
      const estUniquePerUser = overlaps.map((o) => {
        const totalU = o.per_user?.[uid]?.request_count;
        const totalAll = o.total_range_requests;
        const uniqAll = o.unique_range_objects;
        if (!Number.isFinite(totalU) || !totalAll || !Number.isFinite(uniqAll)) return null;
        return (totalU / totalAll) * uniqAll;
      });
      fairnessRows[idx].unique_range_object_count_mean = mean(estUniquePerUser);
    }
  }

  const jsonPath = path.join(outFig, "v5_streaming_lod_directcdn_main_table.json");
  await fs.writeFile(jsonPath, `${JSON.stringify({ generated_at: new Date().toISOString(), rows: mainRows }, null, 2)}\n`, "utf8");

  const csvHeader = Object.keys(mainRows[0] || {}).join(",");
  const csvLines = [csvHeader, ...mainRows.map((r) => Object.values(r).map((v) => (v == null ? "" : JSON.stringify(v))).join(","))];
  await fs.writeFile(path.join(outFig, "v5_streaming_lod_directcdn_main_table.csv"), `${csvLines.join("\n")}\n`, "utf8");

  const mdMain = [
    "# V5 formal 主汇总表（每场景 3 次 formal 的算术平均）",
    "",
    "| " + Object.keys(mainRows[0] || {}).join(" | ") + " |",
    "| " + Object.keys(mainRows[0] || {})
      .map(() => "---")
      .join(" | ") + " |",
    ...mainRows.map((r) => "| " + Object.values(r).map((v) => (v == null ? "—" : String(v))).join(" | ") + " |"),
    "",
  ].join("\n");
  await fs.writeFile(path.join(outFig, "v5_streaming_lod_directcdn_main_table.md"), mdMain, "utf8");

  const fairJson = { generated_at: new Date().toISOString(), rows: fairnessRows };
  await fs.writeFile(path.join(outFig, "v5_per_user_fairness_table.json"), `${JSON.stringify(fairJson, null, 2)}\n`, "utf8");

  const fmd = [
    "# V5 per-user 公平性（每场景 × 用户，跨 3 次 formal 平均）",
    "",
    "说明：`unique_range_object_count_mean` 为按 `request_count/total_range_requests*unique_range_objects` 估算的每用户 unique object 近似值（日志未逐条拆分 object_key 到用户时的保守近似）。",
    "",
    "| scenario | user_id | ok_count_mean | duration_p95_mean | duration_p99_mean | range_request_count_mean | unique_range_object_count_mean |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...fairnessRows.map(
      (r) =>
        `| ${r.scenario} | ${r.user_id} | ${r.ok_count_mean ?? "—"} | ${r.duration_p95_mean ?? "—"} | ${r.duration_p99_mean ?? "—"} | ${r.range_request_count_mean ?? "—"} | ${r.unique_range_object_count_mean ?? "—"} |`,
    ),
    "",
  ].join("\n");
  await fs.writeFile(path.join(outFig, "v5_per_user_fairness_table.md"), fmd, "utf8");

  console.log(`Wrote ${jsonPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
