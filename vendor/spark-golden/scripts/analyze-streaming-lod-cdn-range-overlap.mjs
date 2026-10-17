/**
 * streaming-lod 直连 CDN：按 object_key（URL::range=start-end）分析多用户 Range 重叠与请求级时延。
 * 不声称 GPU/渲染、代理共享增益；无 CF-Cache-Status 时不推断 CDN 缓存。
 *
 *   node scripts/analyze-streaming-lod-cdn-range-overlap.mjs --runRoot=<runRoot>
 *
 * 产出：runRoot/summary/streaming_lod_range_overlap.json|.md
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
  if (r.source !== "cdp_network" && r.source !== "fetch_hook") return false;
  if (r.debug_only) return false;
  const u = String(r.url || "");
  if (/\/debug-scene-probe\.rad(\?|$)/i.test(u)) return false;
  return true;
}

const FILTER_EXT = /\.(rad|spz|splat|bin)(\?|$)/i;

function isRangeRelevantRow(r) {
  const u = String(r.url || "");
  if (FILTER_EXT.test(u)) return true;
  const rr = r.raw_range || r.request_headers_range;
  const cr = r.content_range || r.response_headers_content_range;
  if (rr && String(rr).trim()) return true;
  if (cr && String(cr).trim()) return true;
  return false;
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

function setJaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? null : inter / union;
}

function mean(xs) {
  const a = xs.filter((x) => Number.isFinite(x));
  if (!a.length) return null;
  return a.reduce((s, x) => s + x, 0) / a.length;
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
  const scenario = String(meta.scenario || "default");

  const files = await walkClientJsonl(runRoot);
  const rows = [];
  for (const fp of files) {
    const raw = await fs.readFile(fp, "utf8").catch(() => "");
    for (const r of parseJsonl(raw)) {
      if (isFormalRow(r)) rows.push(r);
    }
  }

  const filtered = rows.filter(isRangeRelevantRow);
  const keys = filtered.map((r) => String(r.object_key || "").trim()).filter(Boolean);
  const total_range_requests = filtered.length;
  const uniqueKeys = new Set(keys);
  const unique_range_objects = uniqueKeys.size;
  const repeated_range_request_ratio =
    total_range_requests > 0 ? (total_range_requests - unique_range_objects) / total_range_requests : null;

  const byUser = new Map();
  for (const r of filtered) {
    const u = String(r.user_id || "");
    if (!u) continue;
    if (!byUser.has(u)) byUser.set(u, []);
    byUser.get(u).push(r);
  }

  const userIds = [...byUser.keys()].sort();
  const userKeySets = new Map();
  for (const uid of userIds) {
    const ks = new Set(byUser.get(uid).map((r) => String(r.object_key || "").trim()).filter(Boolean));
    userKeySets.set(uid, ks);
  }

  const pairwise_user_range_jaccard = {};
  const jaccardList = [];
  for (let i = 0; i < userIds.length; i++) {
    for (let j = i + 1; j < userIds.length; j++) {
      const a = userIds[i];
      const b = userIds[j];
      const jacc = setJaccard(userKeySets.get(a) || new Set(), userKeySets.get(b) || new Set());
      pairwise_user_range_jaccard[`${a}|${b}`] = jacc;
      if (jacc != null) jaccardList.push(jacc);
    }
  }

  const range_overlap_mean = mean(jaccardList);
  const range_overlap_p50 = quantile(jaccardList, 0.5);
  const range_overlap_p95 = quantile(jaccardList, 0.95);

  const durs = filtered.map((r) => r.duration_ms).filter((x) => Number.isFinite(x));
  const ttfbs = filtered.map((r) => r.ttfb_ms).filter((x) => Number.isFinite(x));
  const dls = filtered.map((r) => r.download_ms).filter((x) => Number.isFinite(x));

  const per_user = {};
  for (const uid of userIds) {
    const list = byUser.get(uid) || [];
    const okn = list.filter((r) => r.ok === true).length;
    const du = list.map((r) => r.duration_ms).filter((x) => Number.isFinite(x));
    per_user[uid] = {
      ok_count: okn,
      request_count: list.length,
      duration_ms: q509599(du),
    };
  }

  let warnings_count = 0;
  const valPath = path.join(runRoot, "validate-direct-cdn-run.json");
  const val = JSON.parse(await fs.readFile(valPath, "utf8").catch(() => "{}"));
  if (Array.isArray(val.warnings)) warnings_count += val.warnings.length;
  warnings_count += filtered.filter((r) => r.ok === false).length;

  const outJson = {
    generated_at: new Date().toISOString(),
    run_root: runRoot,
    scenario,
    direct_cdn_streaming_lod: Boolean(meta.direct_cdn_streaming_lod),
    measurement_scope:
      "仅描述多用户下 HTTP Range/object_key 重叠与请求级时延分布；不包含 GPU/渲染、代理共享增益；无 CF-Cache-Status 时不推断 Cloudflare 缓存。",
    total_range_requests,
    unique_range_objects,
    repeated_range_request_ratio,
    pairwise_user_range_jaccard,
    range_overlap_mean,
    range_overlap_p50,
    range_overlap_p95,
    duration_ms: q509599(durs),
    ttfb_p95: quantile(ttfbs, 0.95),
    download_p95: quantile(dls, 0.95),
    per_user,
    warnings_count,
    expected_trend_note:
      "B-lockstep 通常 Range 对象重叠最高；C-nearcohort 中等；D-divergent 最低且 unique_range_objects 往往更高（依网络与时长而定）。",
  };

  const jsonPath = path.join(summaryDir, "streaming_lod_range_overlap.json");
  await fs.writeFile(jsonPath, `${JSON.stringify(outJson, null, 2)}\n`, "utf8");

  const md = [
    "# streaming-lod 直连：Range 对象重叠分析",
    "",
    `- **scenario**: ${scenario}`,
    `- **total_range_requests**: ${total_range_requests}`,
    `- **unique_range_objects**: ${unique_range_objects}`,
    `- **repeated_range_request_ratio**: ${repeated_range_request_ratio == null ? "—" : repeated_range_request_ratio.toFixed(4)}`,
    `- **pairwise_user_range_jaccard**: \`${JSON.stringify(pairwise_user_range_jaccard)}\``,
    `- **range_overlap_mean / p50 / p95**: ${range_overlap_mean ?? "—"} / ${range_overlap_p50 ?? "—"} / ${range_overlap_p95 ?? "—"}`,
    `- **duration_ms p50/p95/p99**: ${[outJson.duration_ms.p50, outJson.duration_ms.p95, outJson.duration_ms.p99].join(" / ")}`,
    `- **ttfb_p95 / download_p95**: ${outJson.ttfb_p95 ?? "—"} / ${outJson.download_p95 ?? "—"}`,
    `- **warnings_count**: ${warnings_count}`,
    "",
    "## 口径",
    "",
    outJson.measurement_scope,
    "",
    outJson.expected_trend_note,
    "",
  ].join("\n");
  await fs.writeFile(path.join(summaryDir, "streaming_lod_range_overlap.md"), md, "utf8");
  console.log(`Wrote ${jsonPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
