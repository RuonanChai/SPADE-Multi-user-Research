/**
 * Phase 4: Chrome Performance Trace — main/render/GPU only (NOT primary network latency).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TRACE_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.timeline.stack",
  "blink.user_timing",
].join(",");

function durMs(ev) {
  if (ev.dur != null) return Number(ev.dur) / 1000;
  return 0;
}

function nameOf(ev) {
  return String(ev.name ?? "");
}

function bucketEvent(ev, buckets) {
  const n = nameOf(ev);
  const d = durMs(ev);
  if (d <= 0) return;
  if (/^RunTask$|FunctionCall|EvaluateScript|v8\.|JSFrame/.test(n)) {
    buckets.main_script_ms += d;
    if (d > 50000) buckets.longtask_count += 1;
  } else if (/Layout|UpdateLayoutTree|Paint|PrePaint/.test(n)) {
    buckets.layout_paint_ms += d;
  } else if (/Rasterize|GPUTask|GPU/.test(n)) {
    buckets.gpu_ms += d;
  } else if (/CompositeLayers|DrawFrame|BeginFrame/.test(n)) {
    if (/BeginFrame/.test(n)) buckets.frame_count += 1;
    if (/CompositeLayers|DrawFrame/.test(n)) buckets.composite_ms += d;
  } else if (/Raster/.test(n)) {
    buckets.raster_ms += d;
  } else if (/ResourceSendRequest|ResourceReceiveResponse|ResourceFinish|Loading/.test(n)) {
    buckets.trace_loading_event_ms += d;
  }
}

export function parsePerfTraceFile(tracePath) {
  const raw = JSON.parse(fs.readFileSync(tracePath, "utf8"));
  const events = raw.traceEvents || raw;
  const buckets = {
    main_script_ms: 0,
    layout_paint_ms: 0,
    raster_ms: 0,
    composite_ms: 0,
    gpu_ms: 0,
    trace_loading_event_ms: 0,
    longtask_count: 0,
    frame_count: 0,
  };
  if (!Array.isArray(events)) return { ...buckets, trace_ok: false, trace_error: "no_events" };
  for (const ev of events) {
    if (ev.ph !== "X" && ev.ph !== "b") continue;
    bucketEvent(ev, buckets);
  }
  return { ...buckets, trace_ok: true, trace_error: "" };
}

export class CdpPerfTraceRecorder {
  constructor(cdp, meta) {
    this.cdp = cdp;
    this.meta = meta;
    this.tracePath = "";
  }

  async start() {
    await this.cdp.send("Tracing.start", {
      categories: TRACE_CATEGORIES,
      options: "sampling-based-16ms",
      transferMode: "ReturnAsStream",
    });
  }

  async stop(runDir) {
    const outDir = path.join(runDir, "perf_traces");
    fs.mkdirSync(outDir, { recursive: true });
    this.tracePath = path.join(outDir, `${this.meta.userId}.trace.json`);
    const end = await this.cdp.send("Tracing.end");
    const streamId = end.stream;
    if (!streamId) {
      return { trace_ok: false, trace_error: "no_stream", trace_path: "" };
    }
    const chunks = [];
    let eof = false;
    while (!eof) {
      const chunk = await this.cdp.send("IO.read", { handle: streamId, size: 1_000_000 });
      chunks.push(chunk.data);
      eof = !!chunk.eof;
    }
    try { await this.cdp.send("IO.close", { handle: streamId }); } catch { /* */ }
    const body = chunks.join("");
    fs.writeFileSync(this.tracePath, body, "utf8");
    let summary;
    try {
      summary = parsePerfTraceFile(this.tracePath);
    } catch (e) {
      summary = { trace_ok: false, trace_error: e.message, trace_path: this.tracePath };
    }
    return {
      ...summary,
      trace_path: this.tracePath,
    };
  }
}

export async function attachPerfTraceRecorder(page, meta) {
  const cdp = await page.context().newCDPSession(page);
  const rec = new CdpPerfTraceRecorder(cdp, meta);
  await rec.start();
  return rec;
}
