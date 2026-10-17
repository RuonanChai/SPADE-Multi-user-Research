/**
 * 扫描配对实验产出目录，聚合 CSV + 按 sharing_gain_ratio 排序的场景摘要（用于 A/B/C/D 矩阵）。
 *
 *   node scripts/build-viewport-experiment-matrix.mjs --scanRoot=results/paired-abcd-matrix [--outDir=same]
 *
 * 识别目录名：`paired-*-*-shared`（兄弟 `-no_share`、`-compare`）。
 *
 * 不读取 GPU/渲染结论；仅汇总请求级延迟（CDP）、上游 fetch 规避、对象共享与 inflight/内存缓存。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

function parseArgs(argv) {
  const o = { scanRoot: "", outDir: "", prefix: "experiment_matrix" };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    const k = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const v = eq === -1 ? "" : arg.slice(eq + 1);
    if (k === "scanRoot") o.scanRoot = v;
    else if (k === "outDir") o.outDir = v;
    else if (k === "prefix") o.prefix = v || o.prefix;
  }
  return o;
}

async function readJson(p) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

function csvEscape(s) {
  const t = String(s ?? "");
  if (/[,"\r\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

function num(v) {
  if (v == null || !Number.isFinite(Number(v))) return "";
  return Number(v);
}

async function findSharedRoots(scanRoot) {
  const out = [];
  async function walk(dir, depth) {
    if (depth > 6) return;
    const ent = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of ent) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.endsWith("-shared") && existsSync(path.join(p, "metadata.json"))) {
          const base = p.slice(0, -"-shared".length);
          out.push({
            sharedRoot: p,
            noShareRoot: `${base}-no_share`,
            compareRoot: `${base}-compare`,
          });
        }
        await walk(p, depth + 1);
      }
    }
  }
  await walk(scanRoot, 0);
  return out;
}

function median(arr) {
  const s = arr.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.scanRoot) {
    console.error("需要 --scanRoot=");
    process.exitCode = 1;
    return;
  }
  const scanRoot = path.resolve(args.scanRoot);
  const outDir = path.resolve(args.outDir || scanRoot);
  await fs.mkdir(outDir, { recursive: true });

  const triplets = await findSharedRoots(scanRoot);
  if (!triplets.length) {
    console.warn(`[matrix] scanRoot 下未发现 *-shared 目录: ${scanRoot}`);
  }
  const scanNote = !triplets.length
    ? `\n> **扫描说明**：未发现任何 \`*-shared\` 配对目录（共享臂未产出或路径不在 scanRoot 下）。以下 CSV 仅含表头；请在配对脚本成功完成后重新运行本脚本。\n\n`
    : "";

  const headers = [
    "scenario",
    "run_id",
    "expected_users",
    "active_users",
    "overlap_jaccard",
    "shareable_objects",
    "unique_share_keys",
    "avoided_upstream_fetches",
    "saved_upstream_bytes",
    "sharing_gain_ratio",
    "inflight_join_count",
    "memory_cache_count",
    "inflight_join_ratio",
    "memory_cache_ratio",
    "client_p95",
    "client_p99",
    "upstream_p95",
    "upstream_p99",
    "delta_client_p95",
    "delta_client_p99",
    "warnings_count",
    "errors_count",
    "shared_arm_path",
  ];

  const rows = [];

  for (const { sharedRoot, noShareRoot, compareRoot } of triplets) {
    const meta = await readJson(path.join(sharedRoot, "metadata.json")) || {};
    const gain = await readJson(path.join(sharedRoot, "summary", "viewport_sharing_gain.json"));
    const val = await readJson(path.join(sharedRoot, "summary", "viewport_sharing_validation.json"));
    const overlap = await readJson(path.join(sharedRoot, "summary", "viewport_trace_overlap.json"));
    const cmpPath = path.join(compareRoot, "summary", "sharing_gain_comparison.json");
    const cmp = existsSync(cmpPath) ? await readJson(cmpPath) : null;

    const scenario = String(meta.scenario || gain?.scenario || "");
    const runId = String(meta.run_id || "");
    const expectedUsers = num(meta.expected_users);

    const rm = gain?.request_metrics || {};
    const bm = gain?.byte_metrics || {};
    const lm = gain?.latency_metrics || {};

    const shareable = num(rm.shareable_client_requests);
    const inflight = num(rm.inflight_join_count);
    const memHit = num(rm.memory_cache_hit_count);
    const upstreamLeaders = num(rm.upstream_fetch_count);

    let avoided = "";
    if (Number.isFinite(inflight) && Number.isFinite(memHit)) avoided = inflight + memHit;
    else if (Number.isFinite(shareable) && Number.isFinite(upstreamLeaders)) avoided = Math.max(0, shareable - upstreamLeaders);

    let ijRatio = "";
    let mcRatio = "";
    if (Number.isFinite(shareable) && shareable > 0 && Number.isFinite(inflight) && Number.isFinite(memHit)) {
      ijRatio = inflight / shareable;
      mcRatio = memHit / shareable;
    }

    const overlapJac =
      overlap?.average_overlap_ratio ??
      val?.pairwise_overlap_avg ??
      "";

    const activeUsers = val?.active_user_count ?? "";

    const clientP95 = lm?.client_duration_ms_from_cdp?.p95 ?? "";
    const clientP99 = lm?.client_duration_ms_from_cdp?.p99 ?? "";
    const originP95 = lm?.origin_fetch_ms?.p95 ?? lm?.ttfb_ms?.p95 ?? "";
    const originP99 = lm?.origin_fetch_ms?.p99 ?? lm?.ttfb_ms?.p99 ?? "";

    let dP95 = cmp?.deltas?.client_p95_ms_delta ?? "";
    let dP99 = cmp?.deltas?.client_p99_ms_delta ?? "";
    if (dP95 === "" && cmp?.extracts) {
      /** fallback */
    }

    const warningsCount = Array.isArray(val?.warnings) ? val.warnings.length : "";
    const errorsCount = Array.isArray(val?.errors) ? val.errors.length : "";

    const ratio = bm?.sharing_gain_ratio;

    rows.push({
      scenario,
      run_id: runId,
      expected_users: expectedUsers,
      active_users: activeUsers,
      overlap_jaccard: overlapJac,
      shareable_objects: shareable,
      unique_share_keys: rm.unique_share_keys ?? "",
      avoided_upstream_fetches: avoided,
      saved_upstream_bytes: bm.sharing_saved_bytes ?? "",
      sharing_gain_ratio: ratio == null || !Number.isFinite(Number(ratio)) ? "" : Number(ratio),
      inflight_join_count: inflight,
      memory_cache_count: memHit,
      inflight_join_ratio: ijRatio === "" ? "" : ijRatio,
      memory_cache_ratio: mcRatio === "" ? "" : mcRatio,
      client_p95: clientP95,
      client_p99: clientP99,
      upstream_p95: originP95,
      upstream_p99: originP99,
      delta_client_p95: dP95,
      delta_client_p99: dP99,
      warnings_count: warningsCount,
      errors_count: errorsCount,
      shared_arm_path: sharedRoot,
    });
  }

  const csvPath = path.join(outDir, `${args.prefix}_runs.csv`);
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => csvEscape(r[h])).join(","));
  }
  await fs.writeFile(csvPath, `${lines.join("\n")}\n`, "utf8");

  /** 场景级 median ratio 排序 */
  const byScenarioRatios = new Map();
  for (const r of rows) {
    if (!r.scenario) continue;
    const rr = Number(r.sharing_gain_ratio);
    if (!Number.isFinite(rr)) continue;
    if (!byScenarioRatios.has(r.scenario)) byScenarioRatios.set(r.scenario, []);
    byScenarioRatios.get(r.scenario).push(rr);
  }
  const scenarioStats = [];
  const scenSeen = new Set(rows.map((r) => r.scenario).filter(Boolean));
  for (const scen of scenSeen) {
    const arr = byScenarioRatios.get(scen) || [];
    scenarioStats.push({
      scenario: scen,
      median_sharing_gain_ratio: arr.length ? median(arr) : null,
      runs: rows.filter((r) => r.scenario === scen).length,
    });
  }
  scenarioStats.sort((a, b) => {
    const x = a.median_sharing_gain_ratio ?? -1;
    const y = b.median_sharing_gain_ratio ?? -1;
    return y - x;
  });

  const mdPath = path.join(outDir, `${args.prefix}_summary.md`);
  const ts = new Date().toISOString();

  function summarizeMechanism(scen) {
    const sub = rows.filter((r) => r.scenario === scen);
    let ij = 0;
    let mc = 0;
    let n = 0;
    for (const r of sub) {
      if (Number.isFinite(Number(r.inflight_join_ratio)) && Number.isFinite(Number(r.memory_cache_ratio))) {
        ij += Number(r.inflight_join_ratio);
        mc += Number(r.memory_cache_ratio);
        n += 1;
      }
    }
    if (!n) return "（缺少 inflight/memory_cache 分项）";
    const ai = ij / n;
    const am = mc / n;
    if (ai >= am * 1.25) return "主要来自 **in-flight coalescing**（均值 inflight/shareable 高于 cache/shareable）。";
    if (am >= ai * 1.25) return "主要来自 **短 TTL 内存缓存命中**。";
    return "**合并与内存缓存**占比接近，属混合来源。";
  }

  function summarizeLatency(scen) {
    const sub = rows.filter((r) => r.scenario === scen);
    const deltas = sub.map((r) => Number(r.delta_client_p95)).filter(Number.isFinite);
    if (!deltas.length) return "无配对 **delta_client_p95**（缺少 sharing_gain_comparison.json 或未跑配对）。仅能用单次 CDP 绝对值，无法断言共享臂相对基线的请求级延迟变化。";
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    if (avg < -5) return `配对 CDP client P95 平均 Δ≈${avg.toFixed(1)} ms（共享臂更低），请求级端到端观测偏改善（不含渲染归因）。`;
    if (avg > 5) return `配对 CDP client P95 平均 Δ≈${avg.toFixed(1)} ms（共享臂更高），请求级端到端观测偏变差或噪声占优。`;
    return `配对 CDP client P95 平均 Δ≈${avg.toFixed(1)} ms，接近基线（需在多次重复上看离散）。`;
  }

  const scenOrder = scenarioStats.map((s) => s.scenario);
  const bRow = scenarioStats.find((s) => /^B-/i.test(s.scenario));
  const cRow = scenarioStats.find((s) => /^C-/i.test(s.scenario));
  const dRow = scenarioStats.find((s) => /^D-/i.test(s.scenario));

  const md =
    `# Viewport 配对实验矩阵摘要\n\n` +
    `生成时间: ${ts}\n\n` +
    `扫描目录: \`${scanRoot.replace(/\\/g, "/")}\`\n\n` +
    scanNote +
    `## 场景对比（按 median sharing_gain_ratio 降序）\n\n` +
    `| 排序 | 场景 | 重复数 | median sharing_gain_ratio |\n| --- | --- | ---: | ---: |\n` +
    scenarioStats
      .map((s, i) => `| ${i + 1} | ${s.scenario} | ${s.runs} | ${s.median_sharing_gain_ratio == null ? "—" : (s.median_sharing_gain_ratio * 100).toFixed(2) + "%"} |\n`)
      .join("") +
    `\n> 说明：sharing_gain_ratio 来自共享臂 \`viewport_sharing_gain.json\`（对象字节口径）；**非 GPU/渲染提升**。\n\n` +
    `## 逐 run CSV\n\n` +
    `- \`${csvPath.replace(/\\/g, "/")}\`\n\n` +
    `## 简短解读（基于本次扫描到的重复；若重复不足请以实际矩阵为准）\n\n` +
    `- **B-lockstep 是否 sharing gain 最强**：` +
    `${bRow && scenOrder[0] === bRow.scenario ? "在本次汇总中 B 场景 median ratio 位列第一。" : "在本次汇总中未表现为最强（或缺少 B 场景有效数据）；请核对 CSV。"}\n` +
    `- **C-nearcohort 是否存在部分共享**：` +
    `${cRow && (cRow.median_sharing_gain_ratio ?? 0) > 0 ? "C 场景 median ratio>0，存在部分对象级共享收益。" : "C 场景无有效正增益或未采集。"}\n` +
    `- **D-divergent 是否较低增益**：` +
    `${dRow && bRow && (dRow.median_sharing_gain_ratio ?? -1) < (bRow.median_sharing_gain_ratio ?? 2) ? "D 的 median ratio 低于 B（符合发散轨迹预期方向）。" : "未能确认 D 相对 B 更低（数据不足或未配对）。"}\n` +
    `- **增益来源（合并 vs 内存缓存）**：` +
    `${scenOrder.length ? scenOrder.map((s) => `**${s}**：${summarizeMechanism(s)}`).join(" ") : "（无场景数据）"}\n` +
    `- **P95/P99（请求级 CDP，含浏览器栈混杂）**：` +
    `${scenOrder.length ? scenOrder.map((s) => `**${s}**：${summarizeLatency(s)}`).join(" ") : "（无场景数据）"}\n\n` +
    `---\n\n` +
    `约束：本文档**不**断言 GPU、着色器或帧渲染改进；仅讨论上游 fetch、边缘合并/内存缓存与 CDP 观测到的请求级延迟。\n`;

  await fs.writeFile(mdPath, md, "utf8");

  console.log(`[matrix] wrote ${csvPath}`);
  console.log(`[matrix] wrote ${mdPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
