"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createCache } = require("../runtime/matched_cache");

const ROOT = "D:/Program/SPADE_WWW_EVIDENCE_V2_20261024";
const OUT = path.join(ROOT, "P2_CACHE_EQUAL");
const SEALED = "D:/Program/SPADE/SPADE_BYTE_N23_20261023/cells";
const CAP_50 = 52428800;
const CLIENT_CAP = 160 * 1024 * 1024;
const CAP_530 = CAP_50 + 3 * CLIENT_CAP;
const ENTRIES_50 = 100;
const HOLD_MS = 15000;
const CLOSE_REL = 0.05;

const SCENES = [
  ["b30c01", "27391639", "coit", "staggered"],
  ["b30c04", "27396087", "coit", "staggered"],
  ["b30c07", "27397637", "coit", "staggered"],
  ["b30c10", "27394061", "poland", "synchronized"],
  ["b30c13", "27391244", "poland", "synchronized"],
  ["b30c16", "27394531", "poland", "synchronized"],
];

function findLog(cell) {
  const evidence = path.join(SEALED, cell, "evidence");
  for (const run of fs.readdirSync(evidence)) {
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
  for (const row of rows) if (row.representation_version !== "MISSING") versionByUrl.set(row.url, row.representation_version);
  let versionFilled = 0;
  for (const row of rows) {
    if (row.representation_version === "MISSING" && versionByUrl.has(row.url)) {
      row.representation_version = versionByUrl.get(row.url);
      versionFilled += 1;
    }
  }
  rows.sort((left, right) => left.request_start_ms - right.request_start_ms);
  const originMs = rows[0] ? rows[0].request_start_ms : 0;
  for (const row of rows) row.request_time_offset = row.request_start_ms - originMs;
  const encoded = rows.map((row) => [row.user_id, row.url, row.range_start, row.range_end, row.request_time_offset, row.representation_version, row.request_status].join("|")).join("\n");
  const users = [...new Set(rows.map((row) => row.user_id))];
  const sizes = new Map();
  for (const row of rows) sizes.set(`${row.representation_version}|${row.url}|${row.range_start}-${row.range_end}`, row.nbytes);
  const uniqueBytes = [...sizes.values()].reduce((sum, value) => sum + value, 0);
  const sortedSizes = [...sizes.values()].sort((left, right) => left - right);
  const ttfbs = rows.map((row) => row.origin_ttfb_ms).filter((value) => value !== null).sort((left, right) => left - right);
  const medianTtfb = ttfbs.length ? ttfbs[Math.min(ttfbs.length - 1, Math.max(0, Math.ceil(0.5 * ttfbs.length) - 1))] : 0;
  return {
    rows,
    users,
    origin_inflight_window_ms: medianTtfb,
    sequence_hash: crypto.createHash("sha256").update(encoded).digest("hex"),
    demand_bytes: rows.reduce((sum, row) => sum + row.nbytes, 0),
    version_filled: versionFilled,
    distinct_keys: sizes.size,
    unique_bytes: uniqueBytes,
    min_object: sortedSizes[0] || 0,
    median_object: sortedSizes[Math.floor((sortedSizes.length - 1) / 2)] || 0,
  };
}

class Residuals {
  constructor() { this.rows = []; this.peak = new Map(); }
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
    const kept = this.rows.filter((row) => row.user === user).reduce((sum, row) => sum + row.nbytes, 0);
    this.peak.set(user, Math.max(this.peak.get(user) || 0, kept));
  }
  find(user, key, time) {
    return this.rows.find((row) => row.user !== user && row.key === key && row.until >= time) || null;
  }
}

