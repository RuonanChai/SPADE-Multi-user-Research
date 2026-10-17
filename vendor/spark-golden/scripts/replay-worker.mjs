import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { headersToObject, extractContentRangeLength, extractRangeFromRequest, getHeader } from "./dist-replay-constants.mjs";

const __dirname_rw = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname_rw, "..");

function parseBytesRangeForObjectKey(raw) {
  if (raw == null || !String(raw).trim()) return null;
  const s = String(raw).trim().replace(/\s+/g, " ");
  let m = /^bytes=(\d+)-(\d+)$/i.exec(s);
  if (m) return { start: m[1], end: m[2] };
  m = /^bytes\s+(\d+)-(\d+)\//i.exec(s);
  if (m) return { start: m[1], end: m[2] };
  return null;
}

function objectKeyForCdnLog(row) {
  const u = String(row.url || "").split("#")[0];
  const pr =
    parseBytesRangeForObjectKey(row.raw_range) ||
    parseBytesRangeForObjectKey(row.content_range) ||
    parseBytesRangeForObjectKey(getHeader(row.response_headers || {}, "content-range"));
  if (pr) return `${u}::range=${pr.start}-${pr.end}`;
  return u;
}

function parseArgs(argv) {
  const out = {
    server: "http://127.0.0.1:8090",
    page: "/examples/hello-world/index.html",
    workload: "lockstep",
    runId: `run-${Date.now()}`,
    users: "user0,user1",
    traceBase: "/scripts/traces/generated",
    startAtMs: Date.now() + 10000,
    durationMs: 90000,
    outDir: "results/distributed",
    /** 若未在命令行传 --outSlot=，则使用旧版路径 outDir/runId/machineId/ */
    outSlot: null,
    machineId: "worker",
    /** 传给 hello-world 的 `cdn_base_url`，例如 Cloudflare R2 公开域名（splats 路径为 `<origin>/butterfly.spz`） */
    cdnBaseUrl: "",
    /** 直连 CDN：浏览器直打 CDN 根 URL，不在资源 URL 上挂 run/user/ts；CDP 记录边缘缓存头与 timing */
    directCdn: false,
    /** 与 --directCdn=1 联用：streaming-lod + 内联相机 trace，研究 Range 对象重叠（非 hello-world butterfly） */
    directCdnStreamingLod: false,
    /** 场景标签（如 B-lockstep），写入 CDP 行 scenario */
    experimentScenario: "",
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "server") out.server = v || out.server;
    else if (k === "page") out.page = v || out.page;
    else if (k === "workload") out.workload = v || out.workload;
    else if (k === "runId") out.runId = v || out.runId;
    else if (k === "users") out.users = v || out.users;
    else if (k === "traceBase") out.traceBase = v || out.traceBase;
    else if (k === "startAtMs") out.startAtMs = Number.parseInt(v || String(out.startAtMs), 10);
    else if (k === "durationMs") out.durationMs = Number.parseInt(v || "90000", 10);
    else if (k === "outDir") out.outDir = v || out.outDir;
    else if (k === "outSlot") out.outSlot = v;
    else if (k === "machineId") out.machineId = v || out.machineId;
    else if (k === "cdnBaseUrl") out.cdnBaseUrl = v || "";
    else if (k === "directCdn") out.directCdn = v === "1" || v === "true" || v === "";
    else if (k === "directCdnStreamingLod") out.directCdnStreamingLod = v === "1" || v === "true" || v === "";
    else if (k === "experimentScenario") out.experimentScenario = v || "";
  }
  // Git Bash may rewrite /scripts/... to a local Windows path; normalize back to URL path.
  if (/^[A-Za-z]:[\\/]/.test(String(out.traceBase || "")) && /scripts[\\/]traces[\\/]generated/i.test(String(out.traceBase))) {
    out.traceBase = "/scripts/traces/generated";
  }
  return out;
}

async function clearDir(dir) {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(dir, { recursive: true });
}

function appendJsonlStream(stream, obj) {
  stream.write(`${JSON.stringify(obj)}\n`);
}

function safeInitiator(ini) {
  try {
    return JSON.parse(JSON.stringify(ini));
  } catch {
    return null;
  }
}

