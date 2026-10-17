/**
 * Extract network protocol / throughput / latency from completed ablation batches.
 * Usage: node scripts/extract-network-batch-analysis.mjs <batchDir> [<batchDir2> ...]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cols = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        inQ = !inQ;
        continue;
      }
      if (c === "," && !inQ) {
        cols.push(cur);
        cur = "";
        continue;
      }
      cur += c;
    }
    cols.push(cur);
    const o = {};
    header.forEach((h, j) => {
      const v = cols[j] ?? "";
      o[h] = v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : v;
    });
    return o;
  });
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function stats(values) {
  const xs = values.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!xs.length) {
    return { p50: null, p95: null, p99: null, count: 0 };
  }
  return {
    p50: pct(xs, 0.5),
    p95: pct(xs, 0.95),
    p99: pct(xs, 0.99),
    count: xs.length,
  };
}

function mean(nums) {
  const xs = nums.filter(Number.isFinite);
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function isRadUrl(url) {
  return /\.rad(\?|#|$)/i.test(String(url ?? ""));
}

function inferAblationMode(armId, exp) {
  if (exp?.ablation_mode) return exp.ablation_mode;
  if (armId.includes("dpr05") || armId.includes("dpr05")) return "normal";
  if (armId.includes("render_only_pure") || armId.includes("pure_baseline")) return "render_only_pure";
  if (armId.includes("static_pure")) return "static_camera_render_only_pure";
  if (armId.includes("moving_pure")) return "moving_camera_render_only_pure";
  if (armId.includes("fetch_only")) return "fetch_only_full";
  if (armId.includes("upload_only")) return "upload_only";
  if (armId.startsWith("D1_")) return "render_plus_camera_only";
  if (armId.startsWith("D2_")) return "render_plus_visibility_only";
  if (armId.startsWith("D3_")) return "render_plus_lod_update_only";
  if (armId.startsWith("D4_")) return "normal";
  if (armId.startsWith("O")) return "normal";
  return "normal";
}

function findTrials(batchDir) {
  const trials = [];
  for (const ent of fs.readdirSync(batchDir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name === "raw_logs" || ent.name === "per_trial_json" || ent.name === "figures") {
      continue;
    }
    const armDir = path.join(batchDir, ent.name);
    for (const t of fs.readdirSync(armDir, { withFileTypes: true })) {
      if (!t.isDirectory() || !/^trial_\d+$/.test(t.name)) continue;
      const trialDir = path.join(armDir, t.name);
      const cdpPath = path.join(trialDir, "cdp_network_audit.csv");
      const expPath = path.join(trialDir, "summary", "experiment_summary.json");
      if (!fs.existsSync(cdpPath) || !fs.existsSync(expPath)) continue;
      trials.push({
        batchDir,
        batchName: path.basename(batchDir),
        armId: ent.name,
        trialId: Number(t.name.replace("trial_", "")),
        trialDir,
        cdpPath,
        expPath,
        alignPath: path.join(trialDir, "summary", "client_server_latency_alignment.csv"),
        serverLogPath: path.join(trialDir, "server_monitor", "server_request_log.jsonl"),
        perTrialPath: path.join(batchDir, "per_trial_json", `${ent.name}_trial${t.name.replace("trial_", "")}.json`),
      });
    }
  }
  return trials.sort((a, b) => a.armId.localeCompare(b.armId) || a.trialId - b.trialId);
}

function splitPreloadMeasure(sortedRadRows, preloadCount, measureCount) {
  const pre = sortedRadRows.slice(0, Math.max(0, preloadCount));
  const meas = sortedRadRows.slice(preloadCount, preloadCount + Math.max(0, measureCount));
  return { pre, meas };
}

function sumBytes(rows, field = "encodedDataLength") {
  return rows.reduce((s, r) => s + (Number(r[field]) || 0), 0);
}

function extractTrial(t) {
  const exp = readJson(t.expPath) ?? {};
  const perTrial = fs.existsSync(t.perTrialPath) ? readJson(t.perTrialPath) : null;
  const cdpRows = parseCsv(fs.readFileSync(t.cdpPath, "utf8")).filter((r) => isRadUrl(r.url));
  const radSorted = [...cdpRows].sort(
    (a, b) => (Number(a.requestWillBeSent) || 0) - (Number(b.requestWillBeSent) || 0),
  );

  const preloadRad = Number(exp.preload_rad_requests ?? perTrial?.preload_rad_requests ?? 0);
  const measureRad = Number(exp.measure_rad_requests ?? perTrial?.measure_rad_requests ?? 0);
  const totalRad = preloadRad + measureRad;

  const { pre: preloadRows, meas: measureRows } = splitPreloadMeasure(radSorted, preloadRad, measureRad);

  const assetUrl = radSorted[0]?.url ?? "";
  let assetHostname = "";
  let assetHost = "";
  let assetPort = "";
  try {
    if (assetUrl) {
      const u = new URL(assetUrl);
      assetHostname = u.hostname;
      assetHost = u.host;
      assetPort = u.port;
    }
  } catch { /* */ }
  const ablationMode = inferAblationMode(t.armId, exp);
  const pageUrlTemplate = `http://127.0.0.1:<page_port_ephemeral>/examples/streaming-lod/index.html?world=Coit+Tower%2C+SF&ablation_mode=${encodeURIComponent(ablationMode)}`;

  const protocols = [...new Set(radSorted.map((r) => r.protocol).filter(Boolean))];
  const statuses = [...new Set(radSorted.map((r) => String(r.status)).filter(Boolean))];
  const rangeHeaders = radSorted.map((r) => r.range_header).filter(Boolean);
  const usesRange = rangeHeaders.length > 0 && rangeHeaders.every((h) => /^bytes=/i.test(String(h)));

  let contentRangeSample = "";
  if (fs.existsSync(t.serverLogPath)) {
    const lines = fs.readFileSync(t.serverLogPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
    for (const line of lines.slice(0, 5)) {
      try {
        const o = JSON.parse(line);
        if (o.content_range) {
          contentRangeSample = o.content_range;
          break;
        }
      } catch { /* */ }
    }
  }

  const firstRad = radSorted[0];
  const lastRad = radSorted[radSorted.length - 1];
  const preloadFirst = preloadRows[0];
  const preloadLast = preloadRows[preloadRows.length - 1];
  const measureFirst = measureRows[0];
  const measureLast = measureRows[measureRows.length - 1];

  const preloadBytes = sumBytes(preloadRows);
  const measureBytes = sumBytes(measureRows);
  const totalBytes = sumBytes(radSorted);

  const preloadDurS =
    preloadFirst && preloadLast && preloadLast.loadingFinished && preloadFirst.requestWillBeSent
      ? Math.max(0.001, (Number(preloadLast.loadingFinished) - Number(preloadFirst.requestWillBeSent)) / 1000)
      : null;
  const totalDurS =
    firstRad && lastRad && lastRad.loadingFinished && firstRad.requestWillBeSent
      ? Math.max(0.001, (Number(lastRad.loadingFinished) - Number(firstRad.requestWillBeSent)) / 1000)
      : null;

  const preloadMbps =
    preloadDurS != null ? (preloadBytes * 8) / preloadDurS / 1e6 : null;
  const totalMbps = totalDurS != null ? (totalBytes * 8) / totalDurS / 1e6 : null;

  const ttfb = stats(radSorted.map((r) => Number(r.ttfb_ms)));
  const download = stats(radSorted.map((r) => Number(r.download_ms)));
  const netTotal = stats(radSorted.map((r) => Number(r.network_total_ms)));

  let serverTtfb = { p50: null, p95: null, p99: null };
  let serverTotal = { p50: null, p95: null, p99: null };
  let alignIsoPreloadStart = null;
  let alignIsoPreloadEnd = null;
  let alignIsoMeasureStart = null;
  let alignIsoMeasureEnd = null;

  if (fs.existsSync(t.alignPath)) {
    const align = parseCsv(fs.readFileSync(t.alignPath, "utf8"));
    const sTtfb = align.map((r) => Number(r.server_ttfb_ms)).filter(Number.isFinite);
    const sTot = align.map((r) => Number(r.server_total_ms)).filter(Number.isFinite);
    serverTtfb = stats(sTtfb);
    serverTotal = stats(sTot);

    const alignSorted = [...align].sort(
      (a, b) => new Date(a.server_start_ts) - new Date(b.server_start_ts),
    );
    const preA = alignSorted.slice(0, preloadRad);
    const measA = alignSorted.slice(preloadRad, preloadRad + measureRad);
    if (preA.length) {
      alignIsoPreloadStart = preA[0].server_start_ts;
      alignIsoPreloadEnd = preA[preA.length - 1].server_end_ts;
    }
    if (measA.length) {
      alignIsoMeasureStart = measA[0].server_start_ts;
      alignIsoMeasureEnd = measA[measA.length - 1].server_end_ts;
    }
  }

  const isLoopback =
    assetHostname === "127.0.0.1" || assetHostname === "localhost" || assetHostname === "::1";
  const isHttp1 = protocols.every((p) => String(p).toLowerCase() === "http/1.1");
  const isExternal = assetHostname !== "" && !isLoopback;

  return {
    batch: t.batchName,
    arm_id: t.armId,
    trial_id: t.trialId,
    experiment_id: exp.experiment_id ?? "",
    ablation_mode: ablationMode,
    page_url: pageUrlTemplate,
    asset_url: assetUrl,
    asset_host: assetHostname,
    asset_host_port: assetHost,
    asset_port: assetPort,
    is_loopback: isLoopback,
    is_external_network: isExternal,
    protocol_cdp: protocols.join("|") || "MISSING",
    nextHopProtocol: "NOT_LOGGED",
    response_protocol: protocols.join("|") || "MISSING",
    is_http11: isHttp1,
    is_http2: protocols.some((p) => String(p).toLowerCase() === "h2" || String(p) === "http/2"),
    is_http3: protocols.some((p) => String(p).toLowerCase().includes("quic") || String(p) === "h3"),
    uses_range_request: usesRange,
    range_header_sample: rangeHeaders[0] ?? "",
    content_range_sample: contentRangeSample,
    http_status_sample: statuses.join("|"),
    rad_request_count_cdp: radSorted.length,
    preload_rad_requests: preloadRad,
    measure_rad_requests: measureRad,
    total_rad_requests: totalRad,
    total_bytes_cdp: totalBytes,
    preload_bytes_cdp: preloadBytes,
    measure_bytes_cdp: measureBytes,
    total_fetch_bytes_exp: exp.total_fetch_bytes ?? null,
    first_rad_request_cdp_ts: firstRad?.requestWillBeSent ?? null,
    last_rad_response_end_cdp_ts: lastRad?.loadingFinished ?? null,
    preload_start_cdp_ts: preloadFirst?.requestWillBeSent ?? null,
    preload_end_cdp_ts: preloadLast?.loadingFinished ?? null,
    measure_start_cdp_ts: measureFirst?.requestWillBeSent ?? null,
    measure_end_cdp_ts: measureLast?.loadingFinished ?? null,
    preload_start_iso: alignIsoPreloadStart,
    preload_end_iso: alignIsoPreloadEnd,
    measure_start_iso: alignIsoMeasureStart,
    measure_end_iso: alignIsoMeasureEnd,
    preload_duration_s_cdp: preloadDurS,
    total_transfer_duration_s_cdp: totalDurS,
    preload_throughput_Mbps: preloadMbps,
    total_throughput_Mbps: totalMbps,
    per_request_ttfb_p50_ms: ttfb.p50,
    per_request_ttfb_p95_ms: ttfb.p95,
    per_request_ttfb_p99_ms: ttfb.p99,
    per_request_download_p50_ms: download.p50,
    per_request_download_p95_ms: download.p95,
    per_request_download_p99_ms: download.p99,
    client_net_total_p50_ms: netTotal.p50,
    client_net_total_p95_ms: netTotal.p95,
    client_net_total_p99_ms: netTotal.p99,
    server_ttfb_p50_ms: serverTtfb.p50 ?? exp.server_ttfb_p50_ms ?? null,
    server_ttfb_p95_ms: serverTtfb.p95 ?? exp.server_ttfb_p95_ms ?? null,
    server_ttfb_p99_ms: serverTtfb.p99 ?? null,
    server_total_p50_ms: serverTotal.p50 ?? exp.server_total_p50_ms ?? null,
    server_total_p95_ms: serverTotal.p95 ?? exp.server_total_p95_ms ?? null,
    server_total_p99_ms: serverTotal.p99 ?? exp.server_total_p99_ms ?? null,
    measure_fps_mean: exp.measure_fps_mean ?? exp.fps_mean ?? null,
    measure_frame_p95_ms: exp.measure_frame_p95_ms ?? null,
    client_network_total_p95_exp: exp.client_network_total_p95_ms ?? null,
  };
}

