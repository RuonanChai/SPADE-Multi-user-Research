/**
 * 端到端分层时延 + 瓶颈启发式：合并 proxy.jsonl（上游 TTFB/body/service）与 distributed-summary（CDP client_* / upstream_*）。
 * 不改变 workload：仅读取既有实验目录；轨迹由 replay 的 --traceBase 决定（套件默认 scripts/traces/generated）。
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const o = { manifest: "", runRoot: "", runId: "", out: "", outMd: "" };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "manifest") o.manifest = v;
    else if (k === "runRoot") o.runRoot = v;
    else if (k === "runId") o.runId = v;
    else if (k === "out") o.out = v;
    else if (k === "outMd") o.outMd = v;
  }
  return o;
}

function isDebugUrl(u) {
  return typeof u === "string" && /debug-scene-probe/i.test(u);
}

function pct(values, p) {
  const sorted = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function median(values) {
  const s = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2 || n !== ys.length) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const ax = xs[i] - mx;
    const ay = ys[i] - my;
    num += ax * ay;
    dx += ax * ax;
    dy += ay * ay;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

function rankAvg(vals) {
  const n = vals.length;
  const idx = [...Array(n).keys()].sort((a, b) => vals[a] - vals[b]);
  const ranks = new Array(n);
  let t = 0;
  while (t < n) {
    let t2 = t;
    const v = vals[idx[t]];
    while (t2 < n && vals[idx[t2]] === v) t2 += 1;
    const r = (t + t2 + 1) / 2;
    for (let j = t; j < t2; j++) ranks[idx[j]] = r;
    t = t2;
  }
  return ranks;
}

function spearman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return null;
  return pearson(rankAvg(xs), rankAvg(ys));
}

/** 与 analyze_upstream_root_cause.parse_metrics 对齐 */
function proxyRowMetrics(row) {
  if (row?.event !== "request_complete") return null;
  const u = String(row.url || "");
  if (isDebugUrl(u)) return null;
  const rid = String(row.run_id || "");
  if (!rid || rid === "unknown") return null;

  let t0 = row.t_request_start_ms ?? row.upstream_start_ts;
  let t1 = row.t_first_byte_ms ?? row.upstream_first_byte_ts;
  let t2 = row.t_last_byte_ms ?? row.upstream_end_ts;
  const ph = row.phase_timestamps || {};
  if (t0 == null) t0 = ph.upstream_fetch_started;
  if (t1 == null) t1 = ph.upstream_first_byte;
  if (t2 == null) t2 = ph.upstream_finished;
  if (t0 == null || t1 == null || t2 == null) return null;

  t0 = Number(t0);
  t1 = Number(t1);
  t2 = Number(t2);
  let ttfb = row.ttfb_ms;
  let btr = row.body_transfer_ms;
  let svc = row.service_ms;
  if (ttfb == null) ttfb = Math.max(0, t1 - t0);
  if (btr == null) btr = Math.max(0, t2 - t1);
  if (svc == null) svc = Math.max(0, t2 - t0);

  const ub = Number(row.upstream_bytes || 0);
  return {
    ttfb_ms: Number(ttfb),
    body_transfer_ms: Number(btr),
    service_ms: Number(svc),
    upstream_bytes: ub,
  };
}

async function readJson(p) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

