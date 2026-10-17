/**
 * 从 shared-proxy.jsonl 或 instrumented proxy.jsonl + CDP client jsonl + metadata 聚合 viewport 共享收益指标。
 *
 *   node scripts/analyze-viewport-sharing-gain.mjs --runRoot=<rep-*>
 *
 * 优先级：存在 proxy/shared-proxy.jsonl → 共享代理口径；否则若有 instrumented `request_complete` → no_share 基线口径；
 * 二者皆无则占位 skipped exit 0。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { shareKeyAndShareableFromInstrumentedRow } from "./lib/viewport-share-key.mjs";

function parseArgs(argv) {
  let runRoot = "";
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    const k = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const v = eq === -1 ? "" : arg.slice(eq + 1);
    if (k === "runRoot") runRoot = v;
  }
  return { runRoot };
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
  return {
    p50: quantile(arr, 0.5),
    p95: quantile(arr, 0.95),
    p99: quantile(arr, 0.99),
  };
}

function isCdp(r) {
  return r && (!r.source || r.source === "cdp_network");
}

async function collectClientJsonl(runRoot) {
  const paths = [];
  for (const slot of ["local", "remote"]) {
    const dir = path.join(runRoot, slot);
    const ent = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of ent) {
      if (!e.isFile()) continue;
      if (e.name.startsWith("client-") && e.name.endsWith(".jsonl")) paths.push(path.join(dir, e.name));
    }
  }
  return paths;
}

function csvEscape(s) {
  const t = String(s ?? "");
  if (/[,"\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

async function collectCdpClientDuration(runRoot) {
  const clientPaths = await collectClientJsonl(runRoot);
  const cdpDurations = [];
  /** @type {Map<string, number[]>} */
  const byUserDur = new Map();
  for (const fp of clientPaths) {
    const raw = await fs.readFile(fp, "utf8").catch(() => "");
    const uid = (() => {
      const m = /client-(user\d+)\.jsonl$/i.exec(fp);
      return m ? m[1] : path.basename(fp);
    })();
    for (const row of parseJsonl(raw)) {
      if (!isCdp(row)) continue;
      if (row.debug_only) continue;
      const d = Number(row.duration_ms);
      if (!Number.isFinite(d)) continue;
      cdpDurations.push(d);
      if (!byUserDur.has(uid)) byUserDur.set(uid, []);
      byUserDur.get(uid).push(d);
    }
  }
  return { cdpDurations, byUserDur };
}

async function writeGainArtifacts(jsonOut, csvOut, payload) {
  await fs.writeFile(jsonOut, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const flat = [];
  function add(prefix, obj) {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v) && v !== null && !(v instanceof Date)) add(key, v);
      else flat.push([key, v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : v]);
    }
  }
  add("", payload);
  const csvLines = ["metric,value", ...flat.map(([k, v]) => `${csvEscape(k)},${csvEscape(v)}`)];
  await fs.writeFile(csvOut, `${csvLines.join("\n")}\n`, "utf8");
}

function scenarioExpectationsBlock(scenario) {
  return {
    note:
      "同基准比较：B-viewport-lockstep 应有最高 sharing_gain_ratio；C-viewport-nearcohort 中等；D-viewport-divergent 较低。",
    B_viewport_lockstep: "expected_highest_sharing_gain_ratio",
    C_viewport_nearcohort: "expected_medium_sharing_gain_ratio",
    D_viewport_divergent: "expected_low_sharing_gain_ratio",
    current_scenario_class:
      scenario === "B-viewport-lockstep" || scenario.startsWith("B-viewport-lockstep")
        ? "B_viewport"
        : scenario === "C-viewport-nearcohort" || scenario.startsWith("C-viewport-nearcohort")
          ? "C_viewport"
          : scenario === "D-viewport-divergent" || scenario.startsWith("D-viewport-divergent")
            ? "D_viewport"
            : "other",
  };
}

/**
 * @returns {Promise<boolean>} 是否已写出有效指标
 */