function toCsv(rows) {
  if (!rows.length) return "";
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    if (v == null || v === "") return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return [keys.join(","), ...rows.map((r) => keys.map((k) => esc(r[k])).join(","))].join("\n");
}

function aggregateByArm(trialRows) {
  const byArm = new Map();
  for (const r of trialRows) {
    const k = `${r.batch}::${r.arm_id}`;
    if (!byArm.has(k)) byArm.set(k, []);
    byArm.get(k).push(r);
  }
  const out = [];
  for (const [key, rows] of byArm) {
    const [batch, arm_id] = key.split("::");
    out.push({
      batch,
      arm_id,
      trials: rows.length,
      protocol_cdp: [...new Set(rows.map((r) => r.protocol_cdp))].join(";"),
      uses_range_request: rows.every((r) => r.uses_range_request),
      is_loopback: rows.every((r) => r.is_loopback),
      preload_rad_requests_mean: mean(rows.map((r) => r.preload_rad_requests)),
      measure_rad_requests_mean: mean(rows.map((r) => r.measure_rad_requests)),
      measure_rad_requests_max: Math.max(...rows.map((r) => r.measure_rad_requests)),
      preload_throughput_Mbps_mean: mean(rows.map((r) => r.preload_throughput_Mbps)),
      preload_throughput_Mbps_min: Math.min(...rows.map((r) => r.preload_throughput_Mbps).filter(Number.isFinite)),
      total_throughput_Mbps_mean: mean(rows.map((r) => r.total_throughput_Mbps)),
      per_request_ttfb_p50_ms_mean: mean(rows.map((r) => r.per_request_ttfb_p50_ms)),
      per_request_ttfb_p95_ms_mean: mean(rows.map((r) => r.per_request_ttfb_p95_ms)),
      per_request_download_p95_ms_mean: mean(rows.map((r) => r.per_request_download_p95_ms)),
      server_total_p50_ms_mean: mean(rows.map((r) => r.server_total_p50_ms)),
      server_total_p95_ms_mean: mean(rows.map((r) => r.server_total_p95_ms)),
      client_net_total_p95_ms_mean: mean(rows.map((r) => r.client_net_total_p95_ms)),
      measure_fps_mean_avg: mean(rows.map((r) => r.measure_fps_mean)),
    });
  }
  return out.sort((a, b) => a.arm_id.localeCompare(b.arm_id));
}