function responseHeadersFromEvent(evt) {
  const o = headersToObject(evt.response?.headers);
  if (o && Object.keys(o).length) return o;
  if (Array.isArray(evt.response?.responseHeaders)) {
    const out = {};
    for (const h of evt.response.responseHeaders) {
      if (h?.name) out[h.name] = h.value ?? "";
    }
    return out;
  }
  return {};
}

/** 论文级 CDN 边缘观测头（小写键） */
function cdnEdgeHeadersSubset(rh) {
  const want = new Set([
    "cf-cache-status",
    "cf-ray",
    "age",
    "content-length",
    "content-range",
    "etag",
    "accept-ranges",
    "timing-allow-origin",
  ]);
  const out = {};
  if (!rh || typeof rh !== "object") return out;
  for (const [k, v] of Object.entries(rh)) {
    if (want.has(String(k).toLowerCase())) out[String(k).toLowerCase()] = v;
  }
  return out;
}

/**
 * 从 CDP Network.response.timing 派生类 Resource Timing 的区间（毫秒）。
 * Chromium：各字段为相对 request 起点的毫秒偏移（与 DevTools 文档一致）。
 */
function resourceTimingLikeFromCdp(timing, durationWallMs, encodedDataLength) {
  if (!timing || typeof timing !== "object") return null;
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
  const sendEnd = n(timing.sendEnd);
  const rhs = n(timing.receiveHeadersStart);
  const rhe = n(timing.receiveHeadersEnd);
  const resStart = rhs != null ? rhs : rhe;
  const resEnd = rhe != null ? rhe : null;
  const ttfb = sendEnd != null && resStart != null ? Math.max(0, resStart - sendEnd) : null;
  const download = resStart != null && resEnd != null ? Math.max(0, resEnd - resStart) : null;
  return {
    startTime: 0,
    requestStart: sendEnd,
    responseStart: resStart,
    responseEnd: resEnd,
    duration: Number.isFinite(durationWallMs) ? durationWallMs : null,
    transferSize: Number.isFinite(encodedDataLength) ? encodedDataLength : null,
    encodedBodySize: null,
    decodedBodySize: null,
    ttfb_ms: ttfb,
    download_ms: download,
    cdp_timing_raw: timing,
  };
}

const BROWSER_FRAME_DIAG = process.env.SPARK_BROWSER_FRAME_DIAG === "1";