async function readProxyJsonl(proxyPath) {
  const raw = await fs.readFile(proxyPath, "utf8").catch(() => "");
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

/** CDP Response.timing（相对 requestTime，单位 ms；-1 表示不适用） */
function deriveFromResourceTiming(t) {
  if (!t || typeof t.requestTime !== "number") return null;
  const d = (a, b) =>
    typeof a === "number" &&
    typeof b === "number" &&
    a >= 0 &&
    b >= 0 &&
    b >= a
      ? b - a
      : null;
  const proxy_ms = d(t.proxyStart, t.proxyEnd);
  const dns_ms = d(t.dnsStart, t.dnsEnd);
  let tcp_ms = null;
  let tls_ms = null;
  if (typeof t.sslStart === "number" && t.sslStart >= 0) {
    tcp_ms = d(t.connectStart, t.sslStart);
    const tlsEnd =
      typeof t.sslEnd === "number" && t.sslEnd >= t.sslStart
        ? t.sslEnd
        : typeof t.connectEnd === "number" && t.connectEnd >= t.sslStart
          ? t.connectEnd
          : null;
    tls_ms = tlsEnd != null ? d(t.sslStart, tlsEnd) : null;
  } else {
    tcp_ms = d(t.connectStart, t.connectEnd);
  }
  const send_to_headers_ms = d(t.sendStart, t.receiveHeadersEnd);
  return { proxy_ms, dns_ms, tcp_ms, tls_ms, send_to_headers_ms };
}

async function walkClientJsonlFiles(runAbs) {
  const out = [];
  async function walk(dir) {
    const ent = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of ent) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.startsWith("client-") && e.name.endsWith(".jsonl")) out.push(p);
    }
  }
  await walk(runAbs);
  return out;
}

async function aggregateResourceTimingFromRun(runAbs, runIdFilter) {
  const files = await walkClientJsonlFiles(runAbs);
  const derived = [];
  for (const fp of files) {
    const raw = await fs.readFile(fp, "utf8").catch(() => "");
    for (const line of raw.split("\n")) {
      const ln = line.trim();
      if (!ln) continue;
      let row;
      try {
        row = JSON.parse(ln);
      } catch {
        continue;
      }
      if (runIdFilter && String(row.run_id || "") !== String(runIdFilter)) continue;
      if (row.source && row.source !== "cdp_network") continue;
      if (row.debug_only || isDebugUrl(String(row.url || ""))) continue;
      if (!row.resource_timing) continue;
      const seg = deriveFromResourceTiming(row.resource_timing);
      if (seg) derived.push(seg);
    }
  }
  const pick = (k) => {
    const vals = derived.map((s) => s[k]).filter((x) => Number.isFinite(x));
    return {
      n: vals.length,
      p50: pct(vals, 50),
      p95: pct(vals, 95),
      p99: pct(vals, 99),
      median: median(vals),
    };
  };
  return {
    n_samples: derived.length,
    proxy_ms: pick("proxy_ms"),
    dns_ms: pick("dns_ms"),
    tcp_ms: pick("tcp_ms"),
    tls_ms: pick("tls_ms"),
    send_start_to_headers_ms: pick("send_to_headers_ms"),
    note:
      "来自各 fetch 对应资源的 CDP ResourceTiming；与 Navigation Timing 文档入口互补。localhost/连接复用时 DNS/TCP 可能为 0。",
  };
}