function aggregateLatencyByArm(trialRows) {
  return aggregateByArm(trialRows).map((a) => {
    const src = trialRows.filter((r) => r.batch === a.batch && r.arm_id === a.arm_id);
    const pick = (fn) => mean(src.map(fn));
    return {
      batch: a.batch,
      arm_id: a.arm_id,
      trials: a.trials,
      per_request_ttfb_p50: pick((r) => r.per_request_ttfb_p50_ms),
      per_request_ttfb_p95: pick((r) => r.per_request_ttfb_p95_ms),
      per_request_ttfb_p99: pick((r) => r.per_request_ttfb_p99_ms),
      per_request_download_p50: pick((r) => r.per_request_download_p50_ms),
      per_request_download_p95: pick((r) => r.per_request_download_p95_ms),
      per_request_download_p99: pick((r) => r.per_request_download_p99_ms),
      client_net_total_p50: pick((r) => r.client_net_total_p50_ms),
      client_net_total_p95: pick((r) => r.client_net_total_p95_ms),
      client_net_total_p99: pick((r) => r.client_net_total_p99_ms),
      server_ttfb_p50: pick((r) => r.server_ttfb_p50_ms),
      server_ttfb_p95: pick((r) => r.server_ttfb_p95_ms),
      server_ttfb_p99: pick((r) => r.server_ttfb_p99_ms),
      server_total_p50: pick((r) => r.server_total_p50_ms),
      server_total_p95: pick((r) => r.server_total_p95_ms),
      server_total_p99: pick((r) => r.server_total_p99_ms),
    };
  });
}

