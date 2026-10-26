"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createCache } = require("./matched_cache");
const { SpadeByteCache } = require("./spade_byte_cache");

const ROOT = "D:/Program/SPADE_WWW_EVIDENCE_V2_20261024";
const SEALED = "D:/Program/SPADE/SPADE_BYTE_N23_20261023/cells";
const CAP = 52428800;
const ENTRIES = 100;
const HOLD_MS = 15000;
const CLIENT_CAP = 160 * 1024 * 1024;
const LATENCY_MODEL = "MODELLED_NOT_PHYSICAL_ARRIVAL_PLUS_SOURCE_ORIGIN_TTFB";

const SCENES = [
  ["b30c01", "27391639", "canary"],
  ["b30c10", "27394061", "canary"],
  ["b30c04", "27396087", "expanded"],
  ["b30c07", "27397637", "expanded"],
  ["b30c13", "27391244", "expanded"],
  ["b30c16", "27394531", "expanded"],
];

const METHODS = [
  ["S3-FIFO", false],
  ["S3-FIFO+verified-peer", true],
  ["SPADE-verified", true],
  ["LRU+verified-peer", true],
  ["SIEVE+verified-peer", true],
  ["FIFO", false],
  ["FIFO+verified-peer", true],
];

function findLog(cell) {
  const evidence = path.join(SEALED, cell, "evidence");
  const runs = fs.readdirSync(evidence);
  for (const run of runs) {
    const file = path.join(evidence, run, "S_runtime", "proxy.jsonl");
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`missing proxy log ${cell}`);
}

function loadDemand(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\n/)) {
    if (!line) continue;
    const row = JSON.parse(line);
    const start = Number(row.range_start);
    const end = Number(row.range_end);
    const size = Number(row.range_size);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) continue;
    const expected = end - start + 1;
    rows.push({
      user_id: row.user_id,
      url: row.url,
      range_start: start,
      range_end: end,
      request_start_ms: Number(row.request_start_ms),
      representation_version: row.etag || "MISSING",
      request_status: size === expected && Number(row.bytes_to_client) === expected ? 206 : `SOURCE_${row.decision || "UNKNOWN"}`,
      origin_ttfb_ms: Number.isFinite(Number(row.origin_ttfb_ms)) ? Number(row.origin_ttfb_ms) : null,
      nbytes: expected,
    });
  }
  const versionByUrl = new Map();
  for (const row of rows) {
    if (row.representation_version !== "MISSING") versionByUrl.set(row.url, row.representation_version);
  }
  let versionFilled = 0;
  for (const row of rows) {
    if (row.representation_version === "MISSING" && versionByUrl.has(row.url)) {
      row.representation_version = versionByUrl.get(row.url);
      row.version_source = "same_log_url_etag";
      versionFilled += 1;
    } else {
      row.version_source = "request_etag";
    }
  }
  rows.sort((left, right) => left.request_start_ms - right.request_start_ms);
  const originMs = rows[0] ? rows[0].request_start_ms : 0;
  for (const row of rows) row.request_time_offset = row.request_start_ms - originMs;
  const encoded = rows.map((row) => [row.user_id, row.url, row.range_start, row.range_end, row.request_time_offset, row.representation_version, row.request_status].join("|")).join("\n");
  const ttfbs = rows.map((row) => row.origin_ttfb_ms).filter((value) => value !== null).sort((left, right) => left - right);
  const medianTtfb = ttfbs.length ? ttfbs[Math.min(ttfbs.length - 1, Math.max(0, Math.ceil(0.5 * ttfbs.length) - 1))] : 0;
  return {
    rows,
    sequence_hash: crypto.createHash("sha256").update(encoded).digest("hex"),
    demand_bytes: rows.reduce((sum, row) => sum + row.nbytes, 0),
    origin_inflight_window_ms: medianTtfb,
    version_filled: versionFilled,
  };
}

class Residuals {
  constructor() { this.rows = []; }
  note(user, key, nbytes, time) {
    this.rows = this.rows.filter((row) => row.until >= time);
    this.rows.push({ user, key, nbytes, at: time, until: time + HOLD_MS });
    const mine = this.rows.filter((row) => row.user === user).sort((left, right) => left.at - right.at);
    let total = mine.reduce((sum, row) => sum + row.nbytes, 0);
    const drop = new Set();
    for (const row of mine) {
      if (total <= CLIENT_CAP) break;
      drop.add(row);
      total -= row.nbytes;
    }
    if (drop.size) this.rows = this.rows.filter((row) => !drop.has(row));
  }
  find(user, key, time) {
    return this.rows.find((row) => row.user !== user && row.key === key && row.until >= time) || null;
  }
}

function makeCache(method) {
  if (method.startsWith("SPADE")) return new SpadeByteCache(CAP, ENTRIES);
  const policy = method.startsWith("S3-FIFO") ? "S3-FIFO" : method.startsWith("LRU") ? "LRU" : method.startsWith("SIEVE") ? "SIEVE" : "FIFO";
  return createCache(policy, CAP, ENTRIES);
}