async function analyzeInstrumentedProxyJsonl(runRoot, meta, scenario, jsonOut, csvOut) {
  const proxyLogPath = path.join(runRoot, "proxy", "proxy.jsonl");
  const lines = parseJsonl(await fs.readFile(proxyLogPath, "utf8").catch(() => ""));
  const reqs = lines.filter(
    (r) =>
      r.event === "request_complete" &&
      !r.synthetic_from_cdp &&
      r.upstream_target !== "direct_synthetic",
  );
  if (!reqs.length) return false;

  const enriched = reqs.map((r) => ({ row: r, ...shareKeyAndShareableFromInstrumentedRow(r) }));
  const shareRows = enriched.filter((x) => x.shareable).map((x) => x.row);
  const shareKeys = new Set(enriched.filter((x) => x.shareable).map((x) => x.shareKey));
  const total_client_requests = reqs.length;
  const shareable_client_requests = shareRows.length;
  const non_shareable_client_requests = total_client_requests - shareable_client_requests;
  const unique_share_keys = shareKeys.size;

  const inflight_join_count = 0;
  const memory_cache_hit_count = 0;
  const passthrough_count = non_shareable_client_requests;
  const upstream_fetch_count = shareable_client_requests;

  const downstream_bytes_total = reqs.reduce((s, r) => s + (Number(r.downstream_bytes) || 0), 0);
  const no_sharing_estimated_upstream_bytes = shareRows.reduce((s, r) => s + (Number(r.downstream_bytes) || 0), 0);
  const upstream_bytes_actual_all = reqs.reduce((s, r) => s + (Number(r.upstream_bytes) || 0), 0);
  const upstream_bytes_actual_shareable = shareRows.reduce((s, r) => s + (Number(r.upstream_bytes) || 0), 0);

  const sharing_saved_bytes = 0;
  const sharing_gain_ratio = no_sharing_estimated_upstream_bytes > 0 ? 0 : null;

  const { cdpDurations, byUserDur } = await collectCdpClientDuration(runRoot);
  const cd = qp(cdpDurations);

  const totalMsAll = reqs.map((r) => Number(r.service_ms ?? r.total_ms)).filter(Number.isFinite);
  const ttfbAll = reqs.map((r) => Number(r.ttfb_ms)).filter(Number.isFinite);
  const originFetchMs = reqs
    .map((r) => {
      const a = Number(r.upstream_start_ts);
      const b = Number(r.upstream_end_ts);
      if (Number.isFinite(a) && Number.isFinite(b) && b >= a) return b - a;
      return null;
    })
    .filter((x) => x != null && Number.isFinite(x));
  const originLat = reqs.map((r) => Number(r.service_ms)).filter(Number.isFinite);

  /** @type {Map<string, number>} */
  const perUserDown = new Map();
  /** @type {Map<string, number>} */
  const perUserMaxEnd = new Map();
  for (const r of reqs) {
    const uid = String(r.user_id || r.client_id || "unknown");
    perUserDown.set(uid, (perUserDown.get(uid) || 0) + (Number(r.downstream_bytes) || 0));
    const end = Number(r.response_end_ts ?? r.downstream_end_ts);
    if (Number.isFinite(end)) {
      perUserMaxEnd.set(uid, Math.max(perUserMaxEnd.get(uid) ?? end, end));
    }
  }

  const maxCompletion = Math.max(0, ...[...perUserMaxEnd.values()].filter(Number.isFinite));
  const per_user_completion_time = Object.fromEntries(perUserMaxEnd.entries());
  const per_user_completion_gap = Object.fromEntries(
    [...perUserMaxEnd.entries()].map(([u, t]) => [
      u,
      Number.isFinite(maxCompletion) && Number.isFinite(t) ? maxCompletion - t : null,
    ]),
  );

  const per_user_downstream_bytes = Object.fromEntries(perUserDown.entries());
  const per_user_client_p95 = Object.fromEntries(
    [...byUserDur.entries()].map(([u, arr]) => [u, quantile(arr, 0.95)]),
  );

  const payload = {
    generated_at: new Date().toISOString(),
    run_root: runRoot,
    scenario,
    metrics_source: "instrumented_proxy_jsonl",
    instrumented_baseline: true,
    metadata_delivery_mode: meta.delivery_mode ?? null,
    metadata_proxy_experiment_mode: meta.proxy_experiment_mode ?? null,
    shared_proxy_log: null,
    proxy_jsonl_log: path.relative(runRoot, proxyLogPath).replace(/\\/g, "/"),
    skipped: false,

    request_metrics: {
      total_client_requests,
      shareable_client_requests,
      non_shareable_client_requests,
      unique_share_keys,
      upstream_fetch_count,
      inflight_join_count,
      memory_cache_hit_count,
      passthrough_count,
    },

    byte_metrics: {
      downstream_bytes_total,
      upstream_bytes_actual: upstream_bytes_actual_shareable,
      upstream_bytes_charged_sum_all_requests: upstream_bytes_actual_all,
      no_sharing_estimated_upstream_bytes,
      sharing_saved_bytes,
      sharing_gain_ratio,
    },

    coalescing_metrics: {
      coalesced_request_ratio: null,
      upstream_fetch_reduction_ratio: null,
      average_waiter_count_per_origin_fetch: null,
      max_waiter_count_per_origin_fetch: null,
    },

    latency_metrics: {
      client_duration_ms_from_cdp: { p50: cd.p50, p95: cd.p95, p99: cd.p99 },
      shared_proxy_total_ms: qp(totalMsAll),
      ttfb_ms: qp(ttfbAll),
      origin_fetch_ms: qp(originFetchMs),
      memory_cache_hit_latency_p95: null,
      inflight_join_latency_p95: null,
      origin_latency_p95: quantile(originLat, 0.95),
    },

    per_user_fairness: {
      per_user_downstream_bytes,
      per_user_client_p95_ms: per_user_client_p95,
      per_user_completion_time_ms: per_user_completion_time,
      per_user_completion_gap_ms: per_user_completion_gap,
      max_completion_ts_ms_across_users: maxCompletion || null,
    },

    scenario_expectations: scenarioExpectationsBlock(scenario),
  };

  await writeGainArtifacts(jsonOut, csvOut, payload);
  console.log(
    `[analyze-viewport-sharing-gain] instrumented baseline → ${jsonOut} (${total_client_requests} proxy rows, ${cdpDurations.length} CDP rows)`,
  );
  return true;
}