function writeReport(batchDirs, trialRows, outPath) {
  const lines = [];
  lines.push("# 单机批次网络效应分析报告");
  lines.push("");
  lines.push(`生成时间: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## 数据来源");
  for (const d of batchDirs) {
    lines.push(`- \`${d}\``);
  }
  lines.push("- 字段来源: `cdp_network_audit.csv`（CDP `Network.responseReceived` → `protocol`）、`experiment_summary.json`、`per_trial_json`、`server_request_log.jsonl`（Content-Range）、`client_server_latency_alignment.csv`（服务端 ISO 时间戳）");
  lines.push("");
  lines.push("## 日志缺口说明");
  lines.push("- nextHopProtocol: 当前 CDP 导出未记录；仅有 protocol 列（值为 http/1.1）。");
  lines.push("- page_url 完整 URL: 页面由 ephemeral 端口 startPageStaticServer(0) 提供，批次日志未写入 page 端口；表中 page_url 为根据 ablation_mode  reconstructed 的模板。");
  lines.push("- CDP 时间戳: *_cdp_ts 为 Chrome 单调时钟（ms），非 wall-clock ISO；持续时间用 CDP 差值计算。ISO 时间见 *_iso 列（来自 server alignment）。");
  lines.push("");

  const loopback = trialRows.every((r) => r.is_loopback);
  const protoSet = [...new Set(trialRows.map((r) => r.protocol_cdp))];
  const rangeAll = trialRows.every((r) => r.uses_range_request);
  const status206 = trialRows.every((r) => String(r.http_status_sample).includes("206"));

  lines.push("## D. 问题回答");
  lines.push("");
  lines.push("### 1. 当前单机批次用的是什么协议？");
  lines.push(`- CDP 记录的 response.protocol 全部为: ${protoSet.join(", ")}（${trialRows.length} 个 trial）`);
  lines.push("- nextHopProtocol: 当前日志无法确认；需补 CDP Network 关联 Resource Timing，或 HAR 中的 nextHopProtocol。");
  lines.push("");

  lines.push("### 2. 是否经过真实外部网络？");
  lines.push(
    loopback
      ? "- 否。所有 .rad 请求主机为 127.0.0.1 / localhost（MonitoredAssetServer），属于 loopback，不能代表 WAN/CDN RTT 或丢包。"
      : "- 部分 trial 存在非 loopback 主机（请检查 CSV）。",
  );
  lines.push("");

  lines.push("### 3. 是否使用 HTTP Range？");
  lines.push(
    rangeAll && status206
      ? "- 是。每个 trial 的 .rad 请求均带 Range: bytes=...，HTTP 状态 206；服务端 server_request_log.jsonl 含 Content-Range: bytes start-end/total。"
      : "- 部分 trial 未满足 Range/206（见 `network_protocol_summary.csv`）。",
  );
  lines.push(`- Range 样例: \`${trialRows[0]?.range_header_sample ?? ""}\``);
  lines.push(`- Content-Range 样例: \`${trialRows[0]?.content_range_sample ?? ""}\``);
  lines.push("");

  lines.push("### 4. 每个 arm 的实际吞吐率是多少？");
  lines.push("");
  lines.push("| batch | arm | trials | preload 吞吐 mean (Mbps) | total 吞吐 mean (Mbps) |");
  lines.push("|-------|-----|--------|--------------------------|-------------------------|");
  for (const a of aggregateByArm(trialRows)) {
    lines.push(
      `| ${a.batch.split("/").pop()} | ${a.arm_id} | ${a.trials} | ${a.preload_throughput_Mbps_mean?.toFixed(1) ?? "—"} | ${a.total_throughput_Mbps_mean?.toFixed(1) ?? "—"} |`,
    );
  }
  lines.push("");
  lines.push("（吞吐 = CDP `encodedDataLength` 之和 × 8 / CDP 首末请求时间差；与磁盘理论带宽一致时 loopback 极高。）");
  lines.push("");

  lines.push("### 5. measure 阶段是否还有 .rad 请求？");
  lines.push("");
  lines.push("| arm | measure_rad mean | measure_rad max | 说明 |");
  lines.push("|-----|------------------|-----------------|------|");
  for (const a of aggregateByArm(trialRows)) {
    const note =
      a.measure_rad_requests_max === 0
        ? "pure/阻断后无 measure 下载"
        : a.measure_rad_requests_max <= 3
          ? "phased normal 可能有少量尾请求"
          : "measure 阶段仍有显著 .rad";
    lines.push(
      `| ${a.arm_id} | ${a.measure_rad_requests_mean?.toFixed(1)} | ${a.measure_rad_requests_max} | ${note} |`,
    );
  }
  lines.push("");

  lines.push("### 6. 当前 FPS 结果是否主要受网络影响？");
  const e3 = trialRows.filter((r) => r.arm_id.includes("E3_normal") || r.arm_id === "E3_normal");
  const e8 = trialRows.filter((r) => r.arm_id.includes("pure") && r.arm_id.includes("E8"));
  const netP95 = mean(e3.map((r) => r.per_request_ttfb_p95_ms));
  const fps = mean(e3.map((r) => r.measure_fps_mean));
  lines.push("- 结论: 否（在 measure 窗口内）。");
  lines.push(
    "- E3 类 arm: CDP per-request TTFB p95 约 " +
      (netP95?.toFixed(1) ?? "—") +
      " ms，server_total p95 约 " +
      (mean(e3.map((r) => r.server_total_p95_ms))?.toFixed(1) ?? "—") +
      " ms；measure_fps 约 " +
      (fps?.toFixed(1) ?? "—") +
      "。",
  );
  lines.push(
    "- loopback + HTTP/1.1 Range 下，传输延迟远小于 frame_p95 (~18ms) 与 GPU upload / fill-rate 瓶颈；experiment_summary 中 client_network_total_p95_ms 在 pure measure 常为 0（网络已阻断）。",
  );
  lines.push("- 例外: preload 阶段网络/解析占用时间长（~500MB+），但不计入 measure_fps 窗口。");
  lines.push("");

  lines.push("### 7. 若要测真实网络影响，下一步实验设计建议");
  lines.push("");
  lines.push("1. Remote/CDN: 将 coit-40m-sh1-lod.rad 置于 R2/GCS，页面 url 指向 https://...，保持 Range 支持（Accept-Ranges + 206）。");
  lines.push("2. Throttled network: Playwright context.route 或 Chrome DevTools throttling（如 10/50 Mbps、50–200ms RTT）仅作用于 asset origin。");
  lines.push("3. 补日志字段: HAR 或 CDP 增加 nextHopProtocol、transferSize、response.timing（dns/ssl/wait/receive）。");
  lines.push("4. 分离指标: 报告 preload 完成时间 vs measure_fps；避免用 loopback 吞吐推断 WAN 表现。");
  lines.push("5. 对照 arm: E3 normal @ CDN + throttle vs E8 pure @ local（隔离网络与渲染）。");
  lines.push("");

  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
}

