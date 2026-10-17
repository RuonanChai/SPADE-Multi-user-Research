/**
 * Direct CDN 交付分析：基于 CDP 网络行（resource_timing_perf / cdn_edge_headers），
 * 输出 summary/direct_cdn_delivery.{json,md}。不涉及代理共享增益口径。
 *
 *   node scripts/analyze-direct-cdn-delivery.mjs --runRoot=<runRoot>
 */
import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const o = { runRoot: "" };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "runRoot") o.runRoot = v;
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

function isFormalRow(r) {
  if (!r) return false;
  const s = r.source;
  if (s !== "cdp_network" && s !== "fetch_hook") return false;
  if (r.debug_only) return false;
  const u = String(r.url || "");
  if (/\/debug-scene-probe\.rad(\?|$)/i.test(u)) return false;
  return true;
}

async function walkClientJsonl(runDir) {
  const out = [];
  async function walk(d) {
    const ent = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of ent) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.startsWith("client-") && e.name.endsWith(".jsonl")) out.push(p);
    }
  }
  await walk(runDir);
  return out;
}

function quantile(xs, q) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  if (s.length === 1) return s[0];
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (pos - lo) * (s[hi] - s[lo]);
}

function q509599(xs) {
  return { p50: quantile(xs, 0.5), p95: quantile(xs, 0.95), p99: quantile(xs, 0.99) };
}

function getHeader(hdrs, name) {
  if (!hdrs || typeof hdrs !== "object") return null;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(hdrs)) {
    if (String(k).toLowerCase() === lower) return v == null ? null : String(v);
  }
  return null;
}

function cfBucket(statusStr) {
  if (!statusStr) return "unknown";
  const s = String(statusStr).trim().toUpperCase();
  if (s === "HIT" || s === "STALE" || s === "REVALIDATED" || s === "UPDATING") return "hit_like";
  if (s === "MISS" || s === "BYPASS" || s === "EXPIRED") return "miss_like";
  if (s === "DYNAMIC") return "dynamic";
  return "other";
}

/** 与诊断脚本一致：若存在 bytes Range，则对象键包含字节区间，避免不同 Range 误并为同一对象。 */
function parseBytesRangeHeader(raw) {
  if (raw == null || !String(raw).trim()) return null;
  const s = String(raw).trim();
  const m = /^bytes=(\d+)-(\d+)$/i.exec(s);
  if (!m) return null;
  return { start: m[1], end: m[2], raw: s };
}

function rangeForDedup(r) {
  if (r.raw_range != null && String(r.raw_range).trim()) return String(r.raw_range).trim();
  const rh = r.request_headers && typeof r.request_headers === "object" ? r.request_headers : {};
  const hdr = rh.Range || rh.range;
  return hdr != null && String(hdr).trim() ? String(hdr).trim() : null;
}

function objectKeyFromRow(r) {
  const url = String(r.url || "");
  try {
    const u = new URL(url);
    const base = `${u.hostname.toLowerCase()}${u.pathname}`;
    const pr = parseBytesRangeHeader(rangeForDedup(r));
    if (pr) return `${base}::range=${pr.start}-${pr.end}`;
    return base;
  } catch {
    return url;
  }
}

function ttfbMs(r) {
  const p = r.resource_timing_perf;
  if (p && Number.isFinite(p.ttfb_ms)) return p.ttfb_ms;
  if (p && Number.isFinite(p.responseStart) && Number.isFinite(p.requestStart)) {
    return Math.max(0, p.responseStart - p.requestStart);
  }
  return null;
}

function downloadMs(r) {
  const p = r.resource_timing_perf;
  if (p && Number.isFinite(p.download_ms)) return p.download_ms;
  if (p && Number.isFinite(p.responseEnd) && Number.isFinite(p.responseStart)) {
    return Math.max(0, p.responseEnd - p.responseStart);
  }
  return null;
}

/** 仅当 CDP 行出现下列已约定字段之一（且为有限数值）时才计算 important_object_late_ratio；不得从未映射字段推断。 */
const VIEWPORT_PRIORITY_FIELDS = new Set(["spark_viewport_priority"]);