async function main() {
  const { runRoot: rawRoot } = parseArgs(process.argv.slice(2));
  if (!rawRoot) {
    console.error("need --runRoot=");
    process.exitCode = 1;
    return;
  }
  const runRoot = path.resolve(rawRoot);
  const summaryDir = path.join(runRoot, "summary");
  const jsonOut = path.join(summaryDir, "viewport_sharing_gain.json");
  const csvOut = path.join(summaryDir, "viewport_sharing_gain.csv");
  await fs.mkdir(summaryDir, { recursive: true });

  const sharedPath = path.join(runRoot, "proxy", "shared-proxy.jsonl");
  const metaPath = path.join(runRoot, "metadata.json");

  const meta = JSON.parse(await fs.readFile(metaPath, "utf8").catch(() => "{}"));
  const scenario = String(meta.scenario || "");

  if (!existsSync(sharedPath)) {
    const ok = await analyzeInstrumentedProxyJsonl(runRoot, meta, scenario, jsonOut, csvOut);
    if (ok) return;

    const placeholder = {
      generated_at: new Date().toISOString(),
      run_root: runRoot,
      scenario,
      skipped: true,
      skip_reason: "missing_shared_proxy_and_no_instrumented_request_complete",
      scenario_expectations: {
        note:
          "B-viewport-lockstep → 期望 sharing_gain_ratio 最高；C-viewport-nearcohort → 中等；D-viewport-divergent → 较低（相对同一基准）。",
        B_viewport_lockstep: "highest_sharing_gain_ratio",
        C_viewport_nearcohort: "medium_sharing_gain_ratio",
        D_viewport_divergent: "low_sharing_gain_ratio",
      },
    };
    await writeGainArtifacts(jsonOut, csvOut, placeholder);
    console.log(`[analyze-viewport-sharing-gain] skip: ${placeholder.skip_reason}`);
    return;
  }

  const proxyLines = parseJsonl(await fs.readFile(sharedPath, "utf8").catch(() => ""));
  const reqs = proxyLines.filter((r) => r.event === "request_complete");

  const total_client_requests = reqs.length;
  const shareRows = reqs.filter((r) => r.is_shareable === true);
  const shareable_client_requests = shareRows.length;
  const non_shareable_client_requests = total_client_requests - shareable_client_requests;

  const shareKeys = new Set(shareRows.map((r) => String(r.share_key || "")).filter(Boolean));
  const unique_share_keys = shareKeys.size;

  const inflight_join_count = shareRows.filter((r) => r.served_from === "inflight_join").length;
  const memory_cache_hit_count = shareRows.filter((r) => r.served_from === "memory_cache").length;
  const passthrough_count = reqs.filter((r) => r.served_from === "passthrough").length;

  const originLeaderRows = shareRows.filter((r) => r.served_from === "origin");
  const upstream_fetch_count = originLeaderRows.length;

  const downstream_bytes_total = reqs.reduce((s, r) => s + (Number(r.downstream_bytes) || 0), 0);

  const no_sharing_estimated_upstream_bytes = shareRows.reduce((s, r) => s + (Number(r.downstream_bytes) || 0), 0);

  const upstream_bytes_actual_all = reqs.reduce((s, r) => s + (Number(r.upstream_bytes_charged) || 0), 0);
  const upstream_bytes_actual_shareable = shareRows.reduce((s, r) => s + (Number(r.upstream_bytes_charged) || 0), 0);

  const sharing_saved_bytes = no_sharing_estimated_upstream_bytes - upstream_bytes_actual_shareable;
  const sharing_gain_ratio =
    no_sharing_estimated_upstream_bytes > 0 ? sharing_saved_bytes / no_sharing_estimated_upstream_bytes : null;

  const coalesced_request_ratio =
    shareable_client_requests > 0 ? inflight_join_count / shareable_client_requests : null;
  const upstream_fetch_reduction_ratio =
    shareable_client_requests > 0 ? 1 - upstream_fetch_count / shareable_client_requests : null;

  const waiterCounts = originLeaderRows.map((r) => Number(r.coalesced_waiter_count) || 1).filter(Number.isFinite);
  const average_waiter_count_per_origin_fetch =
    waiterCounts.length > 0 ? waiterCounts.reduce((a, b) => a + b, 0) / waiterCounts.length : null;
  const max_waiter_count_per_origin_fetch = waiterCounts.length > 0 ? Math.max(...waiterCounts) : null;

  const totalMsAll = reqs.map((r) => Number(r.total_ms)).filter(Number.isFinite);
  const ttfbAll = reqs.map((r) => Number(r.ttfb_ms)).filter(Number.isFinite);

  const originRows = reqs.filter((r) => r.served_from === "origin");
  const originFetchMs = originRows
    .map((r) => {
      const a = Number(r.upstream_start_ts);
      const b = Number(r.upstream_end_ts);
      if (Number.isFinite(a) && Number.isFinite(b) && b >= a) return b - a;
      return null;
    })
    .filter((x) => x != null && Number.isFinite(x));

  const memLat = reqs.filter((r) => r.served_from === "memory_cache").map((r) => Number(r.total_ms)).filter(Number.isFinite);
  const joinLat = reqs.filter((r) => r.served_from === "inflight_join").map((r) => Number(r.total_ms)).filter(Number.isFinite);
  const originLat = originRows.map((r) => Number(r.total_ms)).filter(Number.isFinite);

  const { cdpDurations, byUserDur } = await collectCdpClientDuration(runRoot);
  const cd = qp(cdpDurations);

  /** @type {Map<string, number>} */
  const perUserDown = new Map();
  /** @type {Map<string, number>} */
  const perUserMaxEnd = new Map();
  for (const r of reqs) {
    const uid = String(r.user_id || r.client_id || "unknown");
    perUserDown.set(uid, (perUserDown.get(uid) || 0) + (Number(r.downstream_bytes) || 0));
    const end = Number(r.response_end_ts ?? r.downstream_end_ts);
    if (Number.isFinite(end)) {
      perUserMaxEnd.set(uid, Math.max(perUserMaxEnd.get(uid) ?? end, end));
    }
  }

  const maxCompletion = Math.max(0, ...[...perUserMaxEnd.values()].filter(Number.isFinite));
  const per_user_completion_time = Object.fromEntries(perUserMaxEnd.entries());
  const per_user_completion_gap = Object.fromEntries(
    [...perUserMaxEnd.entries()].map(([u, t]) => [
      u,
      Number.isFinite(maxCompletion) && Number.isFinite(t) ? maxCompletion - t : null,
    ]),
  );

  const per_user_downstream_bytes = Object.fromEntries(perUserDown.entries());

  const per_user_client_p95 = Object.fromEntries(
    [...byUserDur.entries()].map(([u, arr]) => [u, quantile(arr, 0.95)]),
  );

  const payload = {
    generated_at: new Date().toISOString(),
    run_root: runRoot,
    scenario,
    metrics_source: "shared_proxy_jsonl",
    instrumented_baseline: false,
    metadata_delivery_mode: meta.delivery_mode ?? null,
    metadata_proxy_experiment_mode: meta.proxy_experiment_mode ?? null,
    shared_proxy_log: path.relative(runRoot, sharedPath).replace(/\\/g, "/"),
    proxy_jsonl_log: path.relative(runRoot, path.join(runRoot, "proxy", "proxy.jsonl")).replace(/\\/g, "/"),
    skipped: false,

    request_metrics: {
      total_client_requests,
      shareable_client_requests,
      non_shareable_client_requests,
      unique_share_keys,
      upstream_fetch_count,
      inflight_join_count,
      memory_cache_hit_count,
      passthrough_count,
    },

    byte_metrics: {
      downstream_bytes_total,
      /** 仅 shareable 行的 upstream_bytes_charged 之和（与 no_sharing 口径一致，用于 gain） */
      upstream_bytes_actual: upstream_bytes_actual_shareable,
      upstream_bytes_charged_sum_all_requests: upstream_bytes_actual_all,
      no_sharing_estimated_upstream_bytes,
      sharing_saved_bytes,
      sharing_gain_ratio,
    },

    coalescing_metrics: {
      coalesced_request_ratio,
      upstream_fetch_reduction_ratio,
      average_waiter_count_per_origin_fetch,
      max_waiter_count_per_origin_fetch,
    },

    latency_metrics: {
      client_duration_ms_from_cdp: { p50: cd.p50, p95: cd.p95, p99: cd.p99 },
      shared_proxy_total_ms: qp(totalMsAll),
      ttfb_ms: qp(ttfbAll),
      origin_fetch_ms: qp(originFetchMs),
      memory_cache_hit_latency_p95: quantile(memLat, 0.95),
      inflight_join_latency_p95: quantile(joinLat, 0.95),
      origin_latency_p95: quantile(originLat, 0.95),
    },

    per_user_fairness: {
      per_user_downstream_bytes,
      per_user_client_p95_ms: per_user_client_p95,
      per_user_completion_time_ms: per_user_completion_time,
      per_user_completion_gap_ms: per_user_completion_gap,
      max_completion_ts_ms_across_users: maxCompletion || null,
    },

    scenario_expectations: scenarioExpectationsBlock(scenario),
  };

  await writeGainArtifacts(jsonOut, csvOut, payload);

  console.log(`[analyze-viewport-sharing-gain] wrote ${jsonOut} (${total_client_requests} proxy requests, ${cdpDurations.length} CDP rows)`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