function replay(demand, cap, entries, peerEnabled) {
  const cache = createCache("S3-FIFO", cap, entries);
  const residual = new Residuals();
  const trusted = new Set();
  const inflight = new Map();
  const totals = { cache: 0, inflight: 0, peer: 0, origin: 0, cache_objects: 0, peer_objects: 0, origin_objects: 0, inflight_objects: 0, evictions: 0 };
  const peak = { objects: 0, bytes: 0, entry_bound_ends: 0, admits: 0 };
  const inner = cache.admit.bind(cache);
  cache.admit = (key, nbytes, data) => {
    const evicted = inner(key, nbytes, data) || [];
    totals.evictions += evicted.length;
    peak.admits += 1;
    const resident = cache.small.size + cache.main.size;
    if (resident > peak.objects) peak.objects = resident;
    if (cache.nbytes > peak.bytes) peak.bytes = cache.nbytes;
    if (resident >= entries && cache.nbytes < cap) peak.entry_bound_ends += 1;
    return evicted;
  };
  const touch = () => {
    const resident = cache.small.size + cache.main.size;
    if (resident > peak.objects) peak.objects = resident;
    if (cache.nbytes > peak.bytes) peak.bytes = cache.nbytes;
  };
  for (const row of demand.rows) {
    const key = `${row.representation_version}|${row.url}|${row.range_start}-${row.range_end}`;
    const time = row.request_start_ms;
    for (const [pending, ready] of inflight) if (time > ready) inflight.delete(pending);
    const hit = cache.lookup(key);
    touch();
    if (hit !== null && hit !== undefined) {
      totals.cache += row.nbytes;
      totals.cache_objects += 1;
      if (peerEnabled) residual.note(row.user_id, key, row.nbytes, time);
      continue;
    }
    if (inflight.has(key)) {
      totals.inflight += row.nbytes;
      totals.inflight_objects += 1;
      if (peerEnabled) residual.note(row.user_id, key, row.nbytes, time);
      continue;
    }
    const holder = peerEnabled ? residual.find(row.user_id, key, time) : null;
    if (holder && trusted.has(key)) {
      totals.peer += row.nbytes;
      totals.peer_objects += 1;
      cache.admit(key, row.nbytes, 1);
      residual.note(row.user_id, key, row.nbytes, time);
      continue;
    }
    totals.origin += row.nbytes;
    totals.origin_objects += 1;
    inflight.set(key, time + demand.origin_inflight_window_ms);
    trusted.add(key);
    cache.admit(key, row.nbytes, 1);
    if (peerEnabled) residual.note(row.user_id, key, row.nbytes, time);
  }
  const accounted = totals.cache + totals.inflight + totals.peer + totals.origin;
  if (accounted !== demand.demand_bytes) throw new Error(`BYTE_PARTITION ${accounted} ${demand.demand_bytes}`);
  return { totals, peak, residualPeak: Object.fromEntries(residual.peak) };
}

function csv(rows) {
  const header = Object.keys(rows[0]);
  return [header.join(","), ...rows.map((row) => header.map((key) => JSON.stringify(row[key] ?? "")).join(","))].join("\n") + "\n";
}

function classify(peerOrigin, largeOrigin) {
  const scale = Math.max(peerOrigin, largeOrigin, 1);
  const rel = Math.abs(largeOrigin - peerOrigin) / scale;
  if (rel <= CLOSE_REL) return "B_CLOSE";
  if (largeOrigin < peerOrigin) return "A_LARGE_PROXY_LOWER_ORIGIN";
  return "C_RESIDUAL_LOWER_ORIGIN";
}