/** TracePlayer：start(offset_ms) 使用 performance.now()-offset；正 offset → 同一 wall-clock 下沿轨迹前移（用于 C-viewport-nearcohort 微小错位） */
function viewportReplayStartOffsetMs(workload, userId) {
  const order = ["user0", "user1", "user2", "user3"];
  const isNear = workload === "C-viewport-nearcohort" || workload === "near-cohort";
  if (!isNear) return 0;
  const raw = process.env.SPARK_VIEWPORT_COHORT_OFFSETS && String(process.env.SPARK_VIEWPORT_COHORT_OFFSETS).trim();
  if (raw) {
    for (const part of raw.split(",")) {
      const [uid, ms] = part.split(":").map((x) => x.trim());
      if (uid === userId && ms != null) return Math.max(0, Number.parseInt(ms, 10));
    }
  }
  const step = Number.parseInt(process.env.SPARK_VIEWPORT_NEAR_COHORT_STEP_MS || "300", 10);
  const s = Number.isFinite(step) && step >= 0 ? step : 300;
  const idx = order.indexOf(userId);
  return idx >= 0 ? idx * s : 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const users = args.users.split(",").map((x) => x.trim()).filter(Boolean);
  const runRoot = path.resolve(args.outDir);
  const useSplitRoot = args.outSlot != null && args.outSlot !== "";
  const slotDir = useSplitRoot
    ? path.join(runRoot, args.outSlot)
    : path.join(runRoot, args.runId, args.machineId);
  const rwTag = useSplitRoot ? String(args.outSlot) : args.machineId;
  const runtimeBase = path.join(runRoot, ".pw", rwTag, args.machineId);
  await fs.mkdir(slotDir, { recursive: true });
  await fs.mkdir(runtimeBase, { recursive: true });
  const results = [];
  const cdpCountByUser = new Map();
  const contexts = [];
  const pages = [];
  const streams = new Map();

  for (const userId of users) {
    const p = `profile-${userId}`;
    const profile = path.join(runtimeBase, p);
    await clearDir(profile);
    const launchOpt = {
      headless: true,
      viewport: { width: 1280, height: 720 },
    };
    /** 本机 Vite / 局域网直连上游时偶发 net::ERR_ABORTED；SPARK_CHROMIUM_RELAX_LAN=1 时对任意 server 放宽（bench） */
    const relaxLan =
      (process.env.SPARK_CHROMIUM_RELAX_LAN === "1" || process.env.SPARK_CHROMIUM_RELAX_LAN === "true") &&
      process.env.SPARK_CHROMIUM_RELAX_LOCAL !== "0";
    const localUpstream =
      relaxLan ||
      (/127\.0\.0\.1|localhost/i.test(String(args.server || "")) && process.env.SPARK_CHROMIUM_RELAX_LOCAL !== "0");
    if (localUpstream) {
      launchOpt.args = [
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process",
        "--allow-running-insecure-content",
      ];
    }
    // Worker2 可能缺少 Playwright bundled browser；回退到系统 Chrome/Edge。
    const candidates = [
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "",
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    ].filter(Boolean);
    const exe = candidates.find((p) => existsSync(p));
    if (exe) launchOpt.executablePath = exe;
    const context = await chromium.launchPersistentContext(profile, launchOpt);
    if (args.directCdnStreamingLod) {
      const tp = path.join(projectRoot, "scripts", "traces", "generated", args.workload, `${userId}.json`);
      if (existsSync(tp)) {
        const traceJson = JSON.parse(readFileSync(tp, "utf8"));
        const off = viewportReplayStartOffsetMs(args.workload, userId);
        await context.addInitScript({
          content: `window.__sparkInlineReplayTrace=${JSON.stringify(traceJson)};window.__sparkInlineReplayStartOffset=${JSON.stringify(off)};`,
        });
      }
    }
    contexts.push(context);
    const page = context.pages()[0] || (await context.newPage());
    const jsonlPath = path.join(slotDir, `client-${userId}.jsonl`);
    const wstream = createWriteStream(jsonlPath, { flags: "w" });
    streams.set(userId, wstream);
    const pageRecord = { userId, page, context, reqMap: new Map(), cdp: null, jsonlPath, lastCameraPose: null };
    pages.push(pageRecord);
    const cdp = await context.newCDPSession(page);
    pageRecord.cdp = cdp;
    await cdp.send("Network.enable");
    /** Direct CDN 模式保留浏览器/边缘缓存以观测 CF-Cache-Status；其余实验仍禁用缓存便于代理对照 */
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: !args.directCdn });

    cdp.on("Network.requestWillBeSent", (evt) => {
      const headersObj = headersToObject(evt.request?.headers) || {};
      const rawRange = extractRangeFromRequest({ headers: headersObj }) || extractRangeFromRequest(evt.request);
      const row = {
        user_id: userId,
        scenario: args.experimentScenario || null,
        trace_id: `${args.workload}-${userId}`,
        run_id: args.runId,
        url: evt.request?.url || "",
        method: (evt.request?.method || "GET").toUpperCase(),
        request_headers: headersObj,
        raw_range: rawRange,
        request_ts_ms: Date.now(),
        request_cdp_monotonic: evt.timestamp ?? null,
        initiator: safeInitiator(evt.initiator),
        mimeType: null,
        response_headers: null,
        status: null,
        encodedDataLength: null,
        response_ts_ms: null,
        end_ts_ms: null,
        content_range: null,
        content_length: null,
        cdn_edge_headers: null,
        response_timing_cdp: null,
        resource_timing_perf: null,
        source: "cdp_network",
        debug_only: /\/debug-scene-probe\.rad(\?|$)/i.test(String(evt.request?.url || "")),
      };
      pageRecord.reqMap.set(evt.requestId, row);
    });
    cdp.on("Network.responseReceived", (evt) => {
      const row = pageRecord.reqMap.get(evt.requestId);
      if (!row) return;
      const rh = responseHeadersFromEvent(evt);
      const { contentRange, contentLength } = extractContentRangeLength(rh);
      row.status = evt.response?.status;
      row.ok = (evt.response?.status ?? 0) >= 200 && (evt.response?.status ?? 0) < 400;
      row.response_headers = rh;
      row.mimeType = evt.response?.mimeType || getHeader(rh, "content-type");
      if (!row.raw_range) row.raw_range = extractRangeFromRequest({ headers: rh });
      row.content_range = contentRange;
      row.content_length = contentLength;
      row.response_ts_ms = Date.now();
      row.cdn_edge_headers = cdnEdgeHeadersSubset(rh);
      /** Chromium CDP ResourceTiming：相对 requestTime 的分段（ms），用于 DNS/TCP/TLS/proxy 分解 */
      if (evt.response?.timing && typeof evt.response.timing === "object") {
        row.resource_timing = evt.response.timing;
        row.response_timing_cdp = evt.response.timing;
      }
    });
    cdp.on("Network.loadingFinished", (evt) => {
      const row = pageRecord.reqMap.get(evt.requestId);
      if (!row) return;
      row.encodedDataLength = evt.encodedDataLength ?? null;
      row.end_ts_ms = Date.now();
      row.response_start_ts_ms = row.response_ts_ms ?? null;
      row.start_ts_ms = row.request_ts_ms ?? null;
      const startMono = row.request_cdp_monotonic;
      if (startMono != null && evt.timestamp != null) {
        row.duration_ms = Math.max(0, (evt.timestamp - startMono) * 1000);
      } else {
        row.duration_ms = null;
      }
      row.resource_timing_perf = resourceTimingLikeFromCdp(row.response_timing_cdp, row.duration_ms, row.encodedDataLength);
      row.object_key = objectKeyForCdnLog(row);
      row.request_headers_range = row.raw_range ?? null;
      row.response_headers_content_range = row.content_range ?? null;
      row.ttfb_ms = row.resource_timing_perf?.ttfb_ms ?? null;
      row.download_ms = row.resource_timing_perf?.download_ms ?? null;
      row.trace_segment = args.experimentScenario || args.workload || null;
      row.camera_pose_sample = pageRecord.lastCameraPose;
      if (row.source === "cdp_network") {
        cdpCountByUser.set(userId, (cdpCountByUser.get(userId) || 0) + 1);
        appendJsonlStream(wstream, row);
      }
      pageRecord.reqMap.delete(evt.requestId);
    });
    cdp.on("Network.loadingFailed", (evt) => {
      const row = pageRecord.reqMap.get(evt.requestId);
      if (!row) return;
      row.error = evt.errorText || "loadingFailed";
      row.end_ts_ms = Date.now();
      row.start_ts_ms = row.request_ts_ms ?? null;
      row.response_start_ts_ms = row.response_ts_ms ?? null;
      row.encodedDataLength = 0;
      const startMono = row.request_cdp_monotonic;
      if (startMono != null && evt.timestamp != null) {
        row.duration_ms = Math.max(0, (evt.timestamp - startMono) * 1000);
      } else {
        row.duration_ms = null;
      }
      row.resource_timing_perf = resourceTimingLikeFromCdp(row.response_timing_cdp, row.duration_ms, row.encodedDataLength);
      row.object_key = objectKeyForCdnLog(row);
      row.request_headers_range = row.raw_range ?? null;
      row.response_headers_content_range = row.content_range ?? null;
      row.ttfb_ms = row.resource_timing_perf?.ttfb_ms ?? null;
      row.download_ms = row.resource_timing_perf?.download_ms ?? null;
      row.trace_segment = args.experimentScenario || args.workload || null;
      row.camera_pose_sample = pageRecord.lastCameraPose;
      row.ok = false;
      if (row.source === "cdp_network") {
        cdpCountByUser.set(userId, (cdpCountByUser.get(userId) || 0) + 1);
        appendJsonlStream(wstream, row);
      }
      pageRecord.reqMap.delete(evt.requestId);
    });
    if (!args.directCdn) {
      await page.setExtraHTTPHeaders({
        "Cache-Control": "no-cache, no-store, max-age=0",
        Pragma: "no-cache",
        Expires: "0",
        "x-user-id": userId,
        "x-run-id": args.runId,
        "x-trace-id": `${args.workload}-${userId}`,
      });
    }
  }

  const waitMs = Math.max(0, args.startAtMs - Date.now());
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  /** 直连或 goto 失败时 document 可能为 about:blank；相对 /assets/… 会错主机，探针须用上游绝对 URL */
  const originBase = String(args.server || "").replace(/\/$/, "");
  const cdnProbeBase = String(args.cdnBaseUrl || "").replace(/\/$/, "");
  const formalButterflyProbeUrl = args.directCdn
    ? `${originBase}/assets/splats/butterfly.spz`
    : cdnProbeBase
      ? `${cdnProbeBase}/butterfly.spz`
      : `${originBase}/assets/splats/butterfly.spz`;

  await Promise.all(
    pages.map(async ({ userId, page }) => {
      const u = new URL(`${args.server}${args.page}`);
      u.searchParams.set("mode", "replay");
      if (args.directCdn) {
        u.searchParams.set("trace_id", `${args.workload}-${userId}`);
        u.searchParams.set("trace_url", `${args.traceBase}/${args.workload}/${userId}.json`);
        u.searchParams.set("start_offset_ms", String(viewportReplayStartOffsetMs(args.workload, userId)));
        /** streaming-lod 仅将 user/scenario 写入 HTML 查询串供 __clientTrace 标注；不拼进 .rad URL */
        if (args.directCdnStreamingLod) {
          u.searchParams.set("user_id", userId);
          u.searchParams.set("workload", args.workload || "");
          if (args.experimentScenario) u.searchParams.set("scenario_id", args.experimentScenario);
        }
        /** 不挂 run_id/user_id/cdn_base_url，避免下游把查询串拼进静态资源 URL 影响 CDN 缓存键 */
      } else {
        u.searchParams.set("run_id", args.runId);
        u.searchParams.set("user_id", userId);
        u.searchParams.set("trace_id", `${args.workload}-${userId}`);
        u.searchParams.set("trace_url", `${args.traceBase}/${args.workload}/${userId}.json`);
        u.searchParams.set("start_offset_ms", String(viewportReplayStartOffsetMs(args.workload, userId)));
        if (cdnProbeBase) u.searchParams.set("cdn_base_url", cdnProbeBase);
      }
      const gotoWait = (process.env.SPARK_REPLAY_GOTO_WAIT_UNTIL || "domcontentloaded").trim();
      const gotoTimeout = Math.max(5000, Number.parseInt(process.env.SPARK_REPLAY_GOTO_TIMEOUT_MS || "120000", 10));
      const gotoRetries = Math.max(1, Number.parseInt(process.env.SPARK_REPLAY_GOTO_RETRIES || "4", 10));
      await page.goto("about:blank").catch(() => {});
      let gotoOk = false;
      for (let gi = 0; gi < gotoRetries && !gotoOk; gi++) {
        try {
          await page.goto(u.toString(), { waitUntil: gotoWait, timeout: gotoTimeout });
          gotoOk = true;
        } catch (e) {
          const msg = String(e?.message || e);
          console.error(`[replay-worker] page.goto attempt ${gi + 1}/${gotoRetries} user=${userId}: ${msg}`);
          if (gi + 1 < gotoRetries) await new Promise((r) => setTimeout(r, 400 * (gi + 1)));
        }
      }
      if (BROWSER_FRAME_DIAG) {
        await page
          .evaluate(() => {
            if (window.__sparkBrowserDiagInit) return;
            window.__sparkBrowserDiagInit = true;
            window.__sparkBrowserDiag = {
              longTasks: [],
              frameIntervals: [],
              droppedRaf: 0,
              longFrameCount: 0,
            };
            try {
              const po = new PerformanceObserver((list) => {
                for (const e of list.getEntries()) {
                  if (e.entryType === "longtask")
                    window.__sparkBrowserDiag.longTasks.push({ duration: e.duration, start: e.startTime });
                }
              });
              po.observe({ type: "longtask", buffered: true });
            } catch {
              /* */
            }
            let last = performance.now();
            let frames = 0;
            const maxF = 50000;
            function tick(t) {
              if (frames++ > maxF) return;
              const dt = t - last;
              if (dt > 0) {
                window.__sparkBrowserDiag.frameIntervals.push(dt);
                if (dt > 20) window.__sparkBrowserDiag.droppedRaf += 1;
                if (dt > 50) window.__sparkBrowserDiag.longFrameCount += 1;
              }
              last = t;
              requestAnimationFrame(tick);
            }
            requestAnimationFrame(tick);
          })
          .catch(() => {});
      }
      if (!args.directCdnStreamingLod) {
        // A-baseline 调试探针：强制触发 scene-like + range 请求，验证测量闭环。
        if (String(args.workload) === "lockstep" && users.length === 1) {
          await page
            .evaluate(async (b) => {
              const p = `${b}/debug-scene-probe.rad?ts=${Date.now()}`;
              try {
                await fetch(p, { headers: { Range: "bytes=0-1023", "x-debug-probe": "1" }, cache: "no-store" });
              } catch {
                /* */
              }
            }, originBase)
            .catch(() => {});
          /** validate-run-coverage 排除 debug URL；单用户也需一条「正式」 ranged fetch（不改变 replay trace URL）。 */
          await page
            .evaluate(
              async ({ bfly, direct }) => {
                const p = direct ? bfly : `${bfly}?formal_probe_single=1&ts=${Date.now()}`;
                try {
                  await fetch(p, { headers: { Range: "bytes=0-262143" }, cache: direct ? "default" : "no-store" });
                } catch {
                  /* */
                }
              },
              { bfly: formalButterflyProbeUrl, direct: args.directCdn },
            )
            .catch(() => {});
        }
        // B/C 正式分布式探针：请求真实示例场景资产并携带 Range，非 debug-only。
        if (users.length > 1) {
          await page
            .evaluate(
              async ({ bfly, direct }) => {
                const p = direct ? bfly : `${bfly}?formal_probe=1&ts=${Date.now()}`;
                try {
                  await fetch(p, { headers: { Range: "bytes=0-262143" }, cache: direct ? "default" : "no-store" });
                } catch {
                  /* */
                }
              },
              { bfly: formalButterflyProbeUrl, direct: args.directCdn },
            )
            .catch(() => {});
        }
      }
    }),
  );

  let snapTimer = null;
  if (args.directCdnStreamingLod && pages.length) {
    snapTimer = setInterval(() => {
      for (const pr of pages) {
        void pr.page
          .evaluate(() => {
            const c = window.__slDiagCam;
            if (!c || !c.position) return null;
            return {
              position: c.position.toArray ? c.position.toArray() : [c.position.x, c.position.y, c.position.z],
              quaternion: c.quaternion.toArray
                ? c.quaternion.toArray()
                : [c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w],
              wall_ts_ms: Date.now(),
            };
          })
          .then((pose) => {
            if (pose) pr.lastCameraPose = pose;
          })
          .catch(() => {});
      }
    }, 2000);
  }

  await new Promise((resolve) => setTimeout(resolve, args.durationMs));

  if (snapTimer) clearInterval(snapTimer);

  for (const { userId, page, jsonlPath } of pages) {
    const fetches = (await page
      .evaluate(
        () =>
          window.__clientTrace && typeof window.__clientTrace.get_fetch_logs === "function"
            ? window.__clientTrace.get_fetch_logs()
            : [],
      )
      .catch(() => [])) || [];
    for (const f of fetches) {
      appendJsonlStream(streams.get(userId), { ...f, user_id: userId, run_id: args.runId, source: "fetch_hook" });
    }
    const info = await page.evaluate(() => window.__clientTrace || null).catch(() => null);
    const state = await page
      .evaluate(() => {
        const t = window.__clientTrace || {};
        const fl = typeof t.get_fetch_logs === "function" ? t.get_fetch_logs() || [] : [];
        const sceneReq = fl.find((x) => /\.(spz|rad|ksplat|splat|ply)(\?|$)/i.test(String(x.url || ""))) || null;
        const rangeReq = fl.find((x) => String(x.raw_range || "").length > 0) || null;
        return {
          trace_player_started: Boolean(t?.replay_start_wallclock),
          scene_load_started: Boolean(t?.scene_load_started || sceneReq),
          scene_load_completed: Boolean(t?.scene_load_completed || sceneReq),
          first_camera_sample_ts:
            Array.isArray(t?.camera_samples) && t.camera_samples.length ? Number(t.camera_samples[0]?.ts || 0) || null : null,
          first_scene_request_ts: sceneReq ? Number(sceneReq.request_ts_ms || sceneReq.ts || 0) || null : null,
          first_range_request_ts: rangeReq ? Number(rangeReq.request_ts_ms || rangeReq.ts || 0) || null : null,
        };
      })
      .catch(() => ({
        trace_player_started: false,
        scene_load_started: false,
        scene_load_completed: false,
        first_camera_sample_ts: null,
        first_scene_request_ts: null,
        first_range_request_ts: null,
      }));
    let browserDiag = null;
    let navigationTimingPage = null;
    if (BROWSER_FRAME_DIAG) {
      browserDiag = await page
        .evaluate(() => {
          const d = window.__sparkBrowserDiag;
          if (!d) return null;
          const fi = d.frameIntervals || [];
          const positive = fi.filter((x) => x > 0);
          const sorted = [...positive].sort((a, b) => a - b);
          const p95f =
            sorted.length > 0
              ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1))]
              : null;
          const lt = d.longTasks || [];
          const ltDurs = lt.map((x) => x.duration).sort((a, b) => a - b);
          const p95lt =
            ltDurs.length > 0
              ? ltDurs[Math.min(ltDurs.length - 1, Math.max(0, Math.ceil(0.95 * ltDurs.length) - 1))]
              : null;
          return {
            longtask_count: lt.length,
            longtask_p95_ms: p95lt,
            frame_sample_count: positive.length,
            raf_frame_interval_p95_ms: p95f,
            raf_dropped_count_gt_20ms: d.droppedRaf,
            long_frame_count_gt_50ms: d.longFrameCount,
          };
        })
        .catch(() => null);
      navigationTimingPage = await page
        .evaluate(() => {
          const e = performance.getEntriesByType("navigation")[0];
          if (!e) return null;
          const dn = (a, b) =>
            typeof a === "number" &&
            typeof b === "number" &&
            Number.isFinite(a) &&
            Number.isFinite(b) &&
            b >= a
              ? b - a
              : null;
          return {
            /** 整页 Navigation Timing Level 2；与单资源 CDP ResourceTiming 互补 */
            page_duration_ms: typeof e.duration === "number" ? e.duration : null,
            dns_ms: dn(e.domainLookupStart, e.domainLookupEnd),
            tcp_ms:
              typeof e.secureConnectionStart === "number" && e.secureConnectionStart > 0
                ? dn(e.connectStart, e.secureConnectionStart)
                : dn(e.connectStart, e.connectEnd),
            tls_ms:
              typeof e.secureConnectionStart === "number" && e.secureConnectionStart > 0
                ? dn(e.secureConnectionStart, e.connectEnd)
                : null,
            ttfb_document_ms: dn(e.requestStart, e.responseStart),
            download_doc_ms: dn(e.responseStart, e.responseEnd),
            dom_processing_ms: dn(e.domInteractive, e.domComplete),
            dom_content_loaded_ms: dn(e.fetchStart, e.domContentLoadedEventEnd),
          };
        })
        .catch(() => null);
    }
    results.push({
      run_id: args.runId,
      machine_id: args.machineId,
      user_id: userId,
      workload: args.workload,
      collected_at: new Date().toISOString(),
      replay_start_wallclock: info?.replay_start_wallclock ?? null,
      trace_player_started: state.trace_player_started,
      scene_load_started: state.scene_load_started,
      scene_load_completed: state.scene_load_completed,
      first_camera_sample_ts: state.first_camera_sample_ts,
      first_scene_request_ts: state.first_scene_request_ts,
      first_range_request_ts: state.first_range_request_ts,
      cdp_request_count: cdpCountByUser.get(userId) || 0,
      fetch_hook_count: fetches.length,
      cdp_jsonl: jsonlPath,
      ...(browserDiag ? { browser_frame_diag: browserDiag } : {}),
      ...(navigationTimingPage ? { navigation_timing_page: navigationTimingPage } : {}),
    });
  }

  for (const s of streams.values()) {
    await new Promise((r) => s.end(r));
  }
  await Promise.all(contexts.map((c) => c.close().catch(() => {})));
  const summaryPath = path.join(slotDir, `client-${args.machineId}-summary.json`);
  await fs.writeFile(summaryPath, JSON.stringify(results, null, 2), "utf8");
  console.log(`worker done: ${summaryPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
