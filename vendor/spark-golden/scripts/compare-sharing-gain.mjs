/**
 * 配对实验：对比 no_share_proxy 与 shared_object_proxy 两臂的 viewport_sharing_gain 聚合结果。
 *
 *   node scripts/compare-sharing-gain.mjs --noShareRoot=<dir> --sharedRoot=<dir> [--outDir=<dir>]
 *
 * 默认 --outDir 为 sharedRoot（写出 sharedRoot/summary/sharing_gain_comparison.{md,json}）。
 * 请先对两臂分别运行 analyze-viewport-sharing-gain.mjs（或由配对脚本自动调用）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { PAGE_SIZE } from "./dist-replay-constants.mjs";

function parseArgs(argv) {
  const o = { noShareRoot: "", sharedRoot: "", outDir: "" };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    const k = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const v = eq === -1 ? "" : arg.slice(eq + 1);
    if (k === "noShareRoot") o.noShareRoot = v;
    else if (k === "sharedRoot") o.sharedRoot = v;
    else if (k === "outDir") o.outDir = v;
  }
  return o;
}

function quantile(arr, q) {
  const s = arr.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const pos = (s.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (base + 1 < s.length) return s[base] + rest * (s[base + 1] - s[base]);
  return s[base];
}

function qp(arr) {
  return { p95: quantile(arr, 0.95), p99: quantile(arr, 0.99) };
}

function isCdp(r) {
  return r && (!r.source || r.source === "cdp_network");
}

function parseJsonl(raw) {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function collectLargeObjectClientDurations(runRoot) {
  const ms = [];
  for (const slot of ["local", "remote"]) {
    const dir = path.join(runRoot, slot);
    const ent = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of ent) {
      if (!e.isFile() || !e.name.startsWith("client-") || !e.name.endsWith(".jsonl")) continue;
      const raw = await fs.readFile(path.join(dir, e.name), "utf8").catch(() => "");
      for (const row of parseJsonl(raw)) {
        if (!isCdp(row) || row.debug_only) continue;
        const enc = Number(row.encodedDataLength);
        if (!Number.isFinite(enc) || enc < PAGE_SIZE) continue;
        const d = Number(row.duration_ms);
        if (Number.isFinite(d)) ms.push(d);
      }
    }
  }
  return ms;
}

async function readMetadata(runRoot) {
  const p = path.join(runRoot, "metadata.json");
  return JSON.parse(await fs.readFile(p, "utf8").catch(() => "{}"));
}

async function loadGain(runRoot) {
  const p = path.join(runRoot, "summary", "viewport_sharing_gain.json");
  return JSON.parse(await fs.readFile(p, "utf8"));
}

function maxCompletionGapMs(gain) {
  const g = gain?.per_user_fairness?.per_user_completion_gap_ms;
  if (!g || typeof g !== "object") return null;
  const vals = Object.values(g).filter((x) => Number.isFinite(x));
  return vals.length ? Math.max(...vals) : null;
}

function mdEscapeCell(s) {
  const t = String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  return t;
}

function fmtNum(n) {
  if (n == null || !Number.isFinite(n)) return "";
  if (Math.abs(n) >= 1e9 || (Math.abs(n) < 1e-6 && n !== 0)) return String(n);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.noShareRoot || !args.sharedRoot) {
    console.error("需要 --noShareRoot= --sharedRoot= [--outDir=]");
    process.exitCode = 1;
    return;
  }
  const noShareRoot = path.resolve(args.noShareRoot);
  const sharedRoot = path.resolve(args.sharedRoot);
  const outDir = path.resolve(args.outDir || sharedRoot);
  const summaryDir = path.join(outDir, "summary");
  await fs.mkdir(summaryDir, { recursive: true });

  const mdPath = path.join(summaryDir, "sharing_gain_comparison.md");
  const jsonPath = path.join(summaryDir, "sharing_gain_comparison.json");

  const metaNo = await readMetadata(noShareRoot);
  const metaSh = await readMetadata(sharedRoot);

  let gainNo;
  let gainSh;
  try {
    gainNo = await loadGain(noShareRoot);
    gainSh = await loadGain(sharedRoot);
  } catch (e) {
    console.error(e?.message || e);
    process.exitCode = 1;
    return;
  }

  if (gainNo.skipped || !gainNo.byte_metrics) {
    console.error(`no_share 臂缺少有效 viewport_sharing_gain.json: ${noShareRoot}`);
    process.exitCode = 1;
    return;
  }
  if (gainSh.skipped || !gainSh.byte_metrics) {
    console.error(`shared 臂缺少有效 viewport_sharing_gain（须存在 shared-proxy 并完成分析）: ${sharedRoot}`);
    process.exitCode = 1;
    return;
  }

  const pairChecks = {
    same_scenario: String(metaNo.scenario || "") === String(metaSh.scenario || ""),
    same_start_at_unix_ms: Number(metaNo.start_at_unix_ms) === Number(metaSh.start_at_unix_ms),
    same_expected_users: Number(metaNo.expected_users) === Number(metaSh.expected_users),
    same_duration_ms:
      metaNo.duration_ms != null && metaSh.duration_ms != null
        ? Number(metaNo.duration_ms) === Number(metaSh.duration_ms)
        : null,
    same_run_id: String(metaNo.run_id || "") === String(metaSh.run_id || ""),
  };

  const largeNo = qp(await collectLargeObjectClientDurations(noShareRoot));
  const largeSh = qp(await collectLargeObjectClientDurations(sharedRoot));

  const rowNo = {
    scenario: String(metaNo.scenario || gainNo.scenario || ""),
    mode: String(metaNo.proxy_experiment_mode || "no_share_proxy"),
    shareable_requests: gainNo.request_metrics?.shareable_client_requests ?? null,
    unique_objects: gainNo.request_metrics?.unique_share_keys ?? null,
    upstream_bytes: gainNo.byte_metrics?.upstream_bytes_actual ?? null,
    downstream_bytes: gainNo.byte_metrics?.downstream_bytes_total ?? null,
    saved_bytes: gainNo.byte_metrics?.sharing_saved_bytes ?? null,
    sharing_gain_ratio: gainNo.byte_metrics?.sharing_gain_ratio ?? null,
    client_p95_ms: gainNo.latency_metrics?.client_duration_ms_from_cdp?.p95 ?? null,
    client_p99_ms: gainNo.latency_metrics?.client_duration_ms_from_cdp?.p99 ?? null,
    ttfb_p95_ms: gainNo.latency_metrics?.ttfb_ms?.p95 ?? null,
    ttfb_p99_ms: gainNo.latency_metrics?.ttfb_ms?.p99 ?? null,
    large_object_p95_ms: largeNo.p95,
    large_object_p99_ms: largeNo.p99,
    max_per_user_completion_gap_ms: maxCompletionGapMs(gainNo),
  };

  const rowSh = {
    scenario: String(metaSh.scenario || gainSh.scenario || ""),
    mode: String(metaSh.proxy_experiment_mode || "shared_object_proxy"),
    shareable_requests: gainSh.request_metrics?.shareable_client_requests ?? null,
    unique_objects: gainSh.request_metrics?.unique_share_keys ?? null,
    upstream_bytes: gainSh.byte_metrics?.upstream_bytes_actual ?? null,
    downstream_bytes: gainSh.byte_metrics?.downstream_bytes_total ?? null,
    saved_bytes: gainSh.byte_metrics?.sharing_saved_bytes ?? null,
    sharing_gain_ratio: gainSh.byte_metrics?.sharing_gain_ratio ?? null,
    client_p95_ms: gainSh.latency_metrics?.client_duration_ms_from_cdp?.p95 ?? null,
    client_p99_ms: gainSh.latency_metrics?.client_duration_ms_from_cdp?.p99 ?? null,
    ttfb_p95_ms: gainSh.latency_metrics?.ttfb_ms?.p95 ?? null,
    ttfb_p99_ms: gainSh.latency_metrics?.ttfb_ms?.p99 ?? null,
    large_object_p95_ms: largeSh.p95,
    large_object_p99_ms: largeSh.p99,
    max_per_user_completion_gap_ms: maxCompletionGapMs(gainSh),
  };

  const deltas = {
    upstream_bytes_actual: (rowSh.upstream_bytes ?? 0) - (rowNo.upstream_bytes ?? 0),
    downstream_bytes_total: (rowSh.downstream_bytes ?? 0) - (rowNo.downstream_bytes ?? 0),
    sharing_saved_bytes_shared_arm_only: rowSh.saved_bytes ?? null,
    client_p95_ms_delta: (rowSh.client_p95_ms ?? 0) - (rowNo.client_p95_ms ?? 0),
    client_p99_ms_delta: (rowSh.client_p99_ms ?? 0) - (rowNo.client_p99_ms ?? 0),
    ttfb_p95_ms_delta: (rowSh.ttfb_p95_ms ?? 0) - (rowNo.ttfb_p95_ms ?? 0),
    ttfb_p99_ms_delta: (rowSh.ttfb_p99_ms ?? 0) - (rowNo.ttfb_p99_ms ?? 0),
    large_object_p95_ms_delta: (rowSh.large_object_p95_ms ?? 0) - (rowNo.large_object_p95_ms ?? 0),
    large_object_p99_ms_delta: (rowSh.large_object_p99_ms ?? 0) - (rowNo.large_object_p99_ms ?? 0),
  };

  const payload = {
    generated_at: new Date().toISOString(),
    no_share_run_root: noShareRoot,
    shared_run_root: sharedRoot,
    output_dir: outDir,
    pair_checks: pairChecks,
    table_rows: [rowNo, rowSh],
    deltas,
    large_object_threshold_bytes: PAGE_SIZE,
    viewport_sharing_gain_paths: {
      no_share: path.join(noShareRoot, "summary", "viewport_sharing_gain.json"),
      shared: path.join(sharedRoot, "summary", "viewport_sharing_gain.json"),
    },
    extracts: {
      no_share: {
        metrics_source: gainNo.metrics_source,
        instrumented_baseline: gainNo.instrumented_baseline,
        byte_metrics: gainNo.byte_metrics,
        request_metrics: gainNo.request_metrics,
        latency_metrics: gainNo.latency_metrics,
        per_user_fairness: gainNo.per_user_fairness,
      },
      shared: {
        metrics_source: gainSh.metrics_source,
        instrumented_baseline: gainSh.instrumented_baseline,
        byte_metrics: gainSh.byte_metrics,
        request_metrics: gainSh.request_metrics,
        latency_metrics: gainSh.latency_metrics,
        per_user_fairness: gainSh.per_user_fairness,
      },
    },
  };

  await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const header =
    "| Scenario | Mode | Shareable Requests | Unique Objects | Upstream Bytes | Downstream Bytes | Saved Bytes | Sharing Gain | Client P95 | Client P99 |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n";

  function rowMd(r) {
    const gainStr =
      r.sharing_gain_ratio == null || !Number.isFinite(r.sharing_gain_ratio)
        ? ""
        : `${(r.sharing_gain_ratio * 100).toFixed(2)}%`;
    return (
      `| ${mdEscapeCell(r.scenario)} | ${mdEscapeCell(r.mode)} | ${fmtNum(r.shareable_requests)} | ${fmtNum(r.unique_objects)} | ` +
      `${fmtNum(r.upstream_bytes)} | ${fmtNum(r.downstream_bytes)} | ${fmtNum(r.saved_bytes)} | ${mdEscapeCell(gainStr)} | ` +
      `${fmtNum(r.client_p95_ms)} | ${fmtNum(r.client_p99_ms)} |\n`
    );
  }

  const md =
    `# Sharing gain comparison\n\n` +
    `生成时间: ${payload.generated_at}\n\n` +
    `## Pair checks\n\n` +
    `- same_scenario: ${pairChecks.same_scenario}\n` +
    `- same_start_at_unix_ms: ${pairChecks.same_start_at_unix_ms}\n` +
    `- same_expected_users: ${pairChecks.same_expected_users}\n` +
    `- same_duration_ms: ${pairChecks.same_duration_ms}\n` +
    `- same_run_id: ${pairChecks.same_run_id}\n\n` +
    `## Summary table\n\n` +
    header +
    rowMd(rowNo) +
    rowMd(rowSh) +
    `\n## Extra (CDP large responses ≥ ${PAGE_SIZE} bytes encoded length)\n\n` +
    `| Mode | Large-object client duration P95 (ms) | P99 (ms) |\n| --- | ---: | ---: |\n` +
    `| ${mdEscapeCell(rowNo.mode)} | ${fmtNum(rowNo.large_object_p95_ms)} | ${fmtNum(rowNo.large_object_p99_ms)} |\n` +
    `| ${mdEscapeCell(rowSh.mode)} | ${fmtNum(rowSh.large_object_p95_ms)} | ${fmtNum(rowSh.large_object_p99_ms)} |\n\n` +
    `## TTFB (proxy request_complete)\n\n` +
    `| Mode | TTFB P95 (ms) | P99 (ms) |\n| --- | ---: | ---: |\n` +
    `| ${mdEscapeCell(rowNo.mode)} | ${fmtNum(rowNo.ttfb_p95_ms)} | ${fmtNum(rowNo.ttfb_p99_ms)} |\n` +
    `| ${mdEscapeCell(rowSh.mode)} | ${fmtNum(rowSh.ttfb_p95_ms)} | ${fmtNum(rowSh.ttfb_p99_ms)} |\n\n` +
    `## Per-user completion gap (max across users, ms)\n\n` +
    `- ${rowNo.mode}: ${fmtNum(rowNo.max_per_user_completion_gap_ms)}\n` +
    `- ${rowSh.mode}: ${fmtNum(rowSh.max_per_user_completion_gap_ms)}\n`;

  await fs.writeFile(mdPath, md, "utf8");

  console.log(`[compare-sharing-gain] wrote ${mdPath}`);
  console.log(`[compare-sharing-gain] wrote ${jsonPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
