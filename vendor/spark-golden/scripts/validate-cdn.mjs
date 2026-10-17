import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const out = {
    cdnBaseUrl: "",
    output: "260429/cdn-validation.json",
    sampleObject: "butterfly.spz",
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "cdn-base-url") out.cdnBaseUrl = v || out.cdnBaseUrl;
    else if (k === "output") out.output = v || out.output;
    else if (k === "sample-object") out.sampleObject = v || out.sampleObject;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.cdnBaseUrl) {
    throw new Error("缺少 --cdn-base-url");
  }
  const base = args.cdnBaseUrl.replace(/\/$/, "");
  if (/localhost|127\.0\.0\.1/i.test(base)) {
    throw new Error("direct-cdn 模式不允许 localhost/proxy URL");
  }
  const url = `${base}/${args.sampleObject}`;
  const resp = await fetch(url, { headers: { Range: "bytes=0-1023" } });
  const h = resp.headers;
  const expose = (h.get("access-control-expose-headers") || "").toLowerCase();
  const report = {
    url,
    status: resp.status,
    ok: resp.ok,
    checks: {
      status_ok: resp.status === 200 || resp.status === 206,
      timing_allow_origin: h.has("timing-allow-origin"),
      expose_required_headers:
        expose.includes("cf-cache-status") &&
        expose.includes("age") &&
        expose.includes("cf-ray") &&
        expose.includes("content-length") &&
        expose.includes("content-range") &&
        expose.includes("server-timing"),
      cache_control_allows_cdn: /public/i.test(h.get("cache-control") || ""),
      no_local_proxy_url: !/localhost|127\.0\.0\.1/i.test(url),
    },
    headers: {
      "timing-allow-origin": h.get("timing-allow-origin"),
      "access-control-expose-headers": h.get("access-control-expose-headers"),
      "cache-control": h.get("cache-control"),
      "cf-cache-status": h.get("cf-cache-status"),
      age: h.get("age"),
      "cf-ray": h.get("cf-ray"),
      "content-length": h.get("content-length"),
      "content-range": h.get("content-range"),
      "server-timing": h.get("server-timing"),
    },
    deployment_checklist: [
      "设置 Timing-Allow-Origin: *",
      "设置 Access-Control-Expose-Headers 包含 CF-Cache-Status/Age/CF-Ray/Content-Length/Content-Range/Server-Timing",
      "设置 Cache-Control: public, max-age=31536000, immutable",
      "确认主实验 URL 不经过本地代理",
    ],
  };
  const outPath = path.resolve(args.output);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`wrote ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