function viewportPriorityValue(r) {
  for (const k of VIEWPORT_PRIORITY_FIELDS) {
    const v = r[k];
    if (Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/**
 * 若日志含已映射视口优先级与 end_ts_ms：priority<=3 的 .spz/.ply 相对该用户首条 HTML 的 end_ts_ms 晚于 +800ms 记为 late。
 */
function importantObjectLateRatio(rows) {
  const sample = rows.find((r) => viewportPriorityValue(r) != null);
  if (!sample) {
    return {
      ratio: null,
      note: `无已映射视口优先级字段（当前仅 ${[...VIEWPORT_PRIORITY_FIELDS].join(", ")}），不计算 important_object_late_ratio`,
    };
  }

  const byUser = new Map();
  for (const r of rows) {
    const u = String(r.user_id || "");
    if (!u) continue;
    if (!byUser.has(u)) byUser.set(u, []);
    byUser.get(u).push(r);
  }

  let num = 0;
  let den = 0;
  for (const [, list] of byUser) {
    const doc = list.find(
      (r) =>
        isFormalRow(r) &&
        (String(r.mimeType || "").includes("html") || /\.html(\?|$)/i.test(String(r.url || ""))),
    );
    const t0 = doc?.end_ts_ms;
    if (!Number.isFinite(t0)) continue;
    for (const r of list) {
      const pr = viewportPriorityValue(r);
      if (pr == null || pr > 3) continue;
      if (!/\.(spz|ply)(\?|$)/i.test(String(r.url || ""))) continue;
      den += 1;
      const end = r.end_ts_ms;
      if (Number.isFinite(end) && end > t0 + 800) num += 1;
    }
  }
  if (!den) {
    return { ratio: null, note: "存在 spark_viewport_priority 但未匹配到重要 splat 或缺少 document 参照时间" };
  }
  return { ratio: num / den, note: null };
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

  const meta = JSON.parse(await fs.readFile(path.join(runRoot, "metadata.json"), "utf8").catch(() => "{}"));
  const scenario = String(meta.scenario || meta.workload || "default");

  const files = await walkClientJsonl(runRoot);
  const rows = [];
  for (const fp of files) {
    const raw = await fs.readFile(fp, "utf8").catch(() => "");
    for (const r of parseJsonl(raw)) {
      if (isFormalRow(r)) rows.push(r);
    }
  }

  const durations = rows.map((r) => r.duration_ms).filter((x) => Number.isFinite(x));
  const ttfbs = rows.map((r) => ttfbMs(r)).filter((x) => Number.isFinite(x));
  const dls = rows.map((r) => downloadMs(r)).filter((x) => Number.isFinite(x));

  const cfCounts = { hit_like: 0, miss_like: 0, dynamic: 0, other: 0, unknown: 0 };
  const statusDist = {};
  for (const r of rows) {
    const st = r.status == null ? "none" : String(r.status);
    statusDist[st] = (statusDist[st] || 0) + 1;
    const hdrs = { ...(r.response_headers || {}), ...(r.cdn_edge_headers || {}) };
    const cf = getHeader(hdrs, "cf-cache-status");
    cfCounts[cfBucket(cf)] += 1;
  }

  const cfDenom = cfCounts.hit_like + cfCounts.miss_like + cfCounts.dynamic + cfCounts.other;
  const cache_hit_ratio = cfDenom > 0 ? cfCounts.hit_like / cfDenom : null;
  const cache_miss_ratio = cfDenom > 0 ? cfCounts.miss_like / cfDenom : null;

  const keys = rows.map((r) => objectKeyFromRow(r));
  const uniq = new Set(keys);
  const total_object_requests = rows.length;
  const unique_object_count = uniq.size;
  const repeated_object_request_ratio =
    total_object_requests > 0 ? (total_object_requests - unique_object_count) / total_object_requests : null;

  const byUser = new Map();
  for (const r of rows) {
    const u = String(r.user_id || "");
    if (!u) continue;
    if (!byUser.has(u)) byUser.set(u, []);
    byUser.get(u).push(r);
  }

  const per_user = {};
  for (const [uid, list] of byUser) {
    const okn = list.filter((r) => r.ok === true).length;
    const durs = list.map((r) => r.duration_ms).filter((x) => Number.isFinite(x));
    per_user[uid] = {
      completion_count_ok: okn,
      request_count: list.length,
      duration_ms: q509599(durs),
    };
  }

  const iol = importantObjectLateRatio(rows);

  const per_scenario = {
    [scenario]: {
      client_duration_ms: q509599(durations),
      ttfb_ms: q509599(ttfbs),
      download_ms: q509599(dls),
      cache_hit_ratio,
      cache_miss_ratio,
      cf_cache_status_buckets: cfCounts,
      status_code_distribution: statusDist,
      unique_object_count,
      total_object_requests,
      repeated_object_request_ratio,
      important_object_late_ratio: iol.ratio,
      important_object_late_note: iol.note,
    },
  };

  const outJson = {
    generated_at: new Date().toISOString(),
    run_root: runRoot,
    scenario,
    delivery_mode: meta.delivery_mode || null,
    direct_cdn: Boolean(meta.direct_cdn),
    measurement_scope:
      "本报告仅描述浏览器直连 CDN 的请求级时延、缓存状态、对象级重复拉取、（若可得）重要可见对象到达与按用户公平性；不包含代理共享增益。",
    per_scenario,
    per_user,
  };

  await fs.writeFile(path.join(summaryDir, "direct_cdn_delivery.json"), `${JSON.stringify(outJson, null, 2)}\n`, "utf8");

  const sc = per_scenario[scenario];
  const md = [
    "# Direct CDN 交付分析",
    "",
    `生成时间：${outJson.generated_at}`,
    `run_root：\`${runRoot}\``,
    `场景：**${scenario}**`,
    "",
    "## 口径说明",
    "",
    outJson.measurement_scope,
    "",
    "## 汇总（按场景）",
    "",
    "| 指标 | p50 | p95 | p99 |",
    "|---|---:|---:|---:|",
    `| 客户端 duration_ms | ${sc.client_duration_ms.p50 ?? "—"} | ${sc.client_duration_ms.p95 ?? "—"} | ${sc.client_duration_ms.p99 ?? "—"} |`,
    `| TTFB 类 (responseStart−requestStart / ttfb_ms) | ${sc.ttfb_ms.p50 ?? "—"} | ${sc.ttfb_ms.p95 ?? "—"} | ${sc.ttfb_ms.p99 ?? "—"} |`,
    `| download 类 (responseEnd−responseStart / download_ms) | ${sc.download_ms.p50 ?? "—"} | ${sc.download_ms.p95 ?? "—"} | ${sc.download_ms.p99 ?? "—"} |`,
    "",
    `- **cache_hit_ratio**（CF-Cache-Status 归为 hit_like / 分母为已知类）: ${sc.cache_hit_ratio == null ? "—" : sc.cache_hit_ratio.toFixed(4)}`,
    `- **cache_miss_ratio**（miss_like）: ${sc.cache_miss_ratio == null ? "—" : sc.cache_miss_ratio.toFixed(4)}`,
    `- **CF 桶计数**: \`${JSON.stringify(sc.cf_cache_status_buckets)}\``,
    `- **HTTP 状态分布**: \`${JSON.stringify(sc.status_code_distribution)}\``,
    `- **unique_object_count**: ${sc.unique_object_count}`,
    `- **total_object_requests**: ${sc.total_object_requests}`,
    `- **repeated_object_request_ratio**: ${sc.repeated_object_request_ratio == null ? "—" : sc.repeated_object_request_ratio.toFixed(4)}`,
    `- **important_object_late_ratio**: ${sc.important_object_late_ratio == null ? "—（无 viewport 优先级或样本不足）" : sc.important_object_late_ratio.toFixed(4)}${sc.important_object_late_note ? ` — ${sc.important_object_late_note}` : ""}`,
    "",
    "## 按用户（完成数与 duration 尾部）",
    "",
    "| user | ok 完成条数 | 请求数 | duration p50 | p95 | p99 |",
    "|---|---:|---:|---:|---:|---:|",
    ...Object.keys(per_user)
      .sort()
      .map((u) => {
        const x = per_user[u];
        const d = x.duration_ms;
        return `| ${u} | ${x.completion_count_ok} | ${x.request_count} | ${d.p50 ?? "—"} | ${d.p95 ?? "—"} | ${d.p99 ?? "—"} |`;
      }),
    "",
    "## 解读约束（论文主文）",
    "",
    "- 主 CDN 性能应以 **direct CDN** 与本分析为准；代理路径仅作调试。",
    "- 不将 **proxy sharing gain** 表述为 CDN 加速；此处聚焦 **直连边缘的请求分解、缓存键可见行为、对象重复需求与公平性**。",
    "",
  ].join("\n");

  await fs.writeFile(path.join(summaryDir, "direct_cdn_delivery.md"), md, "utf8");
  console.log(`Wrote ${path.join(summaryDir, "direct_cdn_delivery.json")}`);
  console.log(`Wrote ${path.join(summaryDir, "direct_cdn_delivery.md")}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