async function aggregateBrowserSummaries(runAbs) {
  const summaryFiles = [];
  async function walk(dir) {
    const ent = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of ent) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && /^client-.+-summary\.json$/i.test(e.name)) summaryFiles.push(p);
    }
  }
  await walk(runAbs);
  const navs = [];
  const diags = [];
  for (const fp of summaryFiles) {
    const data = await readJson(fp);
    const arr = Array.isArray(data) ? data : data ? [data] : [];
    for (const row of arr) {
      if (row.navigation_timing_page && typeof row.navigation_timing_page === "object") navs.push(row.navigation_timing_page);
      if (row.browser_frame_diag && typeof row.browser_frame_diag === "object") diags.push(row.browser_frame_diag);
    }
  }

  const numMed = (arr, key) => {
    const vals = arr.map((x) => x[key]).filter((x) => Number.isFinite(x));
    return { median: median(vals), p95: pct(vals, 95), n: vals.length };
  };

  const navigation_timing_document = navs.length
    ? {
        dns_ms: numMed(navs, "dns_ms"),
        tcp_ms: numMed(navs, "tcp_ms"),
        tls_ms: numMed(navs, "tls_ms"),
        ttfb_document_ms: numMed(navs, "ttfb_document_ms"),
        download_doc_ms: numMed(navs, "download_doc_ms"),
        dom_processing_ms: numMed(navs, "dom_processing_ms"),
        dom_content_loaded_ms: numMed(navs, "dom_content_loaded_ms"),
        page_duration_ms: numMed(navs, "page_duration_ms"),
        n_users: navs.length,
      }
    : null;

  const browser_main_render = diags.length
    ? {
        longtask_p95_ms: numMed(diags, "longtask_p95_ms"),
        longtask_count: numMed(diags, "longtask_count"),
        raf_frame_interval_p95_ms: numMed(diags, "raf_frame_interval_p95_ms"),
        raf_dropped_count_gt_20ms: numMed(diags, "raf_dropped_count_gt_20ms"),
        long_frame_count_gt_50ms: numMed(diags, "long_frame_count_gt_50ms"),
        n_users: diags.length,
        note: "LongTask / rAF 间隔为主线程与帧节律启发式，不等价 GPU 耗时；WebGPU 无单独时钟此处可见。",
      }
    : null;

  return { navigation_timing_document, browser_main_render };
}

function hintsFromScenario(block) {
  const hints = [];
  const { upstream, client_summary, correlations, browser_timing_aggregate, navigation_timing_document, browser_main_render } =
    block;

  if (!upstream?.n_requests) {
    hints.push("proxy 无有效 request_complete 行，无法分解上游 TTFB/body（proxy 路径）。");
  }

  if (upstream?.n_requests) {
    const spBB = correlations?.spearman_bytes_body_transfer;
    const spBT = correlations?.spearman_bytes_ttfb;

    if (spBB != null && spBB > 0.65 && (spBT == null || spBT < 0.5)) {
      hints.push(
        "上游(proxy→origin)：字节量与 body_transfer_ms 秩相关较强，体积/带宽（正文传输）拉伸显著（启发式）。",
      );
    }
    if (spBT != null && spBT > 0.45 && (spBB == null || spBB < 0.55)) {
      hints.push("上游(proxy→origin)：字节与 TTFB 同向波动不可忽视（连接/排队/首字节候选）。");
    }

    const mTtfb = upstream.median_ttfb_ms;
    const mBody = upstream.median_body_transfer_ms;
    const mSvc = upstream.median_service_ms;
    if (mSvc > 0 && mTtfb != null && mBody != null) {
      const shareT = mTtfb / mSvc;
      const shareB = mBody / mSvc;
      if (shareT >= 0.38) {
        hints.push(
          `上游 service 内：TTFB 中位约占 ${(shareT * 100).toFixed(1)}%（首字节前路径）。`,
        );
      }
      if (shareB >= 0.45) {
        hints.push(`上游 service 内：body 传输中位约占 ${(shareB * 100).toFixed(1)}%。`);
      }
    }

    const cp99 = client_summary?.client_p99;
    const up99 = client_summary?.upstream_p99;
    const cs99 = upstream.p99_service_ms;
    if (cp99 != null && up99 != null && up99 > 0 && cp99 / up99 > 1.2) {
      hints.push(
        "端到端尾部：CDP client_p99 明显高于摘要 upstream_p99（浏览器调度/JS/并行相对上游段时间放大候选）。",
      );
    }
    if (cp99 != null && cs99 != null && cs99 > 0 && cp99 / cs99 > 1.15) {
      hints.push("端到端尾部：client_p99 高于 proxy service_ms（p99）；对照 burst-queue。");
    }
  }

  if (browser_timing_aggregate?.n_samples > 0) {
    const dns = browser_timing_aggregate.dns_ms?.median;
    const tls = browser_timing_aggregate.tls_ms?.median;
    const tcp = browser_timing_aggregate.tcp_ms?.median;
    if (dns != null && dns > 12) {
      hints.push("浏览器连接（逐资源）：DNS 中位耗时偏高（解析或缓存未命中候选）。");
    }
    if (tcp != null && tcp > 25) {
      hints.push("浏览器连接（逐资源）：TCP 建连段偏高（复用连接可改善）。");
    }
    if (tls != null && tls > 30) {
      hints.push("浏览器连接（逐资源）：TLS 握手段偏高。");
    }
  } else {
    hints.push("无 CDP resource_timing 样本：请用新版 replay-worker 重跑以采集 DNS/TCP/TLS 分段。");
  }

  if (navigation_timing_document?.dns_ms?.median != null && navigation_timing_document.dns_ms.median > 15) {
    hints.push("文档导航：DNS（Navigation Timing）偏高。");
  }
  if (navigation_timing_document?.ttfb_document_ms?.median != null && navigation_timing_document.ttfb_document_ms.median > 200) {
    hints.push("文档导航：requestStart→responseStart（文档级 TTFB）偏高（含代理/源站首包）。");
  }

  if (browser_main_render?.longtask_p95_ms?.median != null && browser_main_render.longtask_p95_ms.median > 100) {
    hints.push("主线程：LongTask p95 偏高（JS 执行阻塞候选；非 GPU 独占度量）。");
  }
  if (
    browser_main_render?.raf_frame_interval_p95_ms?.median != null &&
    browser_main_render.raf_frame_interval_p95_ms.median > 28
  ) {
    hints.push("帧节律：rAF 间隔 p95 偏大（渲染管线阻塞或 GPU 帧间隔拉长启发式）。");
  }

  if (!browser_timing_aggregate?.n_samples) {
    hints.push(
      "提示：逐资源 DNS/TCP/TLS 需要 replay-worker 在 response 中写入 resource_timing；仅含旧 client 日志时此列为空。",
    );
  }

  if (hints.length === 0) {
    hints.push(
      "未触发阈值：对照 JSON 全表；端到端概念上含调度/JS、DNS/TCP/TLS、可选 proxy、TTFB+body、主线程/LongTask/帧间隔启发。",
    );
  }
  return hints;
}

