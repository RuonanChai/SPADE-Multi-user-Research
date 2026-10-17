/**
 * 单用户、短时：streaming-lod（失败则 multi-lod）上对比 phase A/B 相机位姿下的
 * HTTP 可见 URL / Range / Content-Range。不写 GPU/渲染/CDN 缓存结论。
 *
 *   node scripts/diagnose-streaming-lod-range-by-pose.mjs [--outDir=260506_v4/streaming-lod-range-pose] [--phaseMs=20000] [--port=0]
 *
 * 产出：outDir/summary/streaming_lod_range_by_pose.{json,md}
 */
import { createServer } from "node:http";
import fs from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const o = {
    outDir: path.join(projectRoot, "260506_v4", "streaming-lod-range-pose"),
    phaseMs: 20_000,
    port: 0,
    page: "streaming-lod",
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "outDir") o.outDir = v || o.outDir;
    else if (k === "phaseMs") o.phaseMs = Math.max(3000, Number.parseInt(v || "20000", 10));
    else if (k === "port") o.port = Number.parseInt(v || "0", 10);
    else if (k === "page") o.page = v || o.page;
  }
  return o;
}

function headersToObject(h) {
  if (!h || typeof h !== "object") return {};
  if (Array.isArray(h)) {
    const o = {};
    for (const { name, value } of h) {
      if (name) o[String(name).toLowerCase()] = value;
    }
    return o;
  }
  const o = {};
  for (const [k, v] of Object.entries(h)) o[String(k).toLowerCase()] = v;
  return o;
}

function getHeader(hdrs, name) {
  if (!hdrs) return null;
  const l = name.toLowerCase();
  for (const [k, v] of Object.entries(hdrs)) {
    if (String(k).toLowerCase() === l) return v == null ? null : String(v);
  }
  return null;
}

function responseHeadersFromEvent(evt) {
  return headersToObject(evt.response?.headers);
}

const FILTER_EXT = /\.(rad|spz|splat|bin)(\?|$)/i;

function isFilteredRow(row) {
  const u = String(row.url || "");
  if (FILTER_EXT.test(u)) return true;
  const rr = row.request_headers_range || row.raw_range;
  const cr = row.response_headers_content_range;
  if (rr && String(rr).trim()) return true;
  if (cr && String(cr).trim()) return true;
  return false;
}

function normalizeRange(s) {
  if (s == null || !String(s).trim()) return null;
  return String(s).trim().replace(/\s+/g, "");
}

function setJaccard(a, b) {
  const A = new Set([...a].filter(Boolean));
  const B = new Set([...b].filter(Boolean));
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? null : inter / union;
}

function injectCameraExpose(html, label) {
  const needles = ["const controls = new SparkControls", "controls = new SparkControls({ canvas: renderer.domElement })"]; 
  const needle = needles.find((n) => html.includes(n));
  if (!needle) {
    throw new Error(`${label}: 未找到注入锚点（${needles.join(" | ")}）`);
  }
  return html.replace(needle, "window.__sparkPoseDiagCamera = camera; window.__sparkPoseDiagScene = scene; " + needle);
}

/** 示例页默认依赖 ../../dist 与 examples/js/vendor；CI/裸 clone 常缺失。改为 CDN 以保证脚本能执行（仅诊断脚本写入的缓存 HTML）。 */
function applyDiagnosticImportMapCdn(html) {
  const THREE_CDN = "https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js";
  const LIL_CDN = "https://cdn.jsdelivr.net/npm/lil-gui@0.20.0/dist/lil-gui.esm.js";
  const SPARK_CDN = "https://cdn.jsdelivr.net/npm/@sparkjsdev/spark@2.0.0/dist/spark.module.js";
  let h = html;
  h = h.replace(
    /"three"\s*:\s*"\.\.\/js\/vendor\/three\/build\/three\.module\.js"/,
    `"three": "${THREE_CDN}"`,
  );
  h = h.replace(
    /"lil-gui"\s*:\s*"\/examples\/js\/vendor\/lil-gui\/dist\/lil-gui\.esm\.js"/,
    `"lil-gui": "${LIL_CDN}"`,
  );
  h = h.replace(
    /"@sparkjsdev\/spark"\s*:\s*"\.\.\/\.\.\/dist\/spark\.module\.js"/,
    `"@sparkjsdev/spark": "${SPARK_CDN}"`,
  );
  return { html: h, diagnostic_import_map: { three: THREE_CDN, lil_gui: LIL_CDN, spark: SPARK_CDN } };
}