function main() {
  const published = new Map();
  const prior = fs.readFileSync(path.join(ROOT, "FIXED_DEMAND_RESULTS.csv"), "utf8").split(/\n/).filter(Boolean);
  const priorHeader = prior[0].split(",");
  function parseCsvLine(line) {
    const out = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === "\\") { cur += line[i + 1]; i += 1; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }
  for (const line of prior.slice(1)) {
    const cols = parseCsvLine(line);
    const row = {};
    priorHeader.forEach((key, index) => { row[key] = cols[index]; });
    if (row.method === "S3-FIFO" || row.method === "S3-FIFO+verified-peer") published.set(`${row.seed}|${row.method}`, row);
  }
  const results = [];
  const diagnosis = [];
  for (const [cell, seed, scene, regime] of SCENES) {
    const file = findLog(cell);
    if (!file.includes(seed)) throw new Error(`SEED_PATH_MISMATCH ${cell}`);
    const demand = loadDemand(file);
    const fairEntries = demand.distinct_keys;
    const arms = [
      ["S3-FIFO-50", CAP_50, ENTRIES_50, false],
      ["S3-FIFO-50+verified-handoff", CAP_50, ENTRIES_50, true],
      ["S3-FIFO-530-entries-100-DIAGNOSTIC", CAP_530, ENTRIES_50, false],
      ["S3-FIFO-530-entry-unbounded", CAP_530, fairEntries, false],
    ];
    const byName = {};
    for (const [name, cap, entries, peer] of arms) {
      const result = replay(demand, cap, entries, peer);
      byName[name] = result;
      const priorKey = name === "S3-FIFO-50" ? `${seed}|S3-FIFO` : name === "S3-FIFO-50+verified-handoff" ? `${seed}|S3-FIFO+verified-peer` : "";
      const priorRow = priorKey ? published.get(priorKey) : null;
      if (priorRow && Number(priorRow.origin_bytes) !== result.totals.origin) {
        throw new Error(`REGRESSION ${priorKey} published ${priorRow.origin_bytes} replay ${result.totals.origin}`);
      }
      if (priorRow && Number(priorRow.cache_hit_bytes) !== result.totals.cache) {
        throw new Error(`REGRESSION_CACHE ${priorKey}`);
      }
      if (priorRow && priorRow.sequence_hash !== demand.sequence_hash) {
        throw new Error(`SEQUENCE_HASH ${seed}`);
      }
      results.push({
        cell, seed, scene, regime, source_log: file, sequence_hash: demand.sequence_hash,
        demand_rows: demand.rows.length, demand_bytes: demand.demand_bytes, version_filled: demand.version_filled,
        distinct_keys: demand.distinct_keys, unique_object_bytes: demand.unique_bytes,
        config: name, proxy_cap_bytes: cap, proxy_max_entries: entries, peer_enabled: peer ? 1 : 0,
        client_cap_bytes_each: peer ? CLIENT_CAP : 0, hold_ms: peer ? HOLD_MS : 0,
        users: demand.users.join("|"),
        origin_bytes: result.totals.origin, origin_objects: result.totals.origin_objects,
        cache_hit_bytes: result.totals.cache, cache_hit_objects: result.totals.cache_objects,
        inflight_merge_bytes: result.totals.inflight, inflight_objects: result.totals.inflight_objects,
        peer_bytes: result.totals.peer, peer_objects: result.totals.peer_objects,
        object_hit_ratio: result.totals.cache_objects / demand.rows.length,
        origin_share: result.totals.origin / demand.demand_bytes,
        peak_resident_objects: result.peak.objects, peak_resident_bytes: result.peak.bytes,
        evictions: result.totals.evictions, admits_ending_at_entry_cap_below_byte_cap: result.peak.entry_bound_ends,
        residual_peak_bytes_by_user: JSON.stringify(result.residualPeak),
        latency_conclusion: "NOT_APPLICABLE_HIT_DELAY_IS_MODELED_ZERO",
        matches_published_p1: priorRow ? 1 : "",
      });
    }
    const peer = byName["S3-FIFO-50+verified-handoff"].totals.origin;
    const large = byName["S3-FIFO-530-entry-unbounded"].totals.origin;
    const trapped = byName["S3-FIFO-530-entries-100-DIAGNOSTIC"].totals.origin;
    diagnosis.push({
      seed, scene, regime, distinct_keys: demand.distinct_keys, unique_object_bytes: demand.unique_bytes,
      min_object_bytes: demand.min_object, median_object_bytes: demand.median_object,
      entries_needed_so_smallest_objects_can_fill_530: Math.ceil(CAP_530 / demand.min_object),
      fair_entry_cap: fairEntries,
      origin_50: byName["S3-FIFO-50"].totals.origin,
      origin_50_handoff: peer,
      origin_530_entries_100: trapped,
      origin_530_fair: large,
      entry_trap_changes_origin: trapped === large ? 0 : 1,
      case: classify(peer, large),
      fair_minus_handoff_origin: large - peer,
    });
  }
  fs.writeFileSync(path.join(OUT, "EQUAL_CACHE_RESULTS.csv"), csv(results));
  fs.writeFileSync(path.join(OUT, "ENTRY_LIMIT_DIAGNOSIS.csv"), csv(diagnosis));
  fs.writeFileSync(path.join(OUT, "DEFINITIONS.json"), JSON.stringify({
    demand: "sealed S3-FIFO proxy.jsonl request multiset, same sort, version fill, and sequence hash as P1",
    cap_50: CAP_50,
    cap_530: CAP_530,
    cap_530_meaning: "50 MiB proxy plus 3 clients times 160 MiB configured residual",
    entries_50: ENTRIES_50,
    fair_entry_cap: "distinct versioned range keys in that sequence, so one resident copy per key cannot hit the entry ceiling",
    diagnostic_530_entries_100: "shows the unfair comparison in which the historical 100-object ceiling binds before 530 MiB",
    close_rule: `B_CLOSE when abs(large-handoff)/max(large,handoff) <= ${CLOSE_REL}; otherwise the lower origin decides A or C`,
    close_rule_locked_before_results: true,
    s3_small_fraction: 0.1,
    latency: "not reported; modelled hit delay is zero and is not a physical latency",
    regression: "50 MiB arms must match FIXED_DEMAND_RESULTS.csv origin and cache bytes",
  }, null, 2));
  console.log(JSON.stringify({ rows: results.length, cases: diagnosis.map((row) => [row.seed, row.case, row.entry_trap_changes_origin]) }));
}

main();