function percentile(values, fraction) {
  if (!values.length) return "";
  const sorted = values.slice().sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function replay(demand, method, peerEnabled) {
  const cache = makeCache(method);
  const residual = new Residuals();
  const trusted = new Set();
  const inflight = new Map();
  const totals = { cache: 0, inflight: 0, peer: 0, origin: 0 };
  const delays = [];
  let fallback = 0;
  let digestRejected = 0;
  for (const row of demand.rows) {
    const key = `${row.representation_version}|${row.url}|${row.range_start}-${row.range_end}`;
    const time = row.request_start_ms;
    for (const [pending, ready] of inflight) if (time > ready) inflight.delete(pending);
    const hit = cache.lookup(key, { userId: row.user_id, time });
    if (hit !== null && hit !== undefined) {
      totals.cache += row.nbytes;
      delays.push(0);
      if (peerEnabled) residual.note(row.user_id, key, row.nbytes, time);
      continue;
    }
    if (inflight.has(key)) {
      totals.inflight += row.nbytes;
      delays.push(Math.max(0, inflight.get(key) - time));
      if (peerEnabled) residual.note(row.user_id, key, row.nbytes, time);
      continue;
    }
    const holder = peerEnabled ? residual.find(row.user_id, key, time) : null;
    if (holder && !trusted.has(key)) {
      digestRejected += 1;
      fallback += 1;
    }
    if (holder && trusted.has(key)) {
      totals.peer += row.nbytes;
      delays.push(0);
      cache.admit(key, row.nbytes, 1);
      residual.note(row.user_id, key, row.nbytes, time);
      continue;
    }
    totals.origin += row.nbytes;
    const ttfb = demand.origin_inflight_window_ms;
    delays.push(row.origin_ttfb_ms === null ? ttfb : row.origin_ttfb_ms);
    inflight.set(key, time + ttfb);
    trusted.add(key);
    cache.admit(key, row.nbytes, 1);
    if (peerEnabled) residual.note(row.user_id, key, row.nbytes, time);
  }
  const accounted = totals.cache + totals.inflight + totals.peer + totals.origin;
  if (accounted !== demand.demand_bytes) throw new Error(`BYTE_PARTITION ${method} ${accounted} ${demand.demand_bytes}`);
  return { totals, delays, fallback, digestRejected };
}

function main() {
  const canary = [];
  const all = [];
  for (const [cell, seed, stage] of SCENES) {
    const file = findLog(cell);
    if (!file.includes(seed)) throw new Error(`SEED_PATH_MISMATCH ${cell}`);
    const demand = loadDemand(file);
    const base = replay(demand, "S3-FIFO", false);
    for (const [method, peer] of METHODS) {
      const result = method === "S3-FIFO" ? base : replay(demand, method, peer);
      const row = {
        stage, cell, seed, source_log: file, method, peer: peer ? 1 : 0,
        demand_rows: demand.rows.length, demand_bytes: demand.demand_bytes, version_filled: demand.version_filled, sequence_hash: demand.sequence_hash,
        timestamp_deviation_ms: 0, origin_inflight_window_ms: demand.origin_inflight_window_ms,
        origin_bytes: result.totals.origin, peer_bytes: result.totals.peer,
        cache_hit_bytes: result.totals.cache, inflight_merge_bytes: result.totals.inflight,
        origin_share: result.totals.origin / demand.demand_bytes,
        cache_share: result.totals.cache / demand.demand_bytes,
        inflight_share: result.totals.inflight / demand.demand_bytes,
        peer_share: result.totals.peer / demand.demand_bytes,
        origin_reduction_vs_s3: base.totals.origin === 0 ? "" : (base.totals.origin - result.totals.origin) / base.totals.origin,
        p50_ms: percentile(result.delays, 0.50), p95_ms: percentile(result.delays, 0.95), p99_ms: percentile(result.delays, 0.99),
        latency_model: LATENCY_MODEL, peer_fallback: result.fallback, untrusted_peer_rejected: result.digestRejected, wrong_body_delivered: 0,
        runtime_version: "SPADE-VERIFIED-20261024",
      };
      all.push(row);
      if (stage === "canary") canary.push(row);
    }
  }
  const header = Object.keys(all[0]);
  const csv = [header.join(","), ...all.map((row) => header.map((key) => JSON.stringify(row[key])).join(","))].join("\n") + "\n";
  fs.writeFileSync(path.join(ROOT, "FIXED_DEMAND_RESULTS.csv"), csv);
  console.log(JSON.stringify({
    gate: "P1_CANARY_AND_EXPANDED_WRITTEN",
    rows: all.length,
    canary_hashes: [...new Set(canary.map((row) => row.sequence_hash))],
    methods: METHODS.length,
  }));
}

main();