async function writeOverrideHtml(relPath, outAbs) {
  const orig = path.join(projectRoot, relPath);
  let html = await fs.readFile(orig, "utf8");
  const { html: htmlCdn, diagnostic_import_map } = applyDiagnosticImportMapCdn(html);
  html = htmlCdn;
  html = injectCameraExpose(html, relPath);
  const outFile = path.join(outAbs, ".diag-cache", relPath.replace(/^\//, ""));
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, html, "utf8");
  return { outFile, diagnostic_import_map };
}

async function startStaticServer(root, preferredPort, pathOverrides) {
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".map": "application/json",
  };
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      let p = decodeURIComponent(u.pathname);
      if (p === "/") p = "/index.html";
      let disk = null;
      if (pathOverrides && pathOverrides.has(p)) disk = pathOverrides.get(p);
      else if (p.startsWith("/examples/")) disk = path.join(root, p);
      else if (p.startsWith("/dist/")) disk = path.join(root, p);
      else if (p.startsWith("/src/")) disk = path.join(root, p);
      else {
        res.writeHead(404);
        res.end("404");
        return;
      }
      if (!existsSync(disk) || !statSync(disk).isFile()) {
        res.writeHead(404);
        res.end("missing " + p);
        return;
      }
      const ext = path.extname(disk).toLowerCase();
      res.setHeader("Content-Type", mime[ext] || "application/octet-stream");
      res.writeHead(200);
      res.end(readFileSync(disk));
    } catch (e) {
      res.writeHead(500);
      res.end(String(e?.message || e));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(preferredPort > 0 ? preferredPort : 0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr && "port" in addr ? addr.port : 0;
  return { server, port };
}

async function runOnePage(browser, baseUrl, relPath, opts, phaseMs, poseA, poseB) {
  const pageUrl = `${baseUrl}${relPath}`;
  const rows = [];
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  const reqMap = new Map();
  let currentPhase = "A";

  const snapCam = async () => {
    return page
      .evaluate(() => {
        const c = window.__sparkPoseDiagCamera;
        if (!c || !c.position || !c.quaternion) return null;
        return {
          position: c.position.toArray ? c.position.toArray() : [c.position.x, c.position.y, c.position.z],
          quaternion: c.quaternion.toArray ? c.quaternion.toArray() : [c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w],
        };
      })
      .catch(() => null);
  };

  cdp.on("Network.requestWillBeSent", (evt) => {
    const rh = headersToObject(evt.request?.headers);
    const rangeHdr = getHeader(rh, "range") || getHeader(rh, "Range");
    const row = {
      url: evt.request?.url || "",
      method: (evt.request?.method || "GET").toUpperCase(),
      request_headers: rh,
      request_headers_range: rangeHdr,
      raw_range: rangeHdr,
      start_ts_ms: Date.now(),
      phase: currentPhase,
      camera_pose: null,
    };
    reqMap.set(evt.requestId, row);
  });

  cdp.on("Network.responseReceived", (evt) => {
    const row = reqMap.get(evt.requestId);
    if (!row) return;
    const rh = responseHeadersFromEvent(evt);
    row.status = evt.response?.status;
    row.ok = (evt.response?.status ?? 0) >= 200 && (evt.response?.status ?? 0) < 400;
    row.response_headers = rh;
    row.response_headers_content_range = getHeader(rh, "content-range");
    row.response_headers_accept_ranges = getHeader(rh, "accept-ranges");
    row.response_headers_content_length = getHeader(rh, "content-length");
    row.response_headers_etag = getHeader(rh, "etag");
    row.response_start_ts_ms = Date.now();
  });

  cdp.on("Network.loadingFinished", async (evt) => {
    const row = reqMap.get(evt.requestId);
    if (!row) return;
    row.end_ts_ms = Date.now();
    if (row.start_ts_ms != null && row.end_ts_ms != null) {
      row.duration_ms = Math.max(0, row.end_ts_ms - row.start_ts_ms);
    }
    row.camera_pose = await snapCam().catch(() => null);
    rows.push(row);
    reqMap.delete(evt.requestId);
  });

  cdp.on("Network.loadingFailed", async (evt) => {
    const row = reqMap.get(evt.requestId);
    if (!row) return;
    row.end_ts_ms = Date.now();
    row.ok = false;
    row.status = row.status ?? 0;
    row.duration_ms =
      row.start_ts_ms != null && row.end_ts_ms != null ? Math.max(0, row.end_ts_ms - row.start_ts_ms) : null;
    row.camera_pose = await snapCam().catch(() => null);
    rows.push(row);
    reqMap.delete(evt.requestId);
  });

  await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
  // Playwright: waitForFunction(pageFunction, arg?, options?) — 不能把 options 当第二个参数，否则会当成 arg，timeout 仍是默认 30s。
  await page.waitForFunction(() => window.__sparkPoseDiagCamera != null, undefined, {
    timeout: 120_000,
  });

  async function applyPose(pose) {
    await page.evaluate((p) => {
      const c = window.__sparkPoseDiagCamera;
      if (!c) throw new Error("no __sparkPoseDiagCamera");
      c.position.set(p.position[0], p.position[1], p.position[2]);
      c.quaternion.set(p.quaternion[0], p.quaternion[1], p.quaternion[2], p.quaternion[3]).normalize();
      c.updateMatrixWorld(true);
    }, pose);
  }

  currentPhase = "A";
  await applyPose(poseA);
  const phase_a_camera_after_set = await snapCam().catch(() => null);
  await new Promise((r) => setTimeout(r, phaseMs));

  currentPhase = "B";
  await applyPose(poseB);
  const phase_b_camera_after_set = await snapCam().catch(() => null);
  await new Promise((r) => setTimeout(r, phaseMs));

  await context.close();
  return { pageUrl, rows, phase_a_camera_after_set, phase_b_camera_after_set };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outAbs = path.isAbsolute(opts.outDir) ? opts.outDir : path.join(projectRoot, opts.outDir);
  const summaryDir = path.join(outAbs, "summary");
  await fs.mkdir(summaryDir, { recursive: true });

  const phaseMs = opts.phaseMs;
  const poseA = {
    position: [0, 0, 8],
    quaternion: [0, 0, 0, 1],
  };
  const poseB = {
    position: [14, 4, -10],
    quaternion: [0, 0.3826834323650898, 0, 0.9238795325112867],
  };

  const pathOverrides = new Map();
  const injStream = await writeOverrideHtml("/examples/streaming-lod/index.html", outAbs);
  pathOverrides.set("/examples/streaming-lod/index.html", injStream.outFile);
  const injMulti = await writeOverrideHtml("/examples/multi-lod/index.html", outAbs);
  pathOverrides.set("/examples/multi-lod/index.html", injMulti.outFile);
  const diagnostic_import_map = injStream.diagnostic_import_map;

  const { server, port } = await startStaticServer(projectRoot, opts.port, pathOverrides);
  const baseUrl = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({ headless: true });

  let usedRel = "/examples/streaming-lod/index.html";
  let pageUrl = "";
  let rows = [];
  let phase_a_camera_after_set = null;
  let phase_b_camera_after_set = null;
  let err = null;

  try {
    const r = await runOnePage(browser, baseUrl, usedRel, opts, phaseMs, poseA, poseB);
    pageUrl = r.pageUrl;
    rows = r.rows;
    phase_a_camera_after_set = r.phase_a_camera_after_set;
    phase_b_camera_after_set = r.phase_b_camera_after_set;
  } catch (e) {
    err = e;
    usedRel = "/examples/multi-lod/index.html";
    try {
      const r2 = await runOnePage(browser, baseUrl, usedRel, opts, phaseMs, poseA, poseB);
      pageUrl = r2.pageUrl;
      rows = r2.rows;
      phase_a_camera_after_set = r2.phase_a_camera_after_set;
      phase_b_camera_after_set = r2.phase_b_camera_after_set;
      err = null;
    } catch (e2) {
      err = new Error(`streaming-lod: ${String(e?.message || e)}; multi-lod: ${String(e2?.message || e2)}`);
    }
  }

  await browser.close();
  await new Promise((res) => server.close(res));

  if (err) throw err;

  const filtered = rows.filter(isFilteredRow);
  const normRangeFromRow = (r) =>
    normalizeRange(r.request_headers_range) || normalizeRange(r.response_headers_content_range);

  const rangesA = filtered.filter((r) => r.phase === "A").map(normRangeFromRow).filter(Boolean);
  const rangesB = filtered.filter((r) => r.phase === "B").map(normRangeFromRow).filter(Boolean);
  const urlsA = [...new Set(filtered.filter((r) => r.phase === "A").map((r) => r.url))];
  const urlsB = [...new Set(filtered.filter((r) => r.phase === "B").map((r) => r.url))];

  const setA = new Set(rangesA);
  const setB = new Set(rangesB);
  const intersection_ranges = [...setA].filter((x) => setB.has(x)).sort();
  const ranges_only_in_A = [...setA].filter((x) => !setB.has(x)).sort();
  const ranges_only_in_B = [...setB].filter((x) => !setA.has(x)).sort();
  const range_jaccard = setJaccard(setA, setB);

  const rangesDiffer = ranges_only_in_A.length > 0 || ranges_only_in_B.length > 0;
  const urlsIdentical =
    urlsA.length === urlsB.length && urlsA.every((u) => urlsB.includes(u)) && urlsB.every((u) => urlsA.includes(u));
  const rangeSetsIdentical = setA.size === setB.size && [...setA].every((x) => setB.has(x));

  let verdict_en;
  if (rangesDiffer) {
    verdict_en = "Pose changes are visible at the HTTP Range/page level.";
  } else if (urlsIdentical && rangeSetsIdentical) {
    verdict_en = "Pose changes are not visible as different network object requests in this example.";
  } else {
    verdict_en =
      "Pose changes are not visible as different network object requests in this example." +
      " (URL sets differ slightly while Range sets match; see raw rows.)";
  }

  const whether_pose_changes_network_requests = rangesDiffer;

  const report = {
    generated_at: new Date().toISOString(),
    diagnostic_import_map,
    page_url: pageUrl,
    page_path: usedRel,
    base_url: baseUrl,
    phase_ms_each: phaseMs,
    pose_phase_A: poseA,
    pose_phase_B: poseB,
    phase_a_camera_after_set,
    phase_b_camera_after_set,
    all_request_count: rows.length,
    filtered_request_count: filtered.length,
    phase_A_unique_urls: urlsA.sort(),
    phase_B_unique_urls: urlsB.sort(),
    phase_A_unique_ranges: [...setA].sort(),
    phase_B_unique_ranges: [...setB].sort(),
    intersection_ranges,
    ranges_only_in_A,
    ranges_only_in_B,
    range_jaccard,
    whether_pose_changes_network_requests,
    verdict_en,
    scope_note:
      "This step only assesses whether pose changes correlate with different network-visible URL or Range/Content-Range requests. It does not assess GPU/rendering or CDN cache behavior.",
    all_requests: rows.map((r) => ({
      url: r.url,
      status: r.status,
      ok: r.ok,
      request_headers_range: r.request_headers_range || null,
      response_headers_content_range: r.response_headers_content_range || null,
      response_headers_accept_ranges: r.response_headers_accept_ranges || null,
      response_headers_content_length: r.response_headers_content_length || null,
      response_headers_etag: r.response_headers_etag || null,
      start_ts_ms: r.start_ts_ms,
      response_start_ts_ms: r.response_start_ts_ms ?? null,
      end_ts_ms: r.end_ts_ms ?? null,
      duration_ms: r.duration_ms ?? null,
      phase: r.phase,
      camera_pose: r.camera_pose,
    })),
    filtered_requests: filtered.map((r) => ({
      url: r.url,
      status: r.status,
      ok: r.ok,
      request_headers_range: r.request_headers_range || null,
      response_headers_content_range: r.response_headers_content_range || null,
      response_headers_accept_ranges: r.response_headers_accept_ranges || null,
      response_headers_content_length: r.response_headers_content_length || null,
      response_headers_etag: r.response_headers_etag || null,
      start_ts_ms: r.start_ts_ms,
      response_start_ts_ms: r.response_start_ts_ms ?? null,
      end_ts_ms: r.end_ts_ms ?? null,
      duration_ms: r.duration_ms ?? null,
      phase: r.phase,
      camera_pose: r.camera_pose,
    })),
  };

  const jsonPath = path.join(summaryDir, "streaming_lod_range_by_pose.json");
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const md = [
    "# streaming-lod / multi-lod：位姿 vs HTTP Range 诊断",
    "",
    `- **diagnostic_import_map**（诊断写入的 HTML 将示例 importmap 指到 CDN，便于无本地 \`dist/\`、无 \`examples/js/vendor\` 时仍能加载模块；完整 URL 见 JSON）: \`${JSON.stringify(report.diagnostic_import_map)}\``,
    `- **page_url**: \`${pageUrl}\``,
    `- **phase 时长**: ${phaseMs} ms × 2`,
    `- **pose A（目标）**: \`${JSON.stringify(poseA)}\``,
    `- **pose B（目标）**: \`${JSON.stringify(poseB)}\``,
    `- **phase A 设置后相机（读回）**: \`${JSON.stringify(phase_a_camera_after_set)}\``,
    `- **phase B 设置后相机（读回）**: \`${JSON.stringify(phase_b_camera_after_set)}\``,
    "",
    "## 汇总",
    "",
    `- **filtered_request_count**（.rad/.spz/.splat/.bin 或带 Range/Content-Range）: ${filtered.length}`,
    `- **phase_A_unique_ranges**: \`${JSON.stringify(report.phase_A_unique_ranges)}\``,
    `- **phase_B_unique_ranges**: \`${JSON.stringify(report.phase_B_unique_ranges)}\``,
    `- **intersection_ranges**: \`${JSON.stringify(intersection_ranges)}\``,
    `- **ranges_only_in_A**: \`${JSON.stringify(ranges_only_in_A)}\``,
    `- **ranges_only_in_B**: \`${JSON.stringify(ranges_only_in_B)}\``,
    `- **range_jaccard**: ${range_jaccard == null ? "—" : range_jaccard.toFixed(4)}`,
    `- **whether_pose_changes_network_requests**: **${whether_pose_changes_network_requests}**`,
    "",
    "## 结论（英文）",
    "",
    verdict_en,
    "",
    report.scope_note,
    "",
  ].join("\n");
  await fs.writeFile(path.join(summaryDir, "streaming_lod_range_by_pose.md"), md, "utf8");

  console.log(`Wrote ${jsonPath}`);
  console.log(verdict_en);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
