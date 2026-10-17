/**
 * 生成实验可读总结：summary/viewport_sharing_report.md（及可选 JSON 镜像）。
 *
 *   node scripts/generate-viewport-sharing-report.mjs \
 *     --runRoot=<共享代理臂输出目录> \
 *     [--pairedBaselineRoot=<instrumented 对照臂>] \
 *     [--compareRunRoots=<dir1>,<dir2>,... 用于跨场景 sharing_gain 排序] \
 *     [--comparisonJson=<paired 目录下的 sharing_gain_comparison.json>]
 *
 * 说明：本报告**不**将边缘代理测得的字节/合并收益归因于 GPU 或渲染管线；CDP 时长仅反映网络+浏览器栈观测，非独占渲染结论。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

function parseArgs(argv) {
  const o = { runRoot: "", pairedBaselineRoot: "", compareRunRoots: "", comparisonJson: "" };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    const k = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const v = eq === -1 ? "" : arg.slice(eq + 1);
    if (k === "runRoot") o.runRoot = v;
    else if (k === "pairedBaselineRoot") o.pairedBaselineRoot = v;
    else if (k === "compareRunRoots") o.compareRunRoots = v;
    else if (k === "comparisonJson") o.comparisonJson = v;
  }
  return o;
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

async function readJson(p) {
  return JSON.parse(await fs.readFile(p, "utf8").catch(() => "{}"));
}

function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(3)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(3)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(3)} KB`;
  return `${Math.round(n)} B`;
}

function fmtRatio(x) {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(2)}%`;
}

function fmtMs(x) {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${Number(x.toFixed(3))} ms`;
}

function mergeWarnings(valPayload, gain, overlapTrace, sharedLines) {
  const out = [];
  const pushArr = (label, arr) => {
    if (!Array.isArray(arr)) return;
    for (const w of arr) out.push({ source: label, text: String(w) });
  };
  pushArr("viewport_sharing_validation", valPayload?.warnings);
  pushArr("viewport_sharing_validation_errors", valPayload?.errors);

  if (gain?.skipped) {
    out.push({
      source: "analyze",
      text: "viewport_sharing_gain.json 为跳过状态：无法基于共享代理日志度量对象级 sharing gain。",
    });
  }

  /** shared-proxy.jsonl 快速扫描：overlap / ephemeral hints */
  const overlapEv = [...sharedLines].reverse().find((e) => String(e?.event || "") === "viewport_lockstep_overlap");
  if (
    overlapEv &&
    overlapEv.pairwise_overlap_avg != null &&
    Number.isFinite(Number(overlapEv.pairwise_overlap_avg)) &&
    Number(overlapEv.pairwise_overlap_avg) < 0.5
  ) {
    out.push({
      source: "shared-proxy.jsonl",
      text: `viewport_lockstep_overlap.pairwise_overlap_avg=${Number(overlapEv.pairwise_overlap_avg).toFixed(3)} 较低，请结合轨迹重叠摘要解读。`,
    });
  }

  if (overlapTrace?.average_overlap_ratio != null && Number(overlapTrace.average_overlap_ratio) < 0.35) {
    out.push({
      source: "viewport_trace_overlap.json",
      text: `轨迹桶平均 Jaccard=${overlapTrace.average_overlap_ratio}（启发式），四用户视口相关采样重叠可能偏弱（不等价 GPU 可见集）。`,
    });
  }

  return out;
}

async function loadGain(runRoot) {
  const p = path.join(runRoot, "summary", "viewport_sharing_gain.json");
  if (!existsSync(p)) return null;
  return readJson(p);
}