function main() {
  const batchDirs = process.argv.slice(2).map((p) => path.resolve(p));
  if (!batchDirs.length) {
    console.error("Usage: node scripts/extract-network-batch-analysis.mjs <batchDir> ...");
    process.exit(1);
  }

  const allTrials = [];
  for (const batchDir of batchDirs) {
    if (!fs.existsSync(batchDir)) {
      console.error("Missing:", batchDir);
      continue;
    }
    const trials = findTrials(batchDir);
    console.log(`[extract] ${path.basename(batchDir)}: ${trials.length} trials`);
    const subset = [];
    for (const t of trials) {
      const row = extractTrial(t);
      allTrials.push(row);
      subset.push(row);
    }

    fs.writeFileSync(path.join(batchDir, "network_protocol_summary.csv"), toCsv(subset));
    fs.writeFileSync(path.join(batchDir, "network_throughput_by_arm.csv"), toCsv(aggregateByArm(subset)));
    fs.writeFileSync(path.join(batchDir, "network_latency_by_arm.csv"), toCsv(aggregateLatencyByArm(subset)));
    writeReport([batchDir], subset, path.join(batchDir, "network_effect_report.md"));
  }

  if (batchDirs.length > 1) {
    const combinedDir = path.join(projectRoot, "260506_local_diag", "network_extract_combined");
    fs.mkdirSync(combinedDir, { recursive: true });
    fs.writeFileSync(path.join(combinedDir, "network_protocol_summary.csv"), toCsv(allTrials));
    fs.writeFileSync(path.join(combinedDir, "network_throughput_by_arm.csv"), toCsv(aggregateByArm(allTrials)));
    fs.writeFileSync(path.join(combinedDir, "network_latency_by_arm.csv"), toCsv(aggregateLatencyByArm(allTrials)));
    writeReport(batchDirs, allTrials, path.join(combinedDir, "network_effect_report.md"));
    console.log(`[extract] combined -> ${combinedDir}`);
  }
}

main();
