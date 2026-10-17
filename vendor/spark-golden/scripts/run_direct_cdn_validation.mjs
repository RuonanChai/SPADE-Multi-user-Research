import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

function parseArgs(argv) {
  const out = {
    outRoot: "260427_direct_v1",
    repeats: 3,
    scenario: "B-lockstep",
    cdnBase: "",
    objectPath: "/assets/splats/butterfly.spz",
    configPath: "260425_repeat10/distributed-replay.config.json",
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "outRoot") out.outRoot = v || out.outRoot;
    else if (k === "repeats") out.repeats = Math.max(1, Number.parseInt(v || "3", 10));
    else if (k === "scenario") out.scenario = v || out.scenario;
    else if (k === "cdnBase") out.cdnBase = v || out.cdnBase;
    else if (k === "objectPath") out.objectPath = v || out.objectPath;
    else if (k === "configPath") out.configPath = v || out.configPath;
  }
  return out;
}

function rankAvg(vals) {
  const n = vals.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => vals[a] - vals[b]);
  const ranks = Array(n).fill(0);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && vals[idx[j]] === vals[idx[i]]) j += 1;
    const r = (i + j + 1) / 2;
    for (let k = i; k < j; k += 1) ranks[idx[k]] = r;
    i = j;
  }
  return ranks;
}