async function rankCompareRuns(rootsAbs) {
  const rows = [];
  for (const r of rootsAbs) {
    const g = await loadGain(r);
    const m = await readJson(path.join(r, "metadata.json"));
    const ratio = g?.byte_metrics?.sharing_gain_ratio;
    rows.push({
      run_root: r,
      scenario: String(m?.scenario || g?.scenario || ""),
      sharing_gain_ratio: Number.isFinite(ratio) ? ratio : null,
      sharing_saved_bytes: g?.byte_metrics?.sharing_saved_bytes ?? null,
      skipped: Boolean(g?.skipped),
    });
  }
  rows.sort((a, b) => {
    const ar = a.sharing_gain_ratio ?? -1;
    const br = b.sharing_gain_ratio ?? -1;
    return br - ar;
  });
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.runRoot) {
    console.error("需要 --runRoot=");
    process.exitCode = 1;
    return;
  }

  const runRoot = path.resolve(args.runRoot);
  const summaryDir = path.join(runRoot, "summary");
  await fs.mkdir(summaryDir, { recursive: true });
  const mdPath = path.join(summaryDir, "viewport_sharing_report.md");
  const jsonPath = path.join(summaryDir, "viewport_sharing_report.json");

  const meta = await readJson(path.join(runRoot, "metadata.json"));
  const gain = await loadGain(runRoot);
  const valPath = path.join(summaryDir, "viewport_sharing_validation.json");
  const val = existsSync(valPath) ? await readJson(valPath) : {};

  const overlapPath = path.join(summaryDir, "viewport_trace_overlap.json");
  const overlapTrace = existsSync(overlapPath) ? await readJson(overlapPath) : null;

  const sharedProxyPath = path.join(runRoot, "proxy", "shared-proxy.jsonl");
  const sharedLines = existsSync(sharedProxyPath)
    ? parseJsonl(await fs.readFile(sharedProxyPath, "utf8").catch(() => ""))
    : [];

  let baselineGain = null;
  const baselineRoot = args.pairedBaselineRoot ? path.resolve(args.pairedBaselineRoot) : "";
  if (baselineRoot) {
    baselineGain = await loadGain(baselineRoot);
  }

  let comparison = null;
  if (args.comparisonJson) {
    const cp = path.resolve(args.comparisonJson);
    if (existsSync(cp)) comparison = await readJson(cp);
  }

  const rm = gain?.request_metrics || {};
  const bm = gain?.byte_metrics || {};
  const lm = gain?.latency_metrics || {};

  const shareable = rm.shareable_client_requests ?? null;
  const uniqueKeys = rm.unique_share_keys ?? null;
  const upstreamLeaders = rm.upstream_fetch_count ?? null;
  const inflight = rm.inflight_join_count ?? null;
  const memHits = rm.memory_cache_hit_count ?? null;

  const avoidedByJoin = Number.isFinite(inflight) ? inflight : null;
  const avoidedByCache = Number.isFinite(memHits) ? memHits : null;
  let avoidedTotal = null;
  if (Number.isFinite(inflight) && Number.isFinite(memHits)) avoidedTotal = inflight + memHits;
  else if (Number.isFinite(shareable) && Number.isFinite(upstreamLeaders))
    avoidedTotal = Math.max(0, shareable - upstreamLeaders);

  const savedBytes = bm.sharing_saved_bytes ?? null;
  const gainRatio = bm.sharing_gain_ratio ?? null;

  /** Q1 重叠：轨迹摘要 > 校验 pairwise > 日志事件 */
  let overlapAnswer = "";
  const poTrace = overlapTrace?.average_overlap_ratio;
  const poValRaw = val.pairwise_overlap_avg;
  const poVal =
    poValRaw != null && Number.isFinite(Number(poValRaw)) ? Number(poValRaw) : null;
  const overlapEv = [...sharedLines].reverse().find((e) => String(e?.event || "") === "viewport_lockstep_overlap");
  const poLog =
    overlapEv && Number.isFinite(Number(overlapEv.pairwise_overlap_avg)) ? Number(overlapEv.pairwise_overlap_avg) : null;

  if (poTrace != null && Number.isFinite(poTrace)) {
    overlapAnswer = `依据 **summary/viewport_trace_overlap.json**：四用户在轨迹采样下的桶平均 Jaccard 重叠约为 **${poTrace}**（量化相机桶启发式，**非** GPU 可见集真值）。`;
  } else if (poVal != null && Number.isFinite(poVal)) {
    overlapAnswer = `依据校验摘要 **pairwise_overlap_avg=${poVal}**（来自 shared-proxy 日志中的 overlap 事件或校验回填）。`;
  } else if (poLog != null) {
    overlapAnswer = `依据 **shared-proxy.jsonl** 中 \`viewport_lockstep_overlap\`：pairwise_overlap_avg≈**${poLog.toFixed(4)}**。`;
  } else {
    overlapAnswer =
      "未找到 **viewport_trace_overlap.json**、校验 pairwise 字段或 overlap 日志事件；**无法在本报告中定量断言**四用户视口轨迹重叠度，仅可从 share_key 重复度间接推断请求是否指向同一逻辑对象。";
  }

  const warnings = mergeWarnings(val, gain, overlapTrace, sharedLines);

  /** Q6 延迟 */
  let latencyAnswer = "";
  if (comparison?.deltas) {
    const d = comparison.deltas;
    latencyAnswer =
      `依据配对对比 JSON（**comparisonJson**）：共享臂相对基线 Δclient_p95=${fmtMs(d.client_p95_ms_delta)}，Δclient_p99=${fmtMs(d.client_p99_ms_delta)}；Δttfb_p95=${fmtMs(d.ttfb_p95_ms_delta)}。**解释**：CDP **duration_ms** 覆盖 DNS/TLS/队列/浏览器网络栈与部分解析；**不能**据此断言渲染或 GPU 变快。`;
  } else if (baselineGain && !baselineGain.skipped && gain && !gain.skipped) {
    const bcd = baselineGain.latency_metrics?.client_duration_ms_from_cdp || {};
    const scd = lm.client_duration_ms_from_cdp || {};
    const bt = baselineGain.latency_metrics?.ttfb_ms || {};
    const st = lm.ttfb_ms || {};
    latencyAnswer =
      `配对目录 **pairedBaselineRoot**：基线 client P95=${fmtMs(bcd.p95)} → 共享 ${fmtMs(scd.p95)}（Δ ${fmtMs((scd.p95 ?? 0) - (bcd.p95 ?? 0))}）；P99 ${fmtMs(bcd.p99)} → ${fmtMs(scd.p99)}。TTFB P95 ${fmtMs(bt.p95)} → ${fmtMs(st.p95)}。**仅为端到端与代理侧观测差分**，不等价渲染优化。`;
  } else {
    latencyAnswer =
      `未提供 **comparisonJson** 或 **pairedBaselineRoot**；本报告仅列出共享臂 CDP client P95=${fmtMs(lm.client_duration_ms_from_cdp?.p95)}、P99=${fmtMs(lm.client_duration_ms_from_cdp?.p99)}，以及代理 **ttfb_ms** P95=${fmtMs(lm.ttfb_ms?.p95)}。**无法在同一文档内对「sharing 是否降低延迟」做 A/B 结论**。`;
  }

  /** Q8 合并 vs 缓存 */
  const totalMechanism =
    Number.isFinite(inflight) && Number.isFinite(memHits) ? inflight + memHits : avoidedTotal ?? null;
  let mechanismAnswer = "";
  if (gain?.skipped || !Number.isFinite(inflight) || !Number.isFinite(memHits)) {
    mechanismAnswer =
      "缺少完整的 inflight_join / memory_cache 分项（常见于未跑共享代理或日志不完整）；无法拆分合并与短 TTL 内存缓存占比。";
  } else if ((inflight ?? 0) + (memHits ?? 0) <= 0 && Number.isFinite(avoidedTotal) && avoidedTotal > 0) {
    mechanismAnswer = `shareable−upstream_leader=${avoidedTotal}，但 inflight/memory_cache 分项均为 0：可能是日志事件命名与聚合脚本不一致，请在 **shared-proxy.jsonl** 中人工核对 served_from / 事件类型。`;
  } else if (!totalMechanism || totalMechanism <= 0) {
    mechanismAnswer = "可观测合并/缓存请求数为 0（或日志未区分），增益若存在则可能主要来自口径外的路径。";
  } else {
    const pj = inflight / totalMechanism;
    const pc = memHits / totalMechanism;
    mechanismAnswer = `在计入分项的请求集合上，约 **${fmtRatio(pj)}** 的「免于重复上游 leader fetch」来自 **in-flight coalescing**（${inflight} 次），**${fmtRatio(pc)}** 来自 **短 TTL 内存缓存命中**（${memHits} 次）。两者均属 **对象字节传输路径**，与 CDN 浏览器磁盘缓存及渲染线程无关。`;
  }

  /** Q7 */
  let scenarioRankMd = "";
  const extraRoots = args.compareRunRoots
    ? args.compareRunRoots
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => path.resolve(x))
    : [];
  extraRoots.push(runRoot);
  const uniqRoots = [...new Set(extraRoots)];
  const ranked = await rankCompareRuns(uniqRoots);
  const best = ranked.find((r) => !r.skipped && r.sharing_gain_ratio != null);
  scenarioRankMd =
    ranked
      .map(
        (r, i) =>
          `${i + 1}. **${r.scenario || path.basename(r.run_root)}** — sharing_gain_ratio=${r.sharing_gain_ratio == null ? "—" : fmtRatio(r.sharing_gain_ratio)}${r.skipped ? "（skipped）" : ""}`,
      )
      .join("\n") || "—";

  const md = `# Viewport 对象共享实验总结（代理观测）

**生成时间**：${new Date().toISOString()}  
**run_root**：\`${runRoot.replace(/\\/g, "/")}\`  
**场景（metadata）**：${meta.scenario ?? "—"}  
**metrics_source**：${gain?.metrics_source ?? "—"}  

---

## 导读（直接回答）

1. **四用户是否请求了重叠的视口相关对象？**  
   ${overlapAnswer}

2. **共产生多少条可共享（shareable）客户端请求？**  
   **${shareable ?? "—"}**（定义与 viewport-shared-edge-proxy / analyze-viewport-sharing-gain 一致：静态媒体扩展名等，不含 HTML/JS/CSS/trace JSON。）

3. **有多少个唯一 share_key？**  
   **${uniqueKeys ?? "—"}**

4. **sharing 避免了多少次上游 leader fetch？**  
   - in-flight 合并惠及：**${avoidedByJoin ?? "—"}** 次请求（inflight_join）  
   - 内存缓存命中：**${avoidedByCache ?? "—"}** 次请求（memory_cache）  
   - 合计免于单独 leader fetch：**${avoidedTotal ?? "—"}**（应近似 shareable − upstream_fetch_count）

5. **节省了多少字节？**  
   **${fmtBytes(savedBytes)}**（sharing_saved_bytes = no_sharing 估计 − upstream_bytes_actual on shareable）。占比：**${fmtRatio(gainRatio)}**。

6. **sharing 是否降低了 P95/P99 延迟？**  
   ${latencyAnswer}

7. **哪个场景 sharing gain 最高？**  
   ${best ? `在本次提供的对比列表中：**${best.scenario}**（ratio=${fmtRatio(best.sharing_gain_ratio)}）。` : "对比列表无有效 sharing_gain_ratio。"}  
   完整排序见下文「跨场景排序」。

8. **增益主要来自合并还是短 TTL 内存缓存？**  
   ${mechanismAnswer}

9. **轨迹重叠 / CDN 缓存 / Range / 用户 URL 等告警？**  
   见 **「告警汇总」**；校验详情见 \`summary/viewport_sharing_validation.json\`（若存在）。

---

## A. 对象共享增益（边缘代理 / 字节 / 合并）

本节仅为 **HTTP 对象字节与上游往返** 在共享边缘代理上的观测，**不包含** GPU、光栅化或 long-task 归因。

| 指标 | 值 |
| --- | ---: |
| total_client_requests | ${rm.total_client_requests ?? "—"} |
| shareable_client_requests | ${shareable ?? "—"} |
| unique_share_keys | ${uniqueKeys ?? "—"} |
| upstream_fetch_count（leader） | ${upstreamLeaders ?? "—"} |
| inflight_join_count | ${inflight ?? "—"} |
| memory_cache_hit_count | ${memHits ?? "—"} |
| downstream_bytes_total | ${fmtBytes(bm.downstream_bytes_total)} |
| upstream_bytes_actual（shareable 计费口径） | ${fmtBytes(bm.upstream_bytes_actual)} |
| no_sharing_estimated_upstream_bytes | ${fmtBytes(bm.no_sharing_estimated_upstream_bytes)} |
| sharing_saved_bytes | ${fmtBytes(savedBytes)} |
| sharing_gain_ratio | ${fmtRatio(gainRatio)} |

---

## B. CDN / 浏览器缓存效应（与本代理对象缓存区分）

- **CDN / 边缘**：若上游为 CDN（参见 metadata \`cdn_base_url\` / 校验告警「规则10」），响应可能带 **cf-cache-status** 等；这会使 **部分请求根本不触及你的合并窗口**，与「对象合并增益」需分开解读。  
- **浏览器 HTTP 缓存**：CDP **duration_ms** 缩短可能含磁盘/内存缓存命中；**不能**与 §A 的 proxy memory_cache 混为一谈。  
- **本实验未宣称**：因 sharing 而减少 GPU 工作量。

---

## C. 客户端观测（CDP）与渲染 / long-task

- **CDP duration_ms**：端到端网络与浏览器栈延迟的上界观测之一，**混杂**主线程调度、解析与非渲染任务。  
- **large-task / 渲染**：本仓库 proxy 实验 **未** 采集 Performance long-task 或帧时间；**请勿**将字节节省或 CDP 分位数变化归因于渲染管线优化。

共享臂 CDP client：**P50=${fmtMs(lm.client_duration_ms_from_cdp?.p50)} P95=${fmtMs(lm.client_duration_ms_from_cdp?.p95)} P99=${fmtMs(lm.client_duration_ms_from_cdp?.p99)}**  
代理 **ttfb_ms**：**P95=${fmtMs(lm.ttfb_ms?.p95)} P99=${fmtMs(lm.ttfb_ms?.p99)}**

---

## 跨场景排序（--compareRunRoots）

${scenarioRankMd}

---

## 告警汇总

${warnings.length ? warnings.map((w) => `- **${w.source}**：${w.text}`).join("\n") : "- （无额外聚合告警）"}

---

## 数据来源

| 文件 | 用途 |
| --- | --- |
| summary/viewport_sharing_gain.json | 请求/字节/延迟聚合 |
| summary/viewport_sharing_validation.json | 校验与 Range / URL / CDN 提示 |
| summary/viewport_trace_overlap.json | 轨迹桶重叠（若生成） |
| proxy/shared-proxy.jsonl | overlap 事件、分项计数复核 |
| metadata.json | 场景、CDN、实验模式 |

---

## 局限性与禁止表述

- **禁止**：声称本实验证明 GPU、着色器或「渲染帧率」提升。  
- **禁止**：将 CDP **duration_ms** 单独等同于「共享代理提速渲染」。  
- **允许**：在 §A 口径下讨论上游字节与 leader fetch 次数变化，并与配对基线对照讨论 **网络栈观测** 差异。

`;

  await fs.writeFile(mdPath, md, "utf8");

  const jsonPayload = {
    generated_at: new Date().toISOString(),
    run_root: runRoot,
    executive_answers: {
      overlapping_viewport_objects_summary: overlapAnswer,
      shareable_client_requests: shareable,
      unique_share_keys: uniqueKeys,
      upstream_fetches_avoided_inflight: avoidedByJoin,
      upstream_fetches_avoided_memory_cache: avoidedByCache,
      upstream_fetches_avoided_total_estimate: avoidedTotal,
      sharing_saved_bytes: savedBytes,
      sharing_gain_ratio: gainRatio,
      latency_narrative: latencyAnswer,
      highest_gain_scenario_in_compare_list: best?.scenario ?? null,
      mechanism_narrative: mechanismAnswer,
      warnings,
    },
    separation: {
      object_sharing_gain_proxy_scope: {
        byte_metrics: bm,
        request_metrics: rm,
        coalescing_metrics: gain?.coalescing_metrics ?? null,
      },
      cdn_browser_cache_note:
        "CDN/browser cache may shorten CDP duration independently of proxy object coalescing; see validation warnings.",
      client_side_cdp_note:
        "CDP duration reflects browser network stack observations, not GPU or exclusive rendering cost.",
    },
    compare_ranking: ranked,
    disclaimer_no_gpu_claims: true,
  };

  await fs.writeFile(jsonPath, `${JSON.stringify(jsonPayload, null, 2)}\n`, "utf8");

  console.log(`[viewport-sharing-report] wrote ${mdPath}`);
  console.log(`[viewport-sharing-report] wrote ${jsonPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
