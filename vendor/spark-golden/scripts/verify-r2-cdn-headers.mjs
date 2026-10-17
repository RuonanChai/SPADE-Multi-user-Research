/**
 * 对 R2 公网 URL 与（可选）本机 instrumented 代理做重复 GET，
 * 提取 cf-cache-status / x-cache / cache-control / age 等，写入 JSON。
 *
 * 用法:
 *   node scripts/verify-r2-cdn-headers.mjs
 *   node scripts/verify-r2-cdn-headers.mjs --path=/assets/splats/butterfly.spz --proxyBase=http://127.0.0.1:8092
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const o = {
    r2Base: "https://pub-0429777a95db48e192b4c665413f8eb2.r2.dev",
    path: "/assets/splats/butterfly.spz",
    proxyBase: "http://127.0.0.1:8092",
    repeats: 2,
    out: path.join(projectRoot, "results", "distributed", "p3-real-run", "r2-cdn-header-verify.json"),
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "r2Base") o.r2Base = v || o.r2Base;
    else if (k === "path") o.path = v || o.path;
    else if (k === "proxyBase") o.proxyBase = v || o.proxyBase;
    else if (k === "repeats") o.repeats = Math.max(1, Number.parseInt(v || "2", 10));
    else if (k === "out") o.out = v || o.out;
  }
  return o;
}

const INTEREST = [
  "server",
  "cf-cache-status",
  "cf-ray",
  "age",
  "cache-control",
  "x-cache",
  "x-cache-hits",
  "via",
  "etag",
  "last-modified",
  "content-range",
];

function pickHeaders(h) {
  const out = {};
  for (const name of INTEREST) {
    const v = h.get(name);
    if (v != null) out[name] = v;
  }
  return out;
}

async function fetchOnce(url, init = {}) {
  const r = await fetch(url, { ...init, redirect: "follow" });
  const headersObj = Object.fromEntries(r.headers.entries());
  const picked = pickHeaders(r.headers);
  const buf = new Uint8Array(await r.arrayBuffer());
  return {
    url,
    status: r.status,
    ok: r.ok,
    body_bytes: buf.byteLength,
    headers_all: headersObj,
    headers_interest: picked,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const directUrl = new URL(args.path, args.r2Base.replace(/\/$/, "") + "/").toString();
  const proxyUrl = new URL(args.path, args.proxyBase.replace(/\/$/, "") + "/").toString();

  const rangeInit = { method: "GET", headers: { Range: "bytes=0-1023" } };

  const direct = [];
  for (let i = 0; i < args.repeats; i += 1) {
    direct.push({ attempt: i + 1, ...(await fetchOnce(directUrl, rangeInit)) });
  }

  const viaProxy = [];
  for (let i = 0; i < args.repeats; i += 1) {
    try {
      viaProxy.push({ attempt: i + 1, ...(await fetchOnce(proxyUrl, rangeInit)) });
    } catch (e) {
      viaProxy.push({ attempt: i + 1, error: String(e?.message || e) });
    }
  }

  const summary = {
    r2_base: args.r2Base,
    path: args.path,
    direct_url: directUrl,
    proxy_url: proxyUrl,
    note:
      "R2 公共 r2.dev 上很多响应不携带 cf-cache-status；若需明确 HIT/MISS，请使用 Workers 或绑定自定义域并配置 Cache Rules。本脚本仅如实记录实际出现的响应头。",
  };

  const cfDirect = direct.map((d) => d.headers_interest["cf-cache-status"] ?? null);
  const cfProxy = viaProxy.map((d) => (d.headers_interest ? d.headers_interest["cf-cache-status"] : null));

  const out = {
    generated_at: new Date().toISOString(),
    summary,
    direct_requests: direct,
    proxy_requests: viaProxy,
    cf_cache_status_observed: {
      direct: cfDirect,
      via_instrumented_proxy: cfProxy,
    },
  };

  await fs.mkdir(path.dirname(args.out), { recursive: true });
  await fs.writeFile(args.out, JSON.stringify(out, null, 2), "utf8");
  console.log(`verify-r2-cdn-headers: wrote ${args.out}`);
  console.log("cf-cache-status (direct):", cfDirect.join(", ") || "(none)");
  console.log("cf-cache-status (proxy):", cfProxy.join(", ") || "(none or proxy unreachable)");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