function pearson(xs, ys) {
  if (!xs.length || xs.length !== ys.length) return null;
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

function spearman(xs, ys) {
  if (!xs.length || xs.length !== ys.length) return null;
  return pearson(rankAvg(xs), rankAvg(ys));
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.outRoot);
  await fs.mkdir(root, { recursive: true });

  let cdnBase = args.cdnBase;
  if (!cdnBase) {
    const cfg = await readJson(path.resolve(args.configPath));
    cdnBase = cfg?.r2_public_origin || cfg?.r2_assets_origin || "";
  }
  if (!cdnBase) throw new Error("缺少 CDN base，请传 --cdnBase= 或在 config 中设置 r2_public_origin");
  cdnBase = String(cdnBase).replace(/\/$/, "");
  const objectPath = String(args.objectPath).startsWith("/") ? args.objectPath : `/${args.objectPath}`;

  const jsonlPath = path.join(root, "direct_cdn_resource_timing.jsonl");
  const csvPath = path.join(root, "direct_cdn_size_vs_duration.csv");
  const summaryPath = path.join(root, "direct_cdn_summary.md");
  await fs.writeFile(jsonlPath, "", "utf8");

  const reqSizes = [
    32 * 1024,
    64 * 1024,
    128 * 1024,
    256 * 1024,
    512 * 1024,
    1024 * 1024,
    2 * 1024 * 1024,
    4 * 1024 * 1024,
  ];

  const allResourceRows = [];
  const allCdpRows = [];
  let totalFetches = 0;

  for (let rep = 0; rep < args.repeats; rep += 1) {
    const runId = `direct-${args.scenario}-${Date.now()}-${rep + 1}`;
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });

    const reqMap = new Map();
    cdp.on("Network.requestWillBeSent", (evt) => {
      reqMap.set(evt.requestId, {
        run_id: runId,
        scenario: args.scenario,
        source: "cdp_network",
        requestId: evt.requestId,
        url: evt.request?.url || "",
        request_headers: evt.request?.headers || {},
        request_ts_monotonic: evt.timestamp ?? null,
      });
    });
    cdp.on("Network.responseReceived", (evt) => {
      const row = reqMap.get(evt.requestId);
      if (!row) return;
      row.protocol = evt.response?.protocol ?? null;
      row.status = evt.response?.status ?? null;
      row.headers = evt.response?.headers ?? {};
      row.responseReceived_ts = evt.timestamp ?? null;
      row.responseReceived_wallclock_ms = Date.now();
    });
    cdp.on("Network.loadingFinished", (evt) => {
      const row = reqMap.get(evt.requestId);
      if (!row) return;
      row.encodedDataLength = evt.encodedDataLength ?? null;
      row.loadingFinished_ts = evt.timestamp ?? null;
      row.loadingFinished_wallclock_ms = Date.now();
      allCdpRows.push(row);
      reqMap.delete(evt.requestId);
    });

    await page.goto("about:blank");

    const requests = reqSizes.map((size, i) => {
      const start = i * 4096;
      const end = start + size - 1;
      const url = `${cdnBase}${objectPath}?direct_run=${encodeURIComponent(runId)}&chunk=${i}`;
      return { url, size, range: `bytes=${start}-${end}` };
    });
    totalFetches += requests.length;

    await page.evaluate(async (items) => {
      for (const it of items) {
        try {
          await fetch(it.url, {
            headers: { Range: it.range, "Cache-Control": "no-cache" },
            cache: "no-store",
            mode: "cors",
          });
        } catch {
          /* */
        }
      }
      await new Promise((r) => setTimeout(r, 600));
    }, requests);

    const resourceRows = await page.evaluate(({ runId0, scenario0, cdnBase0, reqSizes0 }) => {
      const parseChunk = (name) => {
        try {
          const u = new URL(name);
          const c = Number.parseInt(u.searchParams.get("chunk") || "-1", 10);
          if (Number.isFinite(c) && c >= 0 && c < reqSizes0.length) return c;
        } catch {
          /* */
        }
        return null;
      };
      const rows = performance.getEntriesByType("resource") || [];
      return rows
        .filter((e) => typeof e.name === "string" && e.name.startsWith(cdnBase0))
        .map((e) => {
          const chunk = parseChunk(e.name);
          const requested_bytes = chunk == null ? null : reqSizes0[chunk];
          return {
          run_id: runId0,
          scenario: scenario0,
          source: "resource_timing",
          name: e.name,
          startTime: e.startTime,
          responseStart: e.responseStart,
          responseEnd: e.responseEnd,
          transferSize: e.transferSize,
          encodedBodySize: e.encodedBodySize,
          decodedBodySize: e.decodedBodySize,
          requested_bytes,
          duration: e.duration,
          response_window_ms: e.responseEnd - e.responseStart,
          };
        });
    }, { runId0: runId, scenario0: args.scenario, cdnBase0: cdnBase, reqSizes0: reqSizes });
    allResourceRows.push(...resourceRows);
    await browser.close();
  }

  // write jsonl (resource + cdp)
  const lines = [];
  for (const r of allResourceRows) lines.push(JSON.stringify(r));
  for (const r of allCdpRows) lines.push(JSON.stringify(r));
  await fs.writeFile(jsonlPath, `${lines.join("\n")}\n`, "utf8");

  // Build CSV from ResourceTiming first (preferred), fallback to CDP if needed
  const csvRows = [];
  for (const r of allResourceRows) {
    const bytes = Number(r.encodedBodySize || r.transferSize || r.requested_bytes || 0);
    const bodyWin = Number(r.response_window_ms || 0);
    const dur = Number(r.duration || 0);
    if (!(bytes > 0 && Number.isFinite(bodyWin) && Number.isFinite(dur))) continue;
    csvRows.push({
      run_id: r.run_id,
      source: "resource_timing",
      url: r.name,
      object_bytes: bytes,
      body_window_ms: bodyWin,
      duration_ms: dur,
    });
  }
  if (!csvRows.length) {
    for (const r of allCdpRows) {
      const bytes = Number(r.encodedDataLength || 0);
      const bodyWin =
        r.responseReceived_ts != null && r.loadingFinished_ts != null
          ? Math.max(0, (r.loadingFinished_ts - r.responseReceived_ts) * 1000)
          : null;
      const dur =
        r.request_ts_monotonic != null && r.loadingFinished_ts != null
          ? Math.max(0, (r.loadingFinished_ts - r.request_ts_monotonic) * 1000)
          : null;
      if (!(bytes > 0 && bodyWin != null && dur != null)) continue;
      csvRows.push({
        run_id: r.run_id,
        source: "cdp_network",
        url: r.url,
        object_bytes: bytes,
        body_window_ms: bodyWin,
        duration_ms: dur,
      });
    }
  }

  const csvHead = "run_id,source,url,object_bytes,body_window_ms,duration_ms";
  const csvBody = csvRows
    .map((r) =>
      [
        r.run_id,
        r.source,
        `"${String(r.url).replaceAll('"', '""')}"`,
        r.object_bytes,
        r.body_window_ms,
        r.duration_ms,
      ].join(","),
    )
    .join("\n");
  await fs.writeFile(csvPath, `${csvHead}\n${csvBody}\n`, "utf8");

  const xs = csvRows.map((r) => Number(r.object_bytes));
  const ysBody = csvRows.map((r) => Number(r.body_window_ms));
  const ysDur = csvRows.map((r) => Number(r.duration_ms));
  const spBody = spearman(xs, ysBody);
  const spDur = spearman(xs, ysDur);

  const proxy = await readJson(path.resolve("260425_repeat10/service_vs_bytes.json"));
  const proxySpearman = Number(proxy?.all_runs?.spearman ?? NaN);
  const sameDirection =
    Number.isFinite(proxySpearman) && Number.isFinite(spBody) ? Math.sign(proxySpearman) === Math.sign(spBody) : null;

  const largeSlow = (() => {
    if (!csvRows.length) return null;
    const sorted = [...csvRows].sort((a, b) => a.object_bytes - b.object_bytes);
    const n = sorted.length;
    const low = sorted.slice(0, Math.max(1, Math.floor(n * 0.3)));
    const high = sorted.slice(Math.max(0, Math.ceil(n * 0.7)));
    const m = (arr, k) => arr.reduce((s, x) => s + Number(x[k]), 0) / Math.max(1, arr.length);
    const lowBody = m(low, "body_window_ms");
    const highBody = m(high, "body_window_ms");
    return { lowBody, highBody, slower: highBody > lowBody };
  })();

  const summary = [
    "# Direct CDN Validation (B-lockstep x3)",
    "",
    `- out_root: \`${root}\``,
    `- scenario: \`${args.scenario}\``,
    `- repeats: ${args.repeats}`,
    `- cnd_base: \`${cdnBase}\``,
    `- proxy started: no`,
    `- total_fetches_planned: ${totalFetches}`,
    `- rows_resource_timing: ${allResourceRows.length}`,
    `- rows_cdp_network_finished: ${allCdpRows.length}`,
    `- rows_used_for_size_duration: ${csvRows.length}`,
    "",
    "## Correlation",
    `- Spearman(object_bytes, responseEnd-responseStart): ${spBody}`,
    `- Spearman(object_bytes, duration): ${spDur}`,
    `- Proxy-based baseline Spearman(bytes, service_ms) from \`260425_repeat10/service_vs_bytes.json\`: ${proxySpearman}`,
    `- Directional agreement (direct vs proxy): ${sameDirection === null ? "unknown" : sameDirection}`,
    "",
    "## Validation statements",
    `- direct CDN 下大对象是否仍然更慢: ${largeSlow == null ? "unknown" : largeSlow.slower} (top30% mean body=${largeSlow?.highBody}, bottom30% mean body=${largeSlow?.lowBody})`,
    `- proxy-based finding 是否得到方向性验证: ${
      sameDirection === null ? "无法判断" : sameDirection ? "是（同向）" : "否（方向不一致）"
    }`,
    "- 哪些结论仍然只能保留为 controlled proxy measurement:",
    "  - proxy 内 queue / service 分解（direct 路径未经过 instrumented proxy）",
    "  - upstream TTFB/body/service 的代理侧分段与 cache/protocol 细项解释",
    "  - 多用户分布式交互下的端到端 tail amplification 归因",
    "",
  ].join("\n");
  await fs.writeFile(summaryPath, summary, "utf8");
  console.log(`Wrote ${jsonlPath}`);
  console.log(`Wrote ${csvPath}`);
  console.log(`Wrote ${summaryPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

