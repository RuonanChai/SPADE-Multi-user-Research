/**
 * Preflight: 校验单次 run 目录下 client CDP 日志 + proxy 日志是否满足覆盖与人数。
 * 分析优先使用 source=cdp_network 行；若无则退化为全部 client 行。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { SCENE_EXT, RANGE_RE } from "./dist-replay-constants.mjs";

function parseArgs(argv) {
  const out = { runDir: "", expectedUsers: 1, proxyLog: "", runId: "" };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "runDir") out.runDir = v;
    else if (k === "expectedUsers") out.expectedUsers = Number.parseInt(v || "1", 10);
    else if (k === "proxyLog") out.proxyLog = v;
    else if (k === "runId") out.runId = v;
  }
  return out;
}

async function walkJsonlFiles(root) {
  const out = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl") && e.name.startsWith("client-")) out.push(p);
    }
  }
  await walk(root);
  return out;
}

async function readJsonlLines(file) {
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function isCdpPrimary(row) {
  return !row.source || row.source === "cdp_network";
}

function hasSceneUrl(u) {
  return typeof u === "string" && SCENE_EXT.test(u);
}

function isDebugProbeUrl(u) {
  return typeof u === "string" && /\/debug-scene-probe\.rad(\?|$)/i.test(u);
}

function hasBinaryContentType(row) {
  const rh = row?.response_headers || {};
  const key = Object.keys(rh).find((k) => k.toLowerCase() === "content-type");
  if (!key) return false;
  const v = String(rh[key] || "").toLowerCase();
  return v.includes("octet-stream") || v.includes("binary");
}

function hasRangeEntry(row) {
  if (row.raw_range && String(row.raw_range).length) return true;
  const rh = row.response_headers;
  if (!rh) return false;
  const cr = Object.keys(rh).find((k) => k.toLowerCase() === "content-range");
  return Boolean(cr && rh[cr]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.runDir) {
    console.error("需要 --runDir=");
    process.exitCode = 1;
    return;
  }
  const runDir = path.resolve(args.runDir);
  const proxyPath = args.proxyLog
    ? path.resolve(args.proxyLog)
    : path.join(runDir, "proxy", "proxy.jsonl");
  const proxyRaw = await fs.readFile(proxyPath, "utf8").catch(() => "");
  const proxyLines = proxyRaw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((p) => !p.event || p.event === "request_complete");

  const jsonlFiles = await walkJsonlFiles(runDir);
  let allClient = [];
  for (const f of jsonlFiles) {
    const lines = await readJsonlLines(f);
    for (const row of lines) {
      if (args.runId && String(row.run_id || "") !== String(args.runId)) continue;
      allClient.push({ ...row, _file: f });
    }
  }
  const cdp = allClient.filter(isCdpPrimary);
  const fetchHooks = allClient.filter((r) => r && r.source === "fetch_hook");
  /** 有 CDP 时也必须合并 fetch_hook：正式探针的 ranged .spz 常只出现在 fetch_hook；旧逻辑仅用 cdp_network 会误判 has_scene_request=false */
  const formalRows = [...cdp, ...fetchHooks].filter(
    (r) => !r.debug_only && !isDebugProbeUrl(String(r.url || "")),
  );
  const proxyFormal = proxyLines.filter((p) => !isDebugProbeUrl(String(p.url || "")));

  const has_scene_request =
    formalRows.some((r) => hasSceneUrl(r.url) || hasBinaryContentType(r)) ||
    proxyFormal.some((p) => hasSceneUrl(String(p.url || "")));
  const has_range_request =
    formalRows.some(
      (r) =>
        hasRangeEntry(r) ||
        (r.request_headers && (RANGE_RE.test(JSON.stringify(r.request_headers)) || /range/i.test(JSON.stringify(r.request_headers)))),
    ) || proxyFormal.some((p) => p.raw_range && String(p.raw_range).length > 0);

  const userIds = [...new Set(formalRows.map((r) => r.user_id).filter(Boolean))];
  const num_users_seen = userIds.length;

  const byUser = new Map();
  for (const r of formalRows) {
    const u = r.user_id || "unknown";
    if (!byUser.has(u)) byUser.set(u, { completion: 0, stall: 0 });
  }
  for (const r of formalRows) {
    const u = r.user_id || "unknown";
    if (!r.ok) continue;
    if (!byUser.has(u)) byUser.set(u, { completion: 0, stall: 0 });
    const b = byUser.get(u);
    b.completion += 1;
    if (Number(r.duration_ms || 0) > 500) b.stall += 1;
  }
  const users_with_nonzero_completion = [...byUser.values()].filter((x) => x.completion > 0).length;

  const proxy_downstream = proxyRaw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((p) => p && p.event === "downstream_request_received").length;
  const proxy_upstream = proxyLines.length;

  const upstream_bytes_total = proxyLines.reduce((a, p) => a + (Number(p.upstream_bytes) || 0), 0);

  const out = {
    run_dir: runDir,
    run_id: args.runId || null,
    has_scene_request,
    has_range_request,
    client_request_count: formalRows.length,
    proxy_downstream_count: proxy_downstream,
    proxy_upstream_count: proxy_upstream,
    num_users_seen,
    expected_users: args.expectedUsers,
    users_with_nonzero_completion,
    upstream_bytes_total,
    used_cdp_only: cdp.length > 0,
  };

  const pass =
    has_scene_request &&
    has_range_request &&
    proxy_upstream > 0 &&
    num_users_seen === args.expectedUsers &&
    users_with_nonzero_completion === args.expectedUsers;

  out.coverage_ok = pass;

  const outPath = path.join(runDir, "validate-run-coverage.json");
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), "utf8");
  console.log(JSON.stringify(out, null, 2));
  console.log(`Wrote ${outPath}`);
  if (!pass) {
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
