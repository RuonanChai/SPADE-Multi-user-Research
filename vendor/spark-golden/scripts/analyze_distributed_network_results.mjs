/**
 * Incremental CSV / reports / arm comparison tables for distributed network benchmark.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stats } from "./lib/local_stutter_ablation_metrics.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FOCUS_ARMS = ["E3_normal_streaming", "E5_fetch_only", "E8_pure_render"];

function parseArgs(argv) {
  const o = { batchDir: null };
  for (const a of argv) {
    if (a.startsWith("--batchDir=")) o.batchDir = path.resolve(a.slice(11));
  }
  if (!o.batchDir) throw new Error("--batchDir required");
  return o;
}

function esc(v) {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csv(rows, keys) {
  if (!rows.length) return keys.join(",");
  const lines = [keys.join(",")];
  for (const r of rows) lines.push(keys.map((k) => esc(r[k])).join(","));
  return lines.join("\n");
}

function mean(nums) {
  const xs = nums.filter((n) => Number.isFinite(n));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function aggregateArmRows(trials, groupKeys) {
  const groups = new Map();
  for (const t of trials) {
    if (!FOCUS_ARMS.includes(t.arm_id)) continue;
    const key = groupKeys.map((k) => t[k] ?? "").join("|");
    if (!groups.has(key)) {
      groups.set(key, { keys: Object.fromEntries(groupKeys.map((k) => [k, t[k]])), rows: [] });
    }
    groups.get(key).rows.push(t);
  }
  const out = [];
  for (const { keys, rows } of groups.values()) {
    const rad = rows.map((r) => Number(r.measure_rad_requests)).filter(Number.isFinite);
    const netP95 = rows.map((r) => Number(r.request_total_p95_ms)).filter(Number.isFinite);
    const netP99 = rows.map((r) => Number(r.request_total_p99_ms)).filter(Number.isFinite);
    const parseP95 = rows.map((r) => Number(r.parse_p95_ms)).filter(Number.isFinite);
    const frameP95 = rows.map((r) => Number(r.frame_p95_ms)).filter(Number.isFinite);
    const frameP99 = rows.map((r) => Number(r.frame_p99_ms)).filter(Number.isFinite);
    const ft = rows.flatMap((r) => {
      const m = Number(r.frame_mean_ms);
      return Number.isFinite(m) ? [m] : [];
    });
    const ftSt = stats(ft);
    out.push({
      ...keys,
      trial_count: rows.length,
      measure_fps_mean: mean(rows.map((r) => r.measure_fps)),
      frame_mean_ms: ftSt.mean,
      frame_p95_ms_mean: mean(frameP95),
      frame_p99_ms_mean: mean(frameP99),
      measure_rad_requests_mean: mean(rad),
      measure_rad_requests_max: rad.length ? Math.max(...rad) : null,
      total_rad_requests_mean: mean(rows.map((r) => r.total_rad_requests)),
      network_p95_ms_mean: mean(netP95),
      network_p99_ms_mean: mean(netP99),
      parse_p95_ms_mean: mean(parseP95),
      ttfb_p95_ms_mean: mean(rows.map((r) => r.ttfb_p95_ms)),
      throughput_Mbps_mean: mean(rows.map((r) => r.throughput_Mbps)),
      gpu_renderer: rows.map((r) => r.gpu_renderer).find(Boolean) ?? "",
      hard_gate_failures: rows.filter((r) => r.hard_gate_passed === false).length,
    });
  }
  return out.sort((a, b) =>
    `${a.delivery_profile}|${a.scenario}|${a.arm_id}`.localeCompare(
      `${b.delivery_profile}|${b.scenario}|${b.arm_id}`,
    ),
  );
}

function mdTable(headers, rows) {
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];
  for (const r of rows) {
    lines.push(`| ${headers.map((h) => esc(r[h]).replace(/\|/g, "\\|")).join(" | ")} |`);
  }
  return lines.join("\n");
}

function startupLatencyMs(t) {
  if (t.startup_mode === "cold_start" || t.cold_start_effective) {
    return t.first_visible_splat_ms ?? t.first_nonblack_frame_ms ?? null;
  }
  return null;
}

function classifyBottlenecks(byProfile) {
  const lines = ["# Bottleneck classification (auto-heuristic)", ""];
  const localhost = byProfile.local_loopback;
  const cdn1 = byProfile.cdn1_r2;
  if (localhost && cdn1) {
    const locVis = localhost.first_visible_mean;
    const cdnVis = cdn1.first_visible_mean;
    if (locVis != null && cdnVis != null && cdnVis > locVis * 1.5) {
      lines.push(
        "- **cold_start_visibility_bottleneck** (candidate): cdn1 first_visible_splat_ms elevated vs loopback",
      );
    }
    if (cdn1.throughput_mean < (localhost.throughput_mean ?? 0) * 0.6) {
      lines.push("- **bandwidth_bottleneck** (candidate): cdn1 throughput lower than loopback");
    }
    if (cdn1.ttfb_p95_mean > (localhost.ttfb_p95_mean ?? 0) * 1.5) {
      lines.push("- **network_latency_bottleneck** (candidate): cdn1 ttfb_p95 elevated vs loopback");
    }
  }
  if (lines.length === 2) lines.push("- No strong automatic classification — inspect per-trial JSON.");
  lines.push(
    "",
    "_Note: `time_to_ready_ms` is deprecated (always null). Steady-state uses `configured_preload_duration_ms`; cold-start uses `first_visible_splat_ms` / `first_nonblack_frame_ms`._",
  );
  return lines.join("\n");
}

async function main() {
  const { batchDir } = parseArgs(process.argv.slice(2));
  const trialDir = path.join(batchDir, "per_trial_json");
  let files = [];
  try {
    files = (await fs.readdir(trialDir)).filter((f) => f.endsWith(".json"));
  } catch {
    console.error("No per_trial_json/");
    process.exitCode = 1;
    return;
  }

  const trials = [];
  for (const f of files) {
    trials.push(JSON.parse(await fs.readFile(path.join(trialDir, f), "utf8")));
  }

  const csvDir = path.join(batchDir, "csv");
  const reportsDir = path.join(batchDir, "reports");
  await fs.mkdir(csvDir, { recursive: true });
  await fs.mkdir(reportsDir, { recursive: true });

  const summaryKeys = [
    "trial_id",
    "delivery_profile",
    "scenario",
    "arm_id",
    "measurement_mode",
    "measure_fps",
    "frame_mean_ms",
    "frame_p95_ms",
    "frame_p99_ms",
    "measure_rad_requests",
    "total_rad_requests",
    "throughput_Mbps",
    "ttfb_p95_ms",
    "request_total_p95_ms",
    "request_total_p99_ms",
    "parse_p95_ms",
    "startup_mode",
    "configured_preload_duration_ms",
    "first_visible_splat_ms",
    "first_nonblack_frame_ms",
    "first_quality_10k_splats_ms",
    "first_quality_100k_splats_ms",
    "protocol",
    "asset_url",
    "qoe_proxy",
    "gpu_renderer",
    "hard_gate_passed",
    "hard_gate_failures",
    "status",
  ];
  await fs.writeFile(
    path.join(csvDir, "distributed_trial_summary.csv"),
    csv(trials, summaryKeys),
    "utf8",
  );

  const armByProfile = aggregateArmRows(trials, ["delivery_profile", "arm_id"]);
  const armByProfileScenario = aggregateArmRows(trials, [
    "delivery_profile",
    "scenario",
    "arm_id",
  ]);

  const armTableKeys = [
    "delivery_profile",
    "scenario",
    "arm_id",
    "trial_count",
    "measure_fps_mean",
    "frame_p95_ms_mean",
    "frame_p99_ms_mean",
    "measure_rad_requests_mean",
    "network_p95_ms_mean",
    "network_p99_ms_mean",
    "parse_p95_ms_mean",
    "gpu_renderer",
  ];

  await fs.writeFile(
    path.join(csvDir, "arm_comparison_by_profile.csv"),
    csv(armByProfile, [
      "delivery_profile",
      "arm_id",
      "trial_count",
      "measure_fps_mean",
      "frame_mean_ms",
      "frame_p95_ms_mean",
      "frame_p99_ms_mean",
      "measure_rad_requests_mean",
      "measure_rad_requests_max",
      "total_rad_requests_mean",
      "network_p95_ms_mean",
      "network_p99_ms_mean",
      "parse_p95_ms_mean",
      "ttfb_p95_ms_mean",
      "throughput_Mbps_mean",
      "gpu_renderer",
      "hard_gate_failures",
    ]),
    "utf8",
  );

  await fs.writeFile(
    path.join(csvDir, "arm_comparison_e3_e5_e8.csv"),
    csv(armByProfileScenario, armTableKeys),
    "utf8",
  );

  const byProfile = {};
  for (const t of trials) {
    const p = t.delivery_profile || "unknown";
    if (!byProfile[p]) {
      byProfile[p] = {
        trials: [],
        configured_preload: [],
        first_visible: [],
        throughput: [],
        ttfb_p95: [],
        measure_fps: [],
        frame_p95: [],
        qoe: [],
      };
    }
    const b = byProfile[p];
    b.trials.push(t);
    if (t.configured_preload_duration_ms != null) b.configured_preload.push(t.configured_preload_duration_ms);
    const vis = startupLatencyMs(t);
    if (vis != null) b.first_visible.push(vis);
    if (t.throughput_Mbps != null) b.throughput.push(t.throughput_Mbps);
    if (t.ttfb_p95_ms != null) b.ttfb_p95.push(t.ttfb_p95_ms);
    if (t.measure_fps != null) b.measure_fps.push(t.measure_fps);
    if (t.frame_p95_ms != null) b.frame_p95.push(t.frame_p95_ms);
    if (t.qoe_proxy != null) b.qoe.push(t.qoe_proxy);
  }

  for (const [p, b] of Object.entries(byProfile)) {
    b.configured_preload_mean = mean(b.configured_preload);
    b.first_visible_mean = mean(b.first_visible);
    b.throughput_mean = mean(b.throughput);
    b.ttfb_p95_mean = mean(b.ttfb_p95);
    b.measure_fps_mean = mean(b.measure_fps);
    b.frame_p95_mean = mean(b.frame_p95);
    b.qoe_mean = mean(b.qoe);
  }

  const focusTrials = trials.filter((t) => FOCUS_ARMS.includes(t.arm_id));
  const reportLines = [
    "# Distributed network report (auto)",
    "",
    `- batch: \`${batchDir}\``,
    `- trials_total: ${trials.length}`,
    `- completed: ${trials.filter((t) => t.status === "completed").length}`,
    `- failed: ${trials.filter((t) => t.status === "failed").length}`,
    "",
    "## E3 / E5 / E8 comparison by delivery profile",
    "",
    mdTable(
      [
        "delivery_profile",
        "arm_id",
        "trial_count",
        "measure_fps_mean",
        "frame_p95_ms_mean",
        "frame_p99_ms_mean",
        "measure_rad_mean",
        "network_p95_mean",
        "network_p99_mean",
        "parse_p95_mean",
      ],
      armByProfile.map((r) => ({
        delivery_profile: r.delivery_profile,
        arm_id: r.arm_id,
        trial_count: r.trial_count,
        measure_fps_mean: r.measure_fps_mean?.toFixed(1) ?? "—",
        frame_p95_ms_mean: r.frame_p95_ms_mean?.toFixed(1) ?? "—",
        frame_p99_ms_mean: r.frame_p99_ms_mean?.toFixed(1) ?? "—",
        measure_rad_mean: r.measure_rad_requests_mean?.toFixed(0) ?? "—",
        network_p95_mean: r.network_p95_ms_mean?.toFixed(1) ?? "—",
        network_p99_mean: r.network_p99_ms_mean?.toFixed(1) ?? "—",
        parse_p95_mean: r.parse_p95_ms_mean?.toFixed(1) ?? "—",
      })),
    ),
    "",
    "## GPU renderer (full string preserved in CSV)",
    "",
  ];

  const gpuSeen = new Set();
  for (const t of focusTrials) {
    if (t.gpu_renderer && !gpuSeen.has(t.gpu_renderer)) {
      gpuSeen.add(t.gpu_renderer);
      reportLines.push(`- \`${t.gpu_renderer}\``);
    }
  }

  reportLines.push("", "## Per profile summary", "");
  for (const [p, b] of Object.entries(byProfile)) {
    reportLines.push(
      `### ${p}`,
      `- trials: ${b.trials.length}`,
      `- configured_preload_mean_ms: ${b.configured_preload_mean?.toFixed(0) ?? "—"} (scheduled wait, not first paint)`,
      `- cold_start_first_visible_mean_ms: ${b.first_visible_mean?.toFixed(0) ?? "—"}`,
      `- throughput_mean_Mbps: ${b.throughput_mean?.toFixed(2) ?? "—"}`,
      `- measure_fps_mean: ${b.measure_fps_mean?.toFixed(1) ?? "—"}`,
      "",
    );
  }

  await fs.writeFile(path.join(reportsDir, "distributed_network_report.md"), reportLines.join("\n"), "utf8");
  await fs.writeFile(
    path.join(reportsDir, "arm_comparison_e3_e5_e8.md"),
    [
      "# E3 / E5 / E8 arm comparison",
      "",
      "Full `gpu_renderer` in `csv/arm_comparison_e3_e5_e8.csv` and `distributed_trial_summary.csv`.",
      "",
      mdTable(
        armTableKeys,
        armByProfileScenario.map((r) => ({
          ...r,
          measure_fps_mean: r.measure_fps_mean?.toFixed(1) ?? "",
          frame_p95_ms_mean: r.frame_p95_ms_mean?.toFixed(1) ?? "",
          frame_p99_ms_mean: r.frame_p99_ms_mean?.toFixed(1) ?? "",
          measure_rad_requests_mean: r.measure_rad_requests_mean?.toFixed(0) ?? "",
          network_p95_ms_mean: r.network_p95_ms_mean?.toFixed(1) ?? "",
          network_p99_ms_mean: r.network_p99_ms_mean?.toFixed(1) ?? "",
          parse_p95_ms_mean: r.parse_p95_ms_mean?.toFixed(1) ?? "",
        })),
      ),
    ].join("\n"),
    "utf8",
  );

  await fs.writeFile(path.join(reportsDir, "bottleneck_classification.md"), classifyBottlenecks(byProfile), "utf8");

  const completed = trials.filter((t) => t.status === "completed").length;
  const failed = trials.length - completed;
  console.log(`[analyze] batch=${batchDir}`);
  console.log(`[analyze] trials=${trials.length} completed=${completed} failed=${failed}`);
  console.log(`[analyze] csv=${path.join(csvDir, "distributed_trial_summary.csv")}`);
  console.log(`[analyze] arm_table=${path.join(csvDir, "arm_comparison_e3_e5_e8.csv")}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
