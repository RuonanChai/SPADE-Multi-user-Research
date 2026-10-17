import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const out = {
    input: "",
    includeInvalid: false,
    windowMs: 500,
    tReadyMark: "first_acceptable_visible_render",
    tReadyMarkList: [],
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "input") out.input = v || out.input;
    else if (k === "include-invalid") out.includeInvalid = v === "1" || v === "true" || v === "";
    else if (k === "window-ms") out.windowMs = Number.parseInt(v || "500", 10);
    else if (k === "t-ready-mark") out.tReadyMark = v || out.tReadyMark;
    else if (k === "t-ready-mark-list") {
      out.tReadyMarkList = (v || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    }
  }
  return out;
}

async function readJsonSafe(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function readJsonlSafe(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return raw
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => JSON.parse(x));
  } catch {
    return [];
  }
}

function csv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const body = rows
    .map((r) =>
      headers
        .map((h) => {
          const v = r[h];
          if (v == null) return "";
          const s = String(v).replaceAll('"', '""');
          return /[,"\n]/.test(s) ? `"${s}"` : s;
        })
        .join(","),
    )
    .join("\n");
  return `${headers.join(",")}\n${body}\n`;
}

function percentile(values, p) {
  const sorted = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx];
}

function mean(values) {
  const xs = values.filter((x) => Number.isFinite(x));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(values) {
  const xs = values.filter((x) => Number.isFinite(x));
  if (xs.length < 2) return null;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
  return Math.sqrt(v);
}

function by(arr, key) {
  const m = new Map();
  for (const x of arr) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

function unique(arr) {
  return Array.from(new Set(arr));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) throw new Error("缺少 --input");
  const root = path.resolve(args.input);
  const summaryDir = path.join(root, "summary");
  const reportDir = path.join(root, "reports");
  await fs.mkdir(summaryDir, { recursive: true });
  await fs.mkdir(reportDir, { recursive: true });

  const entries = await fs.readdir(root, { withFileTypes: true });
  const runDirs = entries.filter((e) => e.isDirectory() && e.name.startsWith("run-")).map((e) => path.join(root, e.name));
  const validRuns = [];
  const invalidRuns = [];
  const objectRows = [];
  const schedulerRows = [];
  const poseRows = [];
  const cacheRows = [];
  const e2eRows = [];
  const networkRows = [];
  const mainThreadRows = [];
  const renderRows = [];
  const gpuRows = [];
  const warnings = [];
  const overlapMetricRows = [];
  const cacheEffectRows = [];
  const schedulerMetricRows = [];
  const tReadyMarksByRunClient = new Map();
  const activeTReadyMarks = unique([
    args.tReadyMark,
    ...(Array.isArray(args.tReadyMarkList) ? args.tReadyMarkList : []),
  ]);

  for (const runDir of runDirs) {
    const runMeta = await readJsonSafe(path.join(runDir, "run-metadata.json"));
    if (!runMeta) continue;
    const runAllowed = args.includeInvalid || runMeta.valid === true;
    if (!runAllowed) {
      invalidRuns.push(runMeta);
      continue;
    }
    if (runMeta.valid !== true) invalidRuns.push(runMeta);
    else validRuns.push(runMeta);
    const clientEntries = await fs.readdir(runDir, { withFileTypes: true });
    const clients = clientEntries.filter((e) => e.isDirectory() && e.name.startsWith("client-"));
    for (const c of clients) {
      const cdir = path.join(runDir, c.name);
      const pose = await readJsonlSafe(path.join(cdir, "pose-trace.jsonl"));
      const sched = await readJsonlSafe(path.join(cdir, "scheduler-decisions.jsonl"));
      const res = await readJsonlSafe(path.join(cdir, "resource-timing.jsonl"));
      const marks = await readJsonlSafe(path.join(cdir, "app-performance-marks.jsonl"));
      const page = await readJsonSafe(path.join(cdir, "page-main-thread-summary.json"));
      const traceSummary = await readJsonSafe(path.join(cdir, "chrome-trace-summary.json"));
      poseRows.push(...pose.map((x) => ({ run_id: runMeta.run_id, ...x })));
      schedulerRows.push(...sched.map((x) => ({ run_id: runMeta.run_id, ...x })));
      networkRows.push(...res.map((x) => ({ run_id: runMeta.run_id, ...x })));
      objectRows.push(
        ...res.map((x) => ({
          run_id: runMeta.run_id,
          scenario_id: runMeta.scenario_id,
          cache_mode: runMeta.cache_mode,
          client_id: x.client_id,
          object_url: x.object_url,
          ttfb_ms: x.ttfb_ms,
          ttlb_ms: x.ttlb_ms,
          transfer_size: x.transfer_size,
          next_hop_protocol: x.next_hop_protocol,
        })),
      );
      if (page) mainThreadRows.push({ run_id: runMeta.run_id, ...page });
      if (traceSummary) gpuRows.push({ run_id: runMeta.run_id, ...traceSummary });

      const byMark = marks.reduce((acc, m) => {
        acc[m.name] = acc[m.name] ?? [];
        acc[m.name].push(m.ts_ms);
        return acc;
      }, {});
      const first = (name) => (byMark[name]?.length ? byMark[name][0] : null);
      const poseToReady =
        first("first_acceptable_visible_render") != null && first("pose_update_start") != null
          ? first("first_acceptable_visible_render") - first("pose_update_start")
          : null;
      e2eRows.push({
        run_id: runMeta.run_id,
        scenario_id: runMeta.scenario_id,
        cache_mode: runMeta.cache_mode,
        client_id: c.name.replace("client-", ""),
        pose_to_scheduler_ms:
          first("fetch_enqueue_time") != null && first("pose_update_start") != null
            ? first("fetch_enqueue_time") - first("pose_update_start")
            : null,
        scheduler_decision_ms:
          first("object_schedule_end") != null && first("object_schedule_start") != null
            ? first("object_schedule_end") - first("object_schedule_start")
            : null,
        fetch_queue_wait_ms:
          first("fetch_start_time") != null && first("fetch_enqueue_time") != null
            ? first("fetch_start_time") - first("fetch_enqueue_time")
            : null,
        decode_ms:
          first("object_decode_end") != null && first("object_decode_start") != null
            ? first("object_decode_end") - first("object_decode_start")
            : null,
        geometry_parse_ms:
          first("geometry_parse_end") != null && first("geometry_parse_start") != null
            ? first("geometry_parse_end") - first("geometry_parse_start")
            : null,
        gpu_upload_ms:
          first("gpu_upload_end") != null && first("gpu_upload_start") != null
            ? first("gpu_upload_end") - first("gpu_upload_start")
            : null,
        render_wait_ms:
          first("first_frame_after_pose_update") != null && first("pose_update_end") != null
            ? first("first_frame_after_pose_update") - first("pose_update_end")
            : null,
        pose_to_visible_ready_ms: poseToReady,
      });
      renderRows.push({
        run_id: runMeta.run_id,
        scenario_id: runMeta.scenario_id,
        cache_mode: runMeta.cache_mode,
        client_id: c.name.replace("client-", ""),
        first_acceptable_visible_render_ms: first("first_acceptable_visible_render"),
        first_frame_after_pose_update_ms: first("first_frame_after_pose_update"),
      });
      const runClientKey = `${runMeta.run_id}:${c.name.replace("client-", "")}`;
      const markMap = {};
      for (const markName of activeTReadyMarks) {
        markMap[markName] = first(markName);
      }
      tReadyMarksByRunClient.set(runClientKey, markMap);
    }
    const cacheSummary = await readJsonSafe(path.join(runDir, "cdn", "cache-status-summary.json"));
    if (cacheSummary?.rows) cacheRows.push(...cacheSummary.rows.map((r) => ({ run_id: runMeta.run_id, ...r })));
  }

  const objectsByRun = new Map();
  const overlapRows = [];
  const runObjectRows = by(objectRows, (r) => r.run_id);
  for (const [runId, rows] of runObjectRows.entries()) {
    const objSet = new Set(rows.map((x) => x.object_url));
    objectsByRun.set(runId, objSet);
    const aggBytes = rows.reduce((a, b) => a + Number(b.transfer_size || 0), 0);
    const uniqueBytes = Array.from(
      rows.reduce((m, x) => {
        if (!m.has(x.object_url)) m.set(x.object_url, Number(x.transfer_size || 0));
        return m;
      }, new Map()),
    ).reduce((a, [, sz]) => a + sz, 0);
    const byteOverlapRatio = aggBytes > 0 ? 1 - uniqueBytes / aggBytes : null;
    overlapRows.push({
      run_id: runId,
      unique_object_count: objSet.size,
      aggregate_client_object_count: rows.length,
      aggregate_client_bytes: aggBytes,
      unique_object_bytes: uniqueBytes,
      byte_overlap_ratio: byteOverlapRatio,
    });
    overlapMetricRows.push({
      run_id: runId,
      object_overlap_p50: null,
      object_overlap_p95: null,
      byte_overlap_ratio: byteOverlapRatio,
      time_windowed_overlap_ratio: null,
    });
  }

  const cacheByStatus = cacheRows.reduce((acc, x) => {
    const k = x.cf_cache_status || "unknown";
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const totalCacheReq = Object.values(cacheByStatus).reduce((a, b) => a + b, 0) || 1;
  const hitReq = (cacheByStatus.HIT || 0) + (cacheByStatus.hit || 0);
  const cacheHitRatio = hitReq / totalCacheReq;
  const cacheRowsByRun = by(cacheRows, (x) => x.run_id);
  for (const [runId, rows] of cacheRowsByRun.entries()) {
    const totalReq = rows.length || 1;
    const totalBytes = rows.reduce((a, b) => a + Number(b.transfer_size || 0), 0) || 1;
    const hitRows = rows.filter((x) => String(x.cf_cache_status || "").toUpperCase() === "HIT");
    const missLike = rows.filter((x) =>
      ["MISS", "EXPIRED", "REVALIDATED", "BYPASS"].includes(String(x.cf_cache_status || "").toUpperCase()),
    );
    const hitBytes = hitRows.reduce((a, b) => a + Number(b.transfer_size || 0), 0);
    const originBytes = missLike.reduce((a, b) => a + Number(b.transfer_size || 0), 0);
    const rowOverlap = overlapRows.find((x) => x.run_id === runId);
    const aggClientBytes = Number(rowOverlap?.aggregate_client_bytes || 0);
    const uniqueObjectBytes = Number(rowOverlap?.unique_object_bytes || 0);
    const cdnReuseGain = aggClientBytes > 0 ? 1 - originBytes / aggClientBytes : null;
    const denom = aggClientBytes - uniqueObjectBytes;
    const cacheRealization = denom > 0 ? (aggClientBytes - originBytes) / denom : null;
    cacheEffectRows.push({
      run_id: runId,
      cache_hit_ratio: hitRows.length / totalReq,
      byte_hit_ratio: hitBytes / totalBytes,
      origin_request_ratio: missLike.length / totalReq,
      origin_byte_ratio: originBytes / totalBytes,
      estimated_origin_bytes: originBytes,
      cdn_reuse_gain: cdnReuseGain,
      cache_realization: cacheRealization,
    });
  }

  const schedulerByRunClient = by(schedulerRows, (x) => `${x.run_id}:${x.client_id}`);
  for (const [key, rows] of schedulerByRunClient.entries()) {
    const [runId, clientId] = key.split(":");
    const high = rows
      .slice()
      .sort((a, b) => Number(b.utility_score || b.priority || 0) - Number(a.utility_score || a.priority || 0));
    const topK = Math.max(1, Math.ceil(high.length * 0.2));
    const highSet = new Set(high.slice(0, topK).map((x) => x.object_url));
    const netRows = networkRows.filter((n) => n.run_id === runId && n.client_id === clientId);
    const highNet = netRows.filter((n) => highSet.has(n.object_url));
    const visibleHigh = rows.filter((r) => r.visibility_flag && highSet.has(r.object_url)).map((r) => r.object_url);
    const completion = netRows.filter((n) => visibleHigh.includes(n.object_url));
    const highTtfb = highNet.map((n) => Number(n.ttfb_ms));
    const highTtlb = highNet.map((n) => Number(n.ttlb_ms));
    const schedulerByObject = rows.reduce((acc, r) => {
      if (!acc.has(r.object_url)) acc.set(r.object_url, r);
      return acc;
    }, new Map());
    const inversionPairs = [];
    for (const n of netRows) {
      const prio = rows.find((r) => r.object_url === n.object_url);
      if (!prio) continue;
      inversionPairs.push({ object_url: n.object_url, ttlb: Number(n.ttlb_ms || 0), score: Number(prio.utility_score || prio.priority || 0) });
    }
    let inv = 0;
    let cmp = 0;
    for (let i = 0; i < inversionPairs.length; i += 1) {
      for (let j = i + 1; j < inversionPairs.length; j += 1) {
        const a = inversionPairs[i];
        const b = inversionPairs[j];
        if (a.score === b.score) continue;
        cmp += 1;
        if ((a.score < b.score && a.ttlb < b.ttlb) || (b.score < a.score && b.ttlb < a.ttlb)) inv += 1;
      }
    }
    const tReadyMarkMap = tReadyMarksByRunClient.get(`${runId}:${clientId}`) || {};
    for (const markName of activeTReadyMarks) {
      const tReady = tReadyMarkMap[markName];
      const earlyRows =
        tReady != null
          ? netRows.filter((n) => Number(n.response_end_ms) <= Number(tReady))
          : [];
      const usefulEarlyBytes = earlyRows
        .filter((n) => {
          const s = schedulerByObject.get(n.object_url);
          if (!s) return false;
          return Boolean(s.visibility_flag) || highSet.has(n.object_url);
        })
        .reduce((a, b) => a + Number(b.transfer_size || 0), 0);
      const allEarlyBytes = earlyRows.reduce((a, b) => a + Number(b.transfer_size || 0), 0);
      schedulerMetricRows.push({
        run_id: runId,
        client_id: clientId,
        high_priority_definition: "top_20pct_utility_score_per_decision_window",
        visible_object_aat_p50: percentile(completion.map((x) => Number(x.ttlb_ms)), 0.5),
        visible_object_aat_p95: percentile(completion.map((x) => Number(x.ttlb_ms)), 0.95),
        visible_object_aat_p99: percentile(completion.map((x) => Number(x.ttlb_ms)), 0.99),
        high_priority_ttfb_p50: percentile(highTtfb, 0.5),
        high_priority_ttfb_p95: percentile(highTtfb, 0.95),
        high_priority_ttfb_p99: percentile(highTtfb, 0.99),
        high_priority_ttlb_p50: percentile(highTtlb, 0.5),
        high_priority_ttlb_p95: percentile(highTtlb, 0.95),
        high_priority_ttlb_p99: percentile(highTtlb, 0.99),
        visible_high_priority_completion_p50: percentile(completion.map((x) => Number(x.ttlb_ms)), 0.5),
        visible_high_priority_completion_p95: percentile(completion.map((x) => Number(x.ttlb_ms)), 0.95),
        visible_high_priority_completion_p99: percentile(completion.map((x) => Number(x.ttlb_ms)), 0.99),
        priority_inversion_ratio: cmp > 0 ? inv / cmp : null,
        useful_early_byte_ratio: allEarlyBytes > 0 ? usefulEarlyBytes / allEarlyBytes : null,
        t_ready_ms: tReady ?? null,
        t_ready_mark: markName,
      });
    }
  }

  const tReadyComparisonRows = activeTReadyMarks.map((markName) => {
    const rows = schedulerMetricRows.filter((x) => x.t_ready_mark === markName);
    const usefulVals = rows.map((x) => Number(x.useful_early_byte_ratio));
    const tReadyVals = rows.map((x) => Number(x.t_ready_ms));
    return {
      t_ready_mark: markName,
      sample_count: rows.length,
      useful_early_byte_ratio_mean: mean(usefulVals),
      useful_early_byte_ratio_p50: percentile(usefulVals, 0.5),
      useful_early_byte_ratio_p95: percentile(usefulVals, 0.95),
      t_ready_ms_mean: mean(tReadyVals),
      t_ready_ms_p50: percentile(tReadyVals, 0.5),
      t_ready_ms_p95: percentile(tReadyVals, 0.95),
    };
  });

  const poseReadyVals = e2eRows.map((x) => x.pose_to_visible_ready_ms);
  const scenarioSummary = {
    valid_run_count: validRuns.length,
    invalid_run_count: invalidRuns.length,
    cache_hit_ratio: cacheHitRatio,
    pose_to_visible_ready_ms: {
      p50: percentile(poseReadyVals, 0.5),
      p95: percentile(poseReadyVals, 0.95),
      p99: percentile(poseReadyVals, 0.99),
      mean: mean(poseReadyVals),
      std: std(poseReadyVals),
    },
    warnings,
    t_ready_mark: args.tReadyMark,
    t_ready_mark_list: activeTReadyMarks,
  };

  await fs.writeFile(path.join(summaryDir, "client-object-timing.csv"), csv(objectRows));
  await fs.writeFile(path.join(summaryDir, "scheduler-decisions.csv"), csv(schedulerRows));
  await fs.writeFile(path.join(summaryDir, "pose-trace.csv"), csv(poseRows));
  await fs.writeFile(path.join(summaryDir, "object-overlap-summary.csv"), csv(overlapRows));
  await fs.writeFile(path.join(summaryDir, "cache-status-summary.csv"), csv(cacheEffectRows));
  await fs.writeFile(path.join(summaryDir, "e2e-breakdown.csv"), csv(e2eRows));
  await fs.writeFile(path.join(summaryDir, "network-breakdown.csv"), csv(networkRows));
  await fs.writeFile(path.join(summaryDir, "main-thread-summary.csv"), csv(mainThreadRows));
  await fs.writeFile(path.join(summaryDir, "render-summary.csv"), csv(renderRows));
  await fs.writeFile(path.join(summaryDir, "gpu-trace-summary.csv"), csv(gpuRows));
  await fs.writeFile(path.join(summaryDir, "scheduler-effectiveness.csv"), csv(schedulerMetricRows));
  await fs.writeFile(path.join(summaryDir, "t-ready-mark-comparison.csv"), csv(tReadyComparisonRows));
  await fs.writeFile(path.join(summaryDir, "overlap-metrics.csv"), csv(overlapMetricRows));
  await fs.writeFile(path.join(summaryDir, "cdn-effectiveness.csv"), csv(cacheEffectRows));
  await fs.writeFile(path.join(summaryDir, "scenario-summary.json"), JSON.stringify(scenarioSummary, null, 2));

  const report = `# CDN Overlap Report

## Experiment configuration
- Main mode: direct browser-to-CDN (no local proxy in main path)
- Workload: pose-driven (trace replay only debug/ablation)
- Valid runs: ${validRuns.length}
- Invalid runs: ${invalidRuns.length}

## Scenario definitions
- A_single_user: single baseline
- B_lockstep_high_overlap: same pose sequence
- C_nearcohort_partial_overlap: staggered offsets and perturbations
- D_divergent_low_overlap: different paths
- E_split_cohort_dynamic: converge-split-reconverge

## Cache mode definitions
- cold_cache: versioned cache key
- warm_cache: warmup common objects
- mixed_cache: warm common, tail cold

## Key metrics
- cache_hit_ratio: ${cacheHitRatio.toFixed(4)}
- pose_to_visible_ready_ms p50/p95/p99: ${scenarioSummary.pose_to_visible_ready_ms.p50 ?? "n/a"} / ${scenarioSummary.pose_to_visible_ready_ms.p95 ?? "n/a"} / ${scenarioSummary.pose_to_visible_ready_ms.p99 ?? "n/a"}
- cdn_reuse_gain(mean): ${mean(cacheEffectRows.map((x) => Number(x.cdn_reuse_gain))) ?? "n/a"}
- priority_inversion_ratio(mean): ${mean(schedulerMetricRows.map((x) => Number(x.priority_inversion_ratio))) ?? "n/a"}
- useful_early_byte_ratio default T_ready mark: ${args.tReadyMark}
- t-ready-mark-list analyzed: ${activeTReadyMarks.join(", ")}

## Interpretation notes
- Main results use direct browser-to-CDN requests.
- Local proxy is not used in the main measurement path.
- Object requests are generated by Spark2.0 from controlled camera poses.
- Resource Timing provides browser-observed network timing.
- Chromium trace GPU events are diagnostics, not exact draw-call GPU execution time.
- Exact GPU command time requires WebGL/WebGPU timer query and is optional.
`;
  await fs.writeFile(path.join(reportDir, "cdn_overlap_report.md"), report);
  const comparisonLines = [
    "# T-ready Mark Sensitivity",
    "",
    ...tReadyComparisonRows.map(
      (r) =>
        `- ${r.t_ready_mark}: useful_early_byte_ratio mean/p50/p95 = ${r.useful_early_byte_ratio_mean ?? "n/a"} / ${r.useful_early_byte_ratio_p50 ?? "n/a"} / ${r.useful_early_byte_ratio_p95 ?? "n/a"}, t_ready_ms mean = ${r.t_ready_ms_mean ?? "n/a"}, samples = ${r.sample_count}`,
    ),
    "",
  ].join("\n");
  await fs.writeFile(path.join(reportDir, "t-ready-mark-comparison.md"), comparisonLines);
  console.log(`analysis completed: ${summaryDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
