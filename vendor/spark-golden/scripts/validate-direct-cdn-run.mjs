/**
 * Direct CDN 模式闸口：四用户均有 ok、同源 CDN、不经局域网代理、缓存头与 URL 卫生告警。
 *
 *   node scripts/validate-direct-cdn-run.mjs --runDir=<runRoot> --expectedUsers=4 --runId=<id>
 *
 * 输出 runDir/validate-direct-cdn-run.json；失败 exit 2。
 */
import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const o = { runDir: "", expectedUsers: 4, runId: "" };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "runDir") o.runDir = v;
    else if (k === "expectedUsers") o.expectedUsers = Number.parseInt(v || "4", 10);
    else if (k === "runId") o.runId = v;
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

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

const BANNED_HOST_SUBSTR = ["127.0.0.1", "localhost", "10.4.158.143"];

const ASSET_EXT_RE = /\.(spz|ply|bin|wasm|glb|gltf|ktx2|jpg|jpeg|png|m4s|mp4|rad|splat)(\?|$)/i;
const EPHEMERAL_QUERY_KEYS = new Set([
  "run_id",
  "runId",
  "user_id",
  "userId",
  "trace_id",
  "traceId",
  "timestamp",
  "ts",
  "formal_probe",
  "formal_probe_single",
  "cachebuster",
  "cb",
  "nonce",
  "session_id",
  "sessionId",
]);

function assetUrlHasEphemeralQuery(url) {
  try {
    const u = new URL(String(url));
    const looksAsset = ASSET_EXT_RE.test(u.pathname) || /\/assets\//i.test(u.pathname);
    if (!looksAsset || !u.search || u.search.length <= 1) return false;
    for (const k of u.searchParams.keys()) {
      if (EPHEMERAL_QUERY_KEYS.has(k)) return true;
    }
  } catch {
    return false;
  }
  return false;
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
  if (!args.runDir) {
    console.error("需要 --runDir=");
    process.exitCode = 1;
    return;
  }
  const runDir = path.resolve(args.runDir);
  const metaPath = path.join(runDir, "metadata.json");
  const meta = JSON.parse(await fs.readFile(metaPath, "utf8").catch(() => "{}"));
  if (!meta.direct_cdn) {
    console.warn("[validate-direct-cdn] metadata.direct_cdn 非 true，仍执行 CDN 规则校验");
  }

  const files = await walkClientJsonl(runDir);
  const rows = [];
  for (const fp of files) {
    const raw = await fs.readFile(fp, "utf8").catch(() => "");
    for (const r of parseJsonl(raw)) {
      if (args.runId && String(r.run_id || "") !== String(args.runId)) continue;
      if (isFormalRow(r)) rows.push(r);
    }
  }

  const errors = [];
  const warnings = [];

  const byUserOk = new Map();
  for (const r of rows) {
    const u = String(r.user_id || "");
    if (!u) continue;
    if (!byUserOk.has(u)) byUserOk.set(u, 0);
    if (r.ok === true) byUserOk.set(u, byUserOk.get(u) + 1);
  }

  const expected = Math.max(1, args.expectedUsers);
  const seenUsers = [...new Set(rows.map((r) => String(r.user_id || "")).filter(Boolean))].sort();
  if (seenUsers.length < expected) {
    errors.push(`用户数不足: 期望至少 ${expected} 个 user_id，日志中仅见 ${seenUsers.length}: ${seenUsers.join(", ") || "—"}`);
  }
  for (const u of seenUsers) {
    if ((byUserOk.get(u) || 0) < 1) {
      errors.push(`用户 ${u} 无 ok:true 的正式请求（direct CDN 闸口失败）`);
    }
  }

  const hosts = new Set();
  for (const r of rows) {
    const h = hostOf(r.url);
    if (h) hosts.add(h);
    for (const ban of BANNED_HOST_SUBSTR) {
      if (h.includes(ban) || String(r.url || "").includes(`://${ban}`) || String(r.url || "").includes(`://${ban}:`)) {
        errors.push(`禁止经代理/本机伪 CDN：URL 命中 ${ban}: ${String(r.url).slice(0, 160)}`);
      }
    }
  }
  const streamingLodMode = Boolean(meta.direct_cdn_streaming_lod);
  if (!streamingLodMode && hosts.size > 1) {
    errors.push(`CDN 主机不一致（应单一源）: ${[...hosts].join(", ")}`);
  }
  if (streamingLodMode && hosts.size > 1) {
    warnings.push(
      `streaming-lod 直连实验：观测到多主机（HTML 源与 .rad 等资产域），属预期；不据此声称单一 CDN 边缘或缓存命中。hosts=${[...hosts].join(", ")}`,
    );
  }
  if (rows.length && hosts.size === 0) {
    errors.push("无法从正式请求中解析出任何 CDN 主机名");
  }

  let nCf = 0;
  let nCfMiss = 0;
  let nTaoMiss = 0;
  let nAssetBadQuery = 0;
  for (const r of rows) {
    const hdrs = r.cdn_edge_headers || r.response_headers || {};
    const cf = hdrs["cf-cache-status"] ?? hdrs["CF-Cache-Status"];
    if (!cf && r.status != null && Number(r.status) > 0) nCfMiss += 1;
    else if (cf) nCf += 1;
    const tao = hdrs["timing-allow-origin"] ?? hdrs["Timing-Allow-Origin"];
    if (!tao && r.status != null && Number(r.status) >= 200 && Number(r.status) < 400) nTaoMiss += 1;
    if (assetUrlHasEphemeralQuery(String(r.url || ""))) {
      nAssetBadQuery += 1;
    }
  }
  if (nCfMiss > 0) warnings.push(`${nCfMiss} 条响应缺少 CF-Cache-Status（或非 CDN 边缘），CDN 缓存命中率解读需谨慎`);
  if (nTaoMiss > 0) warnings.push(`${nTaoMiss} 条成功响应缺少 Timing-Allow-Origin（跨域 Resource Timing 可能受限）`);
  if (nAssetBadQuery > 0) warnings.push(`${nAssetBadQuery} 条资源 URL 仍含 run_id/user_id/trace_id/ts 等查询参数，可能改变 CDN 缓存键`);

  const ok = errors.length === 0;
  const outPayload = {
    generated_at: new Date().toISOString(),
    run_dir: runDir,
    run_id: args.runId || meta.run_id || null,
    direct_cdn: Boolean(meta.direct_cdn),
    cdn_hosts: [...hosts],
    users_seen: seenUsers,
    ok_count_by_user: Object.fromEntries(byUserOk),
    validation_ok: ok,
    errors,
    warnings,
    rows_analyzed: rows.length,
  };

  const outPath = path.join(runDir, "validate-direct-cdn-run.json");
  await fs.writeFile(outPath, `${JSON.stringify(outPayload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(outPayload, null, 2));
  for (const w of warnings) console.warn(`[validate-direct-cdn] WARN ${w}`);
  for (const e of errors) console.error(`[validate-direct-cdn] ERR ${e}`);
  if (!ok) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