async function analyzeOneScenario(runAbs, runIdFilter, key, scenarioLabel) {
  const proxyPath = path.join(runAbs, "proxy", "proxy.jsonl");
  const sumPath = path.join(runAbs, "summary", "distributed-summary.json");

  const proxyRows = existsSync(proxyPath) ? await readProxyJsonl(proxyPath) : [];
  const metrics = [];
  for (const row of proxyRows) {
    if (runIdFilter && String(row.run_id || "") !== String(runIdFilter)) continue;
    const m = proxyRowMetrics(row);
    if (m) metrics.push(m);
  }

  const tt = metrics.map((x) => x.ttfb_ms);
  const bt = metrics.map((x) => x.body_transfer_ms);
  const sv = metrics.map((x) => x.service_ms);
  const ub = metrics.map((x) => x.upstream_bytes);

  const upstream = {
    n_requests: metrics.length,
    p50_ttfb_ms: pct(tt, 50),
    p95_ttfb_ms: pct(tt, 95),
    p99_ttfb_ms: pct(tt, 99),
    p50_body_transfer_ms: pct(bt, 50),
    p95_body_transfer_ms: pct(bt, 95),
    p99_body_transfer_ms: pct(bt, 99),
    p50_service_ms: pct(sv, 50),
    p95_service_ms: pct(sv, 95),
    p99_service_ms: pct(sv, 99),
    median_ttfb_ms: median(tt),
    median_body_transfer_ms: median(bt),
    median_service_ms: median(sv),
  };

  let spearmanBB = null;
  let spearmanBT = null;
  if (metrics.length >= 3) {
    spearmanBB = spearman(ub, bt);
    spearmanBT = spearman(ub, tt);
  }

  const sum = await readJson(sumPath);
  const runs = sum?.runs || [];
  const row =
    runIdFilter && runs.length
      ? runs.find((r) => String(r.run_id) === String(runIdFilter)) || runs[0]
      : runs[0];
  const lat = row?.latency || {};

  const client_summary = {
    client_p95: lat.client_p95 ?? null,
    client_p99: lat.client_p99 ?? null,
    upstream_p95: lat.upstream_p95 ?? null,
    upstream_p99: lat.upstream_p99 ?? null,
  };

  const correlations = {
    spearman_bytes_body_transfer: spearmanBB,
    spearman_bytes_ttfb: spearmanBT,
    n_pairs: metrics.length,
  };

  const msvc = upstream.median_service_ms || 0;
  const ratios =
    msvc > 0
      ? {
          median_ttfb_share_of_service: upstream.median_ttfb_ms != null ? upstream.median_ttfb_ms / msvc : null,
          median_body_share_of_service:
            upstream.median_body_transfer_ms != null ? upstream.median_body_transfer_ms / msvc : null,
        }
      : {};

  const browser_timing_aggregate = await aggregateResourceTimingFromRun(runAbs, runIdFilter || null);
  const { navigation_timing_document, browser_main_render } = await aggregateBrowserSummaries(runAbs);

  const block = {
    key,
    scenario: scenarioLabel,
    run_root: path.relative(projectRoot, runAbs),
    run_id: runIdFilter,
    upstream,
    client_summary,
    correlations,
    ratios,
    browser_timing_aggregate,
    navigation_timing_document,
    browser_main_render,
  };

  block.bottleneck_hints_cn = hintsFromScenario(block);
  return block;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let scenarios = [];
  let suiteMeta = null;

  if (args.runRoot) {
    const runAbs = path.resolve(projectRoot, args.runRoot);
    let rid = args.runId;
    if (!rid) {
      const meta = await readJson(path.join(runAbs, "metadata.json"));
      rid = meta?.run_id ?? "";
    }
    scenarios = [{ run_root: path.relative(projectRoot, runAbs), run_id: rid, key: "single", scenario: args.runRoot }];
  } else if (args.manifest) {
    const mp = path.isAbsolute(args.manifest) ? args.manifest : path.join(projectRoot, args.manifest);
    const man = await readJson(mp);
    suiteMeta = man;
    scenarios = (man?.scenarios || []).map((s) => ({
      run_root: s.run_root,
      run_id: s.run_id ?? "",
      key: s.key,
      scenario: s.scenario,
      error: s.error,
    }));
  } else {
    console.error("需要 --manifest= 或 --runRoot=");
    process.exitCode = 1;
    return;
  }

  const blocks = [];
  for (const sc of scenarios) {
    if (!sc.run_root || sc.error) continue;
    const runAbs = path.resolve(projectRoot, sc.run_root);
    if (!existsSync(runAbs)) {
      blocks.push({
        key: sc.key,
        scenario: sc.scenario,
        run_root: sc.run_root,
        error: "run_root_missing",
        bottleneck_hints_cn: ["目录不存在，跳过。"],
      });
      continue;
    }
    const b = await analyzeOneScenario(runAbs, sc.run_id || null, sc.key, sc.scenario);
    blocks.push(b);
  }

  const out = {
    generated_at: new Date().toISOString(),
    suite_profile: suiteMeta?.suite_profile ?? null,
    trace_base_from_suite: suiteMeta?.trace_base ?? null,
    trace_note:
      "Workload / 3DGS 轨迹由 replay --traceBase 固定（套件默认 scripts/traces/generated）；本分析不改轨迹，仅拆解已有日志中的时延分量。",
    layers_documentation: {
      e2e_conceptual_stack:
        "端到端（概念全栈）≈ 浏览器调度与 JS + DNS/TCP/TLS +（可选 reverse proxy）+ 上游 TTFB + body + 主线程(LongTask)/帧间隔(rAF) 启发；GPU 无单独硬件时钟，帧间隔与 LongTask 为间接线索。",
      client_e2e_ms:
        "CDP Network duration_ms 聚合（单资源）；浏览器发起→loadingFinished。",
      cdp_resource_timing_segments:
        "Chromium CDP Response.timing：proxyStart/proxyEnd、dns、connect/tcp、ssl/tls、send→receiveHeaders（近文档 TTFB）；相对同一请求 requestTime。",
      navigation_timing_document:
        "Performance Navigation Timing L2：文档入口 dns/tcp/tls、文档级 TTFB、正文下载与 DOM 处理（每用户一条）。",
      upstream_service_ms: "Proxy upstream_fetch_started → upstream_finished（proxy→Spark/upstream）。",
      upstream_ttfb_ms: "Proxy 视角上游首字节前路径（service 内第一段）。",
      upstream_body_transfer_ms: "Proxy 视角正文传输（service 内第二段）。",
      browser_main_render:
        "PerformanceObserver longtask + rAF 帧间隔统计（SPARK_BROWSER_FRAME_DIAG）；非 GPU profiler。",
      gap_heuristic:
        "client_* 分位数与 upstream_* / proxy service 对照估计尾部放大；逐请求未 URL 对齐。",
    },
    scenarios: blocks,
  };

  const outPath = args.out
    ? path.isAbsolute(args.out)
      ? args.out
      : path.join(projectRoot, args.out)
    : path.join(projectRoot, "260428", "e2e_latency_breakdown.json");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), "utf8");
  console.log(`Wrote ${outPath}`);

  const mdResolvedFallback = outPath.replace(/\.json$/i, "") + "_bottleneck_analysis.md";
  const mdRaw = args.outMd || mdResolvedFallback;
  const mdResolved = path.isAbsolute(mdRaw) ? mdRaw : path.join(projectRoot, mdRaw);
  const mdLines = [
    `# 端到端分层时延与瓶颈启发式`,
    ``,
    `生成时间: ${out.generated_at}`,
    ``,
  ];
  if (out.suite_profile || out.trace_base_from_suite) {
    mdLines.push(
      `- suite_profile: ${out.suite_profile ?? "—"}`,
      `- trace_base（与套件 replay 一致，不改轨迹）: ${out.trace_base_from_suite ?? "—"}`,
      ``,
    );
  }
  mdLines.push(
    `> ${out.trace_note}`,
    ``,
    `## 分层定义`,
    ``,
    `- **概念全栈**：${out.layers_documentation.e2e_conceptual_stack}`,
    `- **客户端 E2E**：${out.layers_documentation.client_e2e_ms}`,
    `- **CDP ResourceTiming**：${out.layers_documentation.cdp_resource_timing_segments}`,
    `- **Navigation（文档）**：${out.layers_documentation.navigation_timing_document}`,
    `- **上游 proxy**：${out.layers_documentation.upstream_service_ms}`,
    `- **上游 TTFB / body**：${out.layers_documentation.upstream_ttfb_ms} / ${out.layers_documentation.upstream_body_transfer_ms}`,
    `- **主线程/帧**：${out.layers_documentation.browser_main_render}`,
    `- **尾部对照**：${out.layers_documentation.gap_heuristic}`,
    ``,
    `## 各场景`,
    ``,
  );
  for (const b of blocks) {
    mdLines.push(`### ${b.key}: ${b.scenario || "—"}`, ``);
    if (b.error) {
      mdLines.push(`- **错误**: ${b.error}`, ``);
      continue;
    }
    mdLines.push(
      `| 层级 | p50 | p95 | p99 |`,
      `|------|-----|-----|-----|`,
      `| 上游 TTFB (ms) | ${b.upstream?.p50_ttfb_ms ?? "—"} | ${b.upstream?.p95_ttfb_ms ?? "—"} | ${b.upstream?.p99_ttfb_ms ?? "—"} |`,
      `| 上游 body (ms) | ${b.upstream?.p50_body_transfer_ms ?? "—"} | ${b.upstream?.p95_body_transfer_ms ?? "—"} | ${b.upstream?.p99_body_transfer_ms ?? "—"} |`,
      `| 上游 service (ms) | ${b.upstream?.p50_service_ms ?? "—"} | ${b.upstream?.p95_service_ms ?? "—"} | ${b.upstream?.p99_service_ms ?? "—"} |`,
      `| CDP client（摘要） | — | ${b.client_summary?.client_p95 ?? "—"} | ${b.client_summary?.client_p99 ?? "—"} |`,
      `| upstream（摘要，段时间） | — | ${b.client_summary?.upstream_p95 ?? "—"} | ${b.client_summary?.upstream_p99 ?? "—"} |`,
      ``,
    );
    if (b.correlations && (b.correlations.n_pairs ?? 0) > 0) {
      mdLines.push(
        `- Spearman(bytes, body_transfer): ${b.correlations.spearman_bytes_body_transfer ?? "—"}`,
        `- Spearman(bytes, ttfb): ${b.correlations.spearman_bytes_ttfb ?? "—"}`,
        `- proxy 请求条数 n: ${b.correlations.n_pairs ?? "—"}`,
        ``,
      );
    }
    const bt = b.browser_timing_aggregate;
    if (bt?.n_samples > 0) {
      mdLines.push(
        `#### CDP ResourceTiming（逐资源） n=${bt.n_samples}`,
        ``,
        `| 段 | p50 | p95 |`,
        `|----|-----|-----|`,
        `| DNS | ${bt.dns_ms?.p50 ?? "—"} | ${bt.dns_ms?.p95 ?? "—"} |`,
        `| TCP（至 TLS 前） | ${bt.tcp_ms?.p50 ?? "—"} | ${bt.tcp_ms?.p95 ?? "—"} |`,
        `| TLS | ${bt.tls_ms?.p50 ?? "—"} | ${bt.tls_ms?.p95 ?? "—"} |`,
        `| proxy 解析 | ${bt.proxy_ms?.p50 ?? "—"} | ${bt.proxy_ms?.p95 ?? "—"} |`,
        `| send→headers | ${bt.send_start_to_headers_ms?.p50 ?? "—"} | ${bt.send_start_to_headers_ms?.p95 ?? "—"} |`,
        ``,
      );
    }
    const nav = b.navigation_timing_document;
    if (nav?.n_users) {
      mdLines.push(
        `#### Navigation Timing（文档入口，${nav.n_users} user）`,
        ``,
        `- dns median: ${nav.dns_ms?.median ?? "—"} ms`,
        `- tcp median: ${nav.tcp_ms?.median ?? "—"} ms`,
        `- tls median: ${nav.tls_ms?.median ?? "—"} ms`,
        `- 文档 TTFB median: ${nav.ttfb_document_ms?.median ?? "—"} ms`,
        `- dom_processing median: ${nav.dom_processing_ms?.median ?? "—"} ms`,
        ``,
      );
    }
    const br = b.browser_main_render;
    if (br?.n_users) {
      mdLines.push(
        `#### 主线程 / 帧（${br.n_users} user）`,
        ``,
        `- longtask_p95 median: ${br.longtask_p95_ms?.median ?? "—"} ms`,
        `- rAF 间隔 p95 median: ${br.raf_frame_interval_p95_ms?.median ?? "—"} ms`,
        `- long_frame(>50ms) count median: ${br.long_frame_count_gt_50ms?.median ?? "—"}`,
        ``,
      );
    }
    mdLines.push(`**瓶颈启发（自动阈值，非唯一结论）**`, ``);
    for (const h of b.bottleneck_hints_cn || []) {
      mdLines.push(`- ${h}`);
    }
    mdLines.push(``);
  }
  await fs.writeFile(mdResolved, mdLines.join("\n") + "\n", "utf8");
  console.log(`Wrote ${mdResolved}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
