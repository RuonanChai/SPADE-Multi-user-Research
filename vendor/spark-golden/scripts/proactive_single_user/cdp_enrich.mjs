/**
 * Merge CDP + browser probe; unified B0 reference demand; parse-aligned ready.
 */
import fs from "node:fs/promises";
import path from "node:path";

function parseCsvLine(line, headers) {
  const cols = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === "," && !inQ) {
      cols.push(cur);
      cur = "";
    } else cur += c;
  }
  cols.push(cur);
  const row = {};
  headers.forEach((h, i) => {
    row[h] = cols[i] ?? "";
  });
  return row;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).filter(Boolean).map((line) => parseCsvLine(line, headers));
}

export async function loadCdpRows(runDir) {
  const p = path.join(runDir, "cdp_network_audit.csv");
  try {
    return parseCsv(await fs.readFile(p, "utf8"));
  } catch {
    return [];
  }
}

export function rangeKey(chunkId) {
  if (!chunkId) return "";
  const m = String(chunkId).match(/bytes=\d+-\d+/);
  if (m) return m[0];
  if (String(chunkId).startsWith("bytes=")) return chunkId;
  return "";
}

function browserByRange(proactiveSnap) {
  const m = new Map();
  for (const ch of proactiveSnap.chunk_states || []) {
    const rk = rangeKey(ch.chunk_id) || rangeKey(ch.range_header);
    if (rk) {
      const prev = m.get(rk);
      if (!prev || (ch.chunk_parse_complete_time ?? 0) > (prev.chunk_parse_complete_time ?? 0)) {
        m.set(rk, ch);
      }
    }
  }
  return m;
}

function readyTimeForChunk(ch, parseFallbackMs = 0) {
  if (ch.chunk_upload_complete_time != null) return ch.chunk_upload_complete_time;
  if (ch.chunk_parse_complete_time != null) return ch.chunk_parse_complete_time;
  if (ch.chunk_ready_time != null) return ch.chunk_ready_time;
  if (ch.chunk_fetch_complete_time != null && parseFallbackMs > 0) {
    return ch.chunk_fetch_complete_time + parseFallbackMs;
  }
  return null;
}

export function enrichProactiveFromCdp(proactiveSnap, cdpRows, opts = {}) {
  const { referenceDemand = null, assetUrlHint = "", parseFallbackMs = 0 } = opts;
  const rad = cdpRows.filter(
    (r) =>
      /\.rad(\?|#|$)/i.test(r.url || "")
      && (r.range_header || "").startsWith("bytes=")
      && Number(r.status) === 206,
  );
  if (!rad.length) return proactiveSnap;

  const refByRange = new Map();
  if (referenceDemand?.length) {
    for (const d of referenceDemand) {
      const rk = rangeKey(d.range_header || d.chunk_id);
      if (rk && d.chunk_needed_time != null) refByRange.set(rk, d.chunk_needed_time);
    }
  }

  const t0 = Math.min(...rad.map((r) => Number(r.requestWillBeSent)).filter(Number.isFinite));
  const browser = browserByRange(proactiveSnap);
  const demandByRange = new Map();

  for (const r of rad.sort((a, b) => Number(a.requestWillBeSent) - Number(b.requestWillBeSent))) {
    const rk = r.range_header;
    const url = r.url || assetUrlHint;
    const cid = `${url}::${rk}`;
    if (demandByRange.has(rk)) continue;
    const neededMs = refByRange.has(rk)
      ? refByRange.get(rk)
      : Number(r.requestWillBeSent) - t0;
    demandByRange.set(rk, {
      chunk_id: cid,
      chunk_needed_time: neededMs,
      url,
      range_header: rk,
      source: refByRange.has(rk) ? "b0_reference_demand" : "trial_first_request",
      encoded_bytes: Number(r.encodedDataLength) || 0,
    });
  }

  const demand_trace = [...demandByRange.values()];
  const chunk_states = new Map();

  for (const d of demand_trace) {
    const rk = rangeKey(d.range_header);
    const br = browser.get(rk) || {};
    const netMs = rad
      .filter((r) => r.range_header === rk)
      .map((r) => Number(r.loadingFinished) - t0)
      .find(Number.isFinite);
    chunk_states.set(rk, {
      chunk_id: d.chunk_id,
      chunk_needed_time: d.chunk_needed_time,
      chunk_prefetch_start_time: br.chunk_prefetch_start_time ?? null,
      chunk_fetch_complete_time: br.chunk_fetch_complete_time ?? netMs ?? null,
      chunk_parse_complete_time: br.chunk_parse_complete_time ?? null,
      chunk_upload_complete_time: br.chunk_upload_complete_time ?? null,
      chunk_ready_time: null,
      bytes: br.bytes || d.encoded_bytes || 0,
      source: d.source,
    });
  }

  for (const [rk, ch] of chunk_states) {
    const br = browser.get(rk);
    let ready = readyTimeForChunk({ ...ch, ...br }, parseFallbackMs);
    if (
      ready != null
      && ch.chunk_fetch_complete_time != null
      && ready < ch.chunk_fetch_complete_time
    ) {
      ready = ch.chunk_fetch_complete_time + parseFallbackMs * 0.5;
    }
    ch.chunk_ready_time = ready;
    if (ch.chunk_parse_complete_time == null && br?.chunk_parse_complete_time != null) {
      ch.chunk_parse_complete_time = br.chunk_parse_complete_time;
    }
  }

  const chunks = [...chunk_states.values()];
  const demandSet = new Set(demand_trace.map((d) => rangeKey(d.range_header)));
  let useful_before = 0;
  let miss50 = 0;
  let miss100 = 0;
  let wasted_bytes = 0;
  let total_received = 0;
  let useful_bytes = 0;
  let on_time_bytes = 0;

  for (const ch of chunks) {
    if (ch.bytes > 0) total_received += ch.bytes;
    const needed = ch.chunk_needed_time;
    const ready = ch.chunk_ready_time;
    const rk = rangeKey(ch.chunk_id);
    if (needed != null && ready != null && demandSet.has(rk)) {
      if (ready <= needed) {
        useful_before += 1;
        if (ch.bytes > 0) on_time_bytes += ch.bytes;
      }
      if (ready > needed + 50) miss50 += 1;
      if (ready > needed + 100) miss100 += 1;
      if (ch.bytes > 0) useful_bytes += ch.bytes;
    }
  }

  for (const [rk, br] of browser) {
    if (
      br.chunk_prefetch_start_time != null
      && !demandSet.has(rk)
      && (br.bytes > 0 || br.chunk_fetch_complete_time != null)
    ) {
      wasted_bytes += br.bytes || 0;
    }
  }

  const demanded = demand_trace.length;
  return {
    ...proactiveSnap,
    demand_trace,
    chunk_states: chunks,
    demanded_chunks: demanded,
    useful_chunks_before_demand: useful_before,
    deadline_miss_ratio_50ms: demanded ? miss50 / demanded : 0,
    deadline_miss_ratio_100ms: demanded ? miss100 / demanded : 0,
    wasted_prefetch_bytes: wasted_bytes,
    total_received_bytes: total_received,
    useful_bytes_ratio: total_received > 0 ? on_time_bytes / total_received : 0,
    normalized_useful_content_score: demanded ? useful_before / demanded : 0,
    cdp_enriched: true,
    used_b0_reference_demand: refByRange.size > 0,
    metrics_version: 2,
  };
}

export function cdpRad206Count(cdpRows) {
  return cdpRows.filter(
    (r) => /\.rad(\?|#|$)/i.test(r.url || "") && Number(r.status) === 206 && r.range_header,
  ).length;
}
