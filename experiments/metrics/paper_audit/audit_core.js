"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const EVIDENCE = "F:/SPADE_WWW_EVIDENCE_V2_20261024";
const P2 = path.join(EVIDENCE, "P2_CORE");
const OUT = path.join(EVIDENCE, "PAPER_FINAL_AUDIT_20261024");
const SEALED_DEMAND = "D:/Program/SPADE/SPADE_BYTE_N23_20261023/cells";
const { createCache } = require(path.join(EVIDENCE, "runtime/matched_cache"));

const IP_OF = {
  user_C3_0: "192.168.1.197",
  user_C4_1: "192.168.1.196",
  user_C5_2: "192.168.1.195",
};
const USER_OF_IP = Object.fromEntries(Object.entries(IP_OF).map(([user, ip]) => [ip, user]));
const GLOBAL_ENTRY_CAP = 1024;
const CAP_50 = 52428800;
const CLIENT_CAP = 167772160;
const CAP_530 = 555745280;
const HOLD_MS = 15000;

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function writeCsv(file, rows) {
  if (!rows.length) {
    fs.writeFileSync(file, "");
    return;
  }
  const header = Object.keys(rows[0]);
  const body = [header.join(",")].concat(rows.map((row) => header.map((key) => {
    const value = row[key] == null ? "" : String(row[key]);
    return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }).join(",")));
  fs.writeFileSync(file, body.join("\n") + "\n");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i += 1; }
        else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n") {
      row.push(cur);
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      cur = "";
    } else if (ch !== "\r") cur += ch;
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  const header = rows.shift();
  return rows.filter((cols) => cols.length && cols.some((value) => value !== "")).map((cols) => {
    const obj = {};
    header.forEach((key, index) => { obj[key] = cols[index] || ""; });
    return obj;
  });
}

function readJsonl(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\n/)) {
    if (!line.includes("{")) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

function walk(dir, name, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) walk(full, name, acc);
    else if (entry === name) acc.push(full);
  }
  return acc;
}

function percentile(values, p) {
  const nums = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const index = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1));
  return nums[index];
}

function parseKey(key) {
  const match = /^(.*)\|(https?:\/\/[^|]+)\|(\d+)-(\d+)$/.exec(key || "");
  if (!match) return null;
  return { version: match[1], url: match[2], start: Number(match[3]), end: Number(match[4]) };
}

function evidenceDir(attempt) {
  const root = path.join(P2, "attempts", attempt, "evidence");
  const runs = fs.existsSync(root) ? fs.readdirSync(root) : [];
  if (runs.length !== 1) return { error: `RUN_DIR_${runs.length}`, runs };
  return { runId: runs[0], dir: path.join(root, runs[0]) };
}

function clientWindows(dir) {
  const windows = [];
  for (const client of ["C3", "C4", "C5"]) {
    const file = path.join(dir, client, client, `${client}_evidence.json`);
    if (!fs.existsSync(file)) return { error: `MISSING_${client}` };
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    windows.push({
      client,
      start: Date.parse(doc.measurement_start),
      end: Date.parse(doc.measurement_end),
      visual_ready_ms: doc.visual_ready_ms,
      runtime_method: doc.runtime_method,
      method: doc.method,
      worker_sha256: doc.worker_sha256,
      trace_sha256: doc.trace_sha256,
    });
  }
  const starts = windows.map((row) => row.start);
  const ends = windows.map((row) => row.end);
  return {
    windows,
    unionStart: Math.min(...starts),
    unionEnd: Math.max(...ends),
    intersectionStart: Math.max(...starts),
    intersectionEnd: Math.min(...ends),
  };
}

function partition(proxyRows, start, end, stampName) {
  const out = {
    demand: 0, delivered: 0, cache_hit: 0, inflight_merge: 0, peer_handoff: 0,
    peer_handoff_merge: 0, origin_bytes: 0, rows: 0,
  };
  for (const row of proxyRows) {
    const stamp = Number(row[stampName]);
    if (!Number.isFinite(stamp) || stamp < start || stamp > end) continue;
    const delivered = Number(row.bytes_to_client) || 0;
    const origin = Number(row.bytes_from_origin) || 0;
    out.rows += 1;
    out.demand += delivered;
    out.delivered += delivered;
    out.origin_bytes += origin;
    if (row.decision === "cache_hit") out.cache_hit += delivered;
    else if (row.decision === "inflight_merge") out.inflight_merge += delivered;
    else if (row.decision === "peer_handoff") out.peer_handoff += delivered;
    else if (row.decision === "peer_handoff_merge") out.peer_handoff_merge += delivered;
  }
  return out;
}

function chainForAttempt(cell, proxyRows, decisionRows) {
  const verify = new Map();
  const verifyReasons = {};
  const evict = [];
  for (const row of decisionRows) {
    if (row.type === "peer_verify") {
      verify.set(row.request_id, row);
      verifyReasons[`${row.source || ""}|${row.reason || ""}`] = (verifyReasons[`${row.source || ""}|${row.reason || ""}`] || 0) + 1;
    } else if (row.type === "cache_eviction") {
      evict.push({ t: Number(row.timestamp), key: row.cache_key, request_id: row.request_id, bytes: Number(row.bytes) || 0 });
    }
  }
  const admit = [];
  const handoffs = [];
  const merges = [];
  for (const row of proxyRows) {
    if (row.decision === "origin_fetch" || row.decision === "peer_handoff") {
      admit.push({ t: Number(row.timestamp), key: row.cache_key, request_id: row.request_id, kind: row.decision });
    }
    if (row.decision === "peer_handoff") handoffs.push(row);
    if (row.decision === "peer_handoff_merge") merges.push(row);
  }
  const mutations = [
    ...evict.map((row, index) => ({ ...row, order: index, kind: "evict" })),
    ...admit.map((row, index) => ({ ...row, order: index, kind: "admit" })),
  ].sort((left, right) => left.t - right.t || (left.kind === "admit" ? -1 : 1) || left.order - right.order);
  const resident = new Set();
  const openedAt = new Map();
  const lastClosed = new Map();
  let index = 0;
  let orphan = 0;
  function advance(time) {
    while (index < mutations.length && mutations[index].t < time) {
      const event = mutations[index];
      index += 1;
      if (event.kind === "evict") {
        if (!resident.delete(event.key)) orphan += 1;
        else lastClosed.set(event.key, { evict_t: event.t, admit_t: openedAt.get(event.key), request_id: event.request_id, bytes: event.bytes });
      } else if (!resident.has(event.key)) {
        resident.add(event.key);
        openedAt.set(event.key, event.t);
      }
    }
  }
  const events = [];
  const seenRequest = new Set();
  for (const row of handoffs.slice().sort((left, right) => Number(left.request_start_ms) - Number(right.request_start_ms))) {
    const parsed = parseKey(row.cache_key);
    const check = verify.get(row.request_id);
    const trustedReason = check && (check.reason === "DIGEST_MATCH" || check.reason === "DIGEST_MATCH_PEER_ETAG_IGNORED");
    const trusted = Boolean(trustedReason && check.digest_sha256 && check.source === "peer");
    const supplier = USER_OF_IP[row.peer_ip] || "";
    const sameViewer = Boolean(IP_OF[row.user_id] && row.peer_ip === IP_OF[row.user_id]);
    const identityOk = Boolean(parsed && parsed.url === row.url && parsed.start === row.range_start && parsed.end === row.range_end && parsed.version === row.etag);
    const duplicate = seenRequest.has(row.request_id);
    seenRequest.add(row.request_id);
    advance(Number(row.request_start_ms));
    const closed = lastClosed.get(row.cache_key);
    const absent = !resident.has(row.cache_key);
    const prior = Boolean(closed && closed.evict_t < Number(row.request_start_ms) && Number.isFinite(closed.admit_t) && closed.admit_t < closed.evict_t);
    let status = "PROVEN_POST_EVICTION";
    if (duplicate) status = "DUPLICATE_REQUEST_ID";
    else if (!identityOk) status = "IDENTITY_MISMATCH";
    else if (!trusted) status = "UNTRUSTED";
    else if (sameViewer || !supplier) status = "SUPPLIER_NOT_DISTINCT";
    else if (!absent) status = "STILL_RESIDENT";
    else if (!prior) status = "NO_PRIOR_CLOSED_RESIDENCY";
    const gap = prior ? Number(row.request_start_ms) - closed.evict_t : "";
    events.push({
      cell_id: cell.cell_id,
      attempt_id: cell.attempt_id,
      scene: cell.scene,
      seed: cell.seed,
      rep: cell.rep,
      request_id: row.request_id,
      requester: row.user_id,
      supplier,
      supplier_ip: row.peer_ip || "",
      version: row.etag || "",
      url_sha256: sha256Text(row.url || ""),
      range_start: row.range_start,
      range_end: row.range_end,
      range_bytes: row.range_size,
      bytes_to_client: row.bytes_to_client,
      bytes_from_origin: row.bytes_from_origin,
      admit_timestamp: prior ? closed.admit_t : "",
      eviction_timestamp: prior ? closed.evict_t : "",
      eviction_request_id: prior ? closed.request_id : "",
      request_start_ms: row.request_start_ms,
      handoff_timestamp: row.timestamp,
      gap_evict_to_request_ms: gap,
      ttl_15s_exceeded: gap === "" ? "" : gap > HOLD_MS,
      verify_reason: check ? check.reason : "",
      verify_source: check ? check.source : "",
      digest_sha256: check ? check.digest_sha256 : "",
      status,
    });
  }
  return { events, orphan, evictions: evict.length, admits: admit.length, merges, verifyReasons };
}

function loadDemand(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\n/)) {
    if (!line.includes("{")) continue;
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
      nbytes: expected,
      origin_ttfb_ms: Number.isFinite(Number(row.origin_ttfb_ms)) ? Number(row.origin_ttfb_ms) : null,
      status_ok: size === expected && Number(row.bytes_to_client) === expected,
    });
  }
  const versionByUrl = new Map();
  const versions = new Map();
  for (const row of rows) {
    if (row.representation_version === "MISSING") continue;
    versionByUrl.set(row.url, row.representation_version);
    if (!versions.has(row.url)) versions.set(row.url, new Set());
    versions.get(row.url).add(row.representation_version);
  }
  let versionFilled = 0;
  for (const row of rows) {
    if (row.representation_version === "MISSING" && versionByUrl.has(row.url)) {
      row.representation_version = versionByUrl.get(row.url);
      versionFilled += 1;
    }
  }
  rows.sort((left, right) => left.request_start_ms - right.request_start_ms);
  const originMs = rows[0] ? rows[0].request_start_ms : 0;
  const encoded = rows.map((row) => [row.user_id, row.url, row.range_start, row.range_end, row.request_start_ms - originMs, row.representation_version].join("|")).join("\n");
  const sizes = new Map();
  for (const row of rows) sizes.set(`${row.representation_version}|${row.url}|${row.range_start}-${row.range_end}`, row.nbytes);
  const ttfbs = rows.map((row) => row.origin_ttfb_ms).filter((value) => value !== null).sort((left, right) => left - right);
  const medianGap = ttfbs.length ? ttfbs[Math.min(ttfbs.length - 1, Math.max(0, Math.ceil(0.5 * ttfbs.length) - 1))] : 0;
  return {
    rows,
    sequence_hash: sha256Text(encoded),
    demand_bytes: rows.reduce((sum, row) => sum + row.nbytes, 0),
    version_filled: versionFilled,
    distinct_keys: sizes.size,
    unique_bytes: [...sizes.values()].reduce((sum, value) => sum + value, 0),
    version_counts: [...versions.values()].map((set) => set.size),
    cold_start: rows.length > 0,
    modeled_inflight_ms: medianGap,
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
  const totals = { cache: 0, inflight: 0, peer: 0, origin: 0 };
  const peak = { objects: 0, bytes: 0, entry_bound_while_bytes_free: 0 };
  const inner = cache.admit.bind(cache);
  cache.admit = (key, nbytes, data) => {
    const evicted = inner(key, nbytes, data) || [];
    const resident = cache.small.size + cache.main.size;
    peak.objects = Math.max(peak.objects, resident);
    peak.bytes = Math.max(peak.bytes, cache.nbytes);
    if (resident >= entries && cache.nbytes < cap) peak.entry_bound_while_bytes_free += 1;
    return evicted;
  };
  for (const row of demand.rows) {
    const key = `${row.representation_version}|${row.url}|${row.range_start}-${row.range_end}`;
    const time = row.request_start_ms;
    for (const [pending, ready] of inflight) if (time > ready) inflight.delete(pending);
    if (cache.lookup(key) != null) {
      totals.cache += row.nbytes;
      if (peerEnabled) residual.note(row.user_id, key, row.nbytes, time);
      continue;
    }
    if (inflight.has(key)) {
      totals.inflight += row.nbytes;
      if (peerEnabled) residual.note(row.user_id, key, row.nbytes, time);
      continue;
    }
    const holder = peerEnabled && trusted.has(key) ? residual.find(row.user_id, key, time) : null;
    if (holder) {
      totals.peer += row.nbytes;
      cache.admit(key, row.nbytes, 1);
      residual.note(row.user_id, key, row.nbytes, time);
      continue;
    }
    totals.origin += row.nbytes;
    inflight.set(key, time + demand.modeled_inflight_ms);
    trusted.add(key);
    cache.admit(key, row.nbytes, 1);
    if (peerEnabled) residual.note(row.user_id, key, row.nbytes, time);
  }
  const accounted = totals.cache + totals.inflight + totals.peer + totals.origin;
  if (accounted !== demand.demand_bytes) throw new Error(`BYTE_PARTITION ${accounted} ${demand.demand_bytes}`);
  return { totals, peak, residualPeak: Object.fromEntries(residual.peak) };
}

function main() {
  const cells = parseCsv(fs.readFileSync(path.join(P2, "metrics/P2_CELL_MASTER.csv"), "utf8"));
  const cellRows = [];
  const events = [];
  const verifyRollup = {};
  let orphanTotal = 0;
  for (const cell of cells) {
    const located = evidenceDir(cell.attempt_id);
    if (located.error) throw new Error(`${cell.attempt_id} ${located.error}`);
    const windows = clientWindows(located.dir);
    const proxyFile = path.join(located.dir, "S_runtime", "proxy.jsonl");
    const decisionFile = path.join(located.dir, "S_runtime", "proxy_decisions.jsonl");
    const proxyRows = readJsonl(proxyFile);
    const decisionRows = readJsonl(decisionFile);
    const definitions = {
      request_union: partition(proxyRows, windows.unionStart, windows.unionEnd, "request_start_ms"),
      response_union: partition(proxyRows, windows.unionStart, windows.unionEnd, "timestamp"),
      request_intersection: partition(proxyRows, windows.intersectionStart, windows.intersectionEnd, "request_start_ms"),
      response_intersection: partition(proxyRows, windows.intersectionStart, windows.intersectionEnd, "timestamp"),
      entire_log: partition(proxyRows, -Infinity, Infinity, "request_start_ms"),
    };
    const masterOriginResponse = Number(cell.B_remote_origin_response_window);
    const masterOriginRequest = Number(cell.B_remote_origin_request_window);
    const masterDemand = Number(cell.B_demand);
    const masterPeer = Number(cell.B_peer_handoff);
    const row = {
      cell_id: cell.cell_id,
      attempt_id: cell.attempt_id,
      scene: cell.scene,
      seed: cell.seed,
      arm: cell.arm,
      rep: cell.rep,
      run_id_matches: located.runId === cell.run_id,
      union_ms: windows.unionEnd - windows.unionStart,
      intersection_ms: windows.intersectionEnd - windows.intersectionStart,
      master_window_ms: Number(cell.window_duration_ms),
      union_matches_master_window: windows.unionStart === Number(cell.window_start_ms) && windows.unionEnd === Number(cell.window_end_ms),
      worker_sha256: windows.windows[0].worker_sha256,
      trace_sha256: windows.windows[0].trace_sha256,
      client_runtime_method: windows.windows.map((item) => item.runtime_method).join("|"),
      client_method: windows.windows.map((item) => item.method).join("|"),
      visual_ready_C3: windows.windows[0].visual_ready_ms,
      visual_ready_C4: windows.windows[1].visual_ready_ms,
      visual_ready_C5: windows.windows[2].visual_ready_ms,
      master_demand: masterDemand,
      demand_request_union: definitions.request_union.demand,
      demand_response_union: definitions.response_union.demand,
      demand_request_intersection: definitions.request_intersection.demand,
      demand_entire_log: definitions.entire_log.demand,
      origin_request_union: definitions.request_union.origin_bytes,
      origin_response_union: definitions.response_union.origin_bytes,
      origin_request_intersection: definitions.request_intersection.origin_bytes,
      origin_entire_log: definitions.entire_log.origin_bytes,
      peer_request_union: definitions.request_union.peer_handoff,
      peer_entire_log: definitions.entire_log.peer_handoff,
      merge_request_union: definitions.request_union.peer_handoff_merge,
      merge_entire_log: definitions.entire_log.peer_handoff_merge,
      master_origin_response: masterOriginResponse,
      master_origin_request: masterOriginRequest,
      master_peer: masterPeer,
      response_union_reproduces_master_origin: definitions.response_union.origin_bytes === masterOriginResponse,
      request_union_reproduces_master_origin: definitions.request_union.origin_bytes === masterOriginRequest,
      request_union_reproduces_master_demand: definitions.request_union.demand === masterDemand,
      request_union_reproduces_master_peer: definitions.request_union.peer_handoff === masterPeer,
    };
    if (cell.arm === "B") {
      const chain = chainForAttempt(cell, proxyRows, decisionRows);
      orphanTotal += chain.orphan;
      row.orphan_evictions = chain.orphan;
      row.eviction_rows = chain.evictions;
      row.admit_rows = chain.admits;
      row.peer_handoff_rows = chain.events.length;
      row.peer_merge_rows = chain.merges.length;
      row.proven_rows = chain.events.filter((event) => event.status === "PROVEN_POST_EVICTION").length;
      row.proven_bytes = chain.events.filter((event) => event.status === "PROVEN_POST_EVICTION").reduce((sum, event) => sum + Number(event.bytes_to_client), 0);
      row.merge_bytes = chain.merges.reduce((sum, event) => sum + (Number(event.bytes_to_client) || 0), 0);
      row.chain_status_counts = JSON.stringify(chain.events.reduce((acc, event) => {
        acc[event.status] = (acc[event.status] || 0) + 1;
        return acc;
      }, {}));
      for (const [key, count] of Object.entries(chain.verifyReasons)) verifyRollup[key] = (verifyRollup[key] || 0) + count;
      events.push(...chain.events);
    }
    cellRows.push(row);
  }

  const proven = events.filter((event) => event.status === "PROVEN_POST_EVICTION");
  const gaps = proven.map((event) => Number(event.gap_evict_to_request_ms)).sort((a, b) => a - b);
  const sizes = proven.map((event) => Number(event.range_bytes)).sort((a, b) => a - b);
  const chainSummary = {
    handoff_rows: events.length,
    proven_rows: proven.length,
    proven_bytes: proven.reduce((sum, event) => sum + Number(event.bytes_to_client), 0),
    orphan_evictions: orphanTotal,
    statuses: events.reduce((acc, event) => { acc[event.status] = (acc[event.status] || 0) + 1; return acc; }, {}),
    suppliers_distinct_from_requester: proven.filter((event) => event.supplier && event.supplier !== event.requester).length,
    gap_min_ms: gaps[0],
    gap_p50_ms: percentile(gaps, 50),
    gap_p95_ms: percentile(gaps, 95),
    gap_p99_ms: percentile(gaps, 99),
    gap_max_ms: gaps[gaps.length - 1],
    ttl_exceeded: proven.filter((event) => event.ttl_15s_exceeded === true || event.ttl_15s_exceeded === "true").length,
    range_p50: percentile(sizes, 50),
    range_min: sizes[0],
    range_max: sizes[sizes.length - 1],
    verify_reasons_all_b: verifyRollup,
    bytes_from_origin_on_proven: proven.reduce((sum, event) => sum + Number(event.bytes_from_origin), 0),
  };

  const scenes = [
    ["b30c01", "27391639", "coit", "staggered"],
    ["b30c04", "27396087", "coit", "staggered"],
    ["b30c07", "27397637", "coit", "staggered"],
    ["b30c10", "27394061", "poland", "synchronized"],
    ["b30c13", "27391244", "poland", "synchronized"],
    ["b30c16", "27394531", "poland", "synchronized"],
  ];
  const capacity = [];
  for (const [cell, seed, scene, regime] of scenes) {
    const evidence = path.join(SEALED_DEMAND, cell, "evidence");
    const run = fs.readdirSync(evidence)[0];
    const file = path.join(evidence, run, "S_runtime", "proxy.jsonl");
    const demand = loadDemand(file);
    const arms = [
      ["S3-FIFO-50", CAP_50, 100, false],
      ["S3-FIFO-50+peer", CAP_50, 100, true],
      ["S3-FIFO-530-entries-100-DIAGNOSTIC", CAP_530, 100, false],
      ["S3-FIFO-530-per-trace-distinct", CAP_530, demand.distinct_keys, false],
      ["S3-FIFO-530-global-cap-1024", CAP_530, GLOBAL_ENTRY_CAP, false],
    ];
    const byName = {};
    for (const [name, cap, entries, peer] of arms) {
      const result = replay(demand, cap, entries, peer);
      byName[name] = result;
      capacity.push({
        cell, seed, scene, regime, source_log: file, sequence_hash: demand.sequence_hash,
        demand_rows: demand.rows.length, demand_bytes: demand.demand_bytes,
        version_filled: demand.version_filled, distinct_etag_per_url_max: Math.max(...demand.version_counts),
        distinct_keys: demand.distinct_keys, unique_object_bytes: demand.unique_bytes,
        config: name, proxy_cap_bytes: cap, proxy_max_entries: entries, peer_enabled: peer ? 1 : 0,
        origin_bytes: result.totals.origin, cache_hit_bytes: result.totals.cache,
        inflight_bytes: result.totals.inflight, peer_bytes: result.totals.peer,
        peak_resident_objects: result.peak.objects, peak_resident_bytes: result.peak.bytes,
        entry_bound_while_bytes_free: result.peak.entry_bound_while_bytes_free,
        residual_peak_json: JSON.stringify(result.residualPeak),
      });
    }
    const peerOrigin = byName["S3-FIFO-50+peer"].totals.origin;
    const large = byName["S3-FIFO-530-global-cap-1024"].totals.origin;
    const traceCap = byName["S3-FIFO-530-per-trace-distinct"].totals.origin;
    capacity[capacity.length - 1].matches_per_trace_cap = large === traceCap;
    capacity[capacity.length - 1].reduction_vs_peer = (peerOrigin - large) / peerOrigin;
  }

  const latencyRows = parseCsv(fs.readFileSync(path.join(P2, "metrics/P2_REQUEST_LATENCY.csv"), "utf8"));
  const latency = [];
  const groups = new Map();
  for (const row of latencyRows) {
    if (row.kind !== "browser_complete") continue;
    const key = `${row.cell_id}|${row.client}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(Number(row.ms) * 1000);
  }
  const byCell = new Map();
  for (const row of latencyRows) {
    if (row.kind !== "browser_complete") continue;
    if (!byCell.has(row.cell_id)) byCell.set(row.cell_id, []);
    byCell.get(row.cell_id).push(Number(row.ms) * 1000);
  }
  for (const [cellId, values] of byCell) {
    latency.push({
      cell_id: cellId,
      samples: values.length,
      raw_unit_observed: "seconds_in_source_column_named_ms",
      p50_ms: percentile(values, 50),
      p95_ms: percentile(values, 95),
      p99_ms: percentile(values, 99),
    });
  }

  const qoe = parseCsv(fs.readFileSync(path.join(P2, "metrics/P2_QOE_PER_FRAME.csv"), "utf8"));
  const qoeSummary = {
    rows: qoe.length,
    blank: qoe.filter((row) => row.blank === "1").length,
    stale: qoe.filter((row) => row.stale === "1").length,
    canvas_present: qoe.filter((row) => row.canvas_present === "1").length,
    no_reference: qoe.filter((row) => row.score_status === "NO_LOCKED_REFERENCE").length,
    numeric_psnr: qoe.filter((row) => row.psnr !== "").length,
    score_statuses: qoe.reduce((acc, row) => { acc[row.score_status || "EMPTY"] = (acc[row.score_status || "EMPTY"] || 0) + 1; return acc; }, {}),
  };

  const resources = parseCsv(fs.readFileSync(path.join(P2, "metrics/P2_RESOURCE_1HZ.csv"), "utf8"));
  const resourceSummary = [];
  const resourceGroups = new Map();
  for (const row of resources) {
    if (!resourceGroups.has(row.cell_id)) resourceGroups.set(row.cell_id, []);
    resourceGroups.get(row.cell_id).push(row);
  }
  for (const [cellId, rows] of resourceGroups) {
    const cpu = rows.map((row) => Number(row.cpu_percent)).filter(Number.isFinite);
    const gpu = rows.map((row) => Number(row.gpu_util_percent)).filter(Number.isFinite);
    const rss = rows.map((row) => Number(row.process_rss_mb)).filter(Number.isFinite);
    resourceSummary.push({
      cell_id: cellId,
      samples: rows.length,
      cpu_finite: cpu.length,
      gpu_finite: gpu.length,
      cpu_p50: percentile(cpu, 50),
      gpu_p50: percentile(gpu, 50),
      rss_p50: percentile(rss, 50),
      vram_note: rows[0] ? rows[0].nvidia_vram_note : "",
    });
  }

  const fixed = parseCsv(fs.readFileSync(path.join(EVIDENCE, "FIXED_DEMAND_RESULTS.csv"), "utf8"));
  const fixedPairs = [];
  const bySeed = new Map();
  for (const row of fixed) {
    if (!bySeed.has(row.seed)) bySeed.set(row.seed, []);
    bySeed.get(row.seed).push(row);
  }
  for (const [seed, rows] of bySeed) {
    const s3 = rows.find((row) => row.method === "S3-FIFO");
    const peer = rows.find((row) => row.method === "S3-FIFO+verified-peer");
    const adapt = rows.find((row) => row.method === "SPADE-verified");
    const sieve = rows.find((row) => row.method === "SIEVE+verified-peer");
    fixedPairs.push({
      seed,
      s3_origin: Number(s3.origin_bytes),
      peer_origin: Number(peer.origin_bytes),
      adapt_origin: Number(adapt.origin_bytes),
      sieve_origin: Number(sieve.origin_bytes),
      adapt_minus_peer: Number(adapt.origin_bytes) - Number(peer.origin_bytes),
      sieve_minus_peer: Number(sieve.origin_bytes) - Number(peer.origin_bytes),
      peer_vs_s3: (Number(s3.origin_bytes) - Number(peer.origin_bytes)) / Number(s3.origin_bytes),
      latency_model: peer.latency_model,
    });
  }

  const protocol = parseCsv(fs.readFileSync(path.join(EVIDENCE, "PROTOCOL_INTEGRITY_TESTS.csv"), "utf8"));
  const manifestHash = sha256File(path.join(EVIDENCE, "EXPERIMENT_MANIFEST.json"));
  const workerHash = sha256File(path.join(EVIDENCE, "runtime/remote_worker_bundle.next.js"));
  const summary = {
    manifest_sha256: manifestHash,
    manifest_matches_candidate: manifestHash === "c2d2680ed206268d5afa244757ac752e12e60dc5128f765bddc58a6a10e48846",
    worker_sha256: workerHash,
    worker_matches_candidate: workerHash === "b12c758064b1f96a00c4d4f27fb1db6e669696eb832d6127b8ad424fb51d2de8",
    cap_530_bytes: CAP_530,
    cap_50_bytes: CAP_50,
    client_cap_bytes: CLIENT_CAP,
    global_entry_cap: GLOBAL_ENTRY_CAP,
    sealed_cells: cells.length,
    chain: chainSummary,
    protocol_rows: protocol.length,
    protocol_pass: protocol.filter((row) => row.pass === "true").length,
    protocol_bad_delivered: protocol.reduce((sum, row) => sum + Number(row.bad_delivered || 0), 0),
    protocol_bad_cached: protocol.reduce((sum, row) => sum + Number(row.bad_cached || 0), 0),
    qoe: qoeSummary,
    fixedPairs,
  };
  fs.writeFileSync(path.join(OUT, "analysis/AUDIT_SUMMARY.json"), JSON.stringify(summary, null, 2));
  writeCsv(path.join(OUT, "analysis/P2_CELL_RECOMPUTE.csv"), cellRows);
  writeCsv(path.join(OUT, "POST_EVICTION_EVENTS.csv"), events);
  writeCsv(path.join(OUT, "analysis/EQUAL_CAPACITY_REPLAY.csv"), capacity);
  writeCsv(path.join(OUT, "P2_REAL_LATENCY.csv"), latency);
  writeCsv(path.join(OUT, "analysis/P2_RESOURCE_SUMMARY.csv"), resourceSummary);
  const aggregates = [];
  const agg = new Map();
  for (const event of proven) {
    const key = `${event.scene}|${event.seed}|${event.rep}|${event.requester}`;
    if (!agg.has(key)) agg.set(key, { scene: event.scene, seed: event.seed, rep: event.rep, requester: event.requester, objects: 0, bytes: 0, suppliers: new Set() });
    const item = agg.get(key);
    item.objects += 1;
    item.bytes += Number(event.bytes_to_client);
    item.suppliers.add(event.supplier);
  }
  for (const item of agg.values()) aggregates.push({ scene: item.scene, seed: item.seed, rep: item.rep, requester: item.requester, objects: item.objects, bytes: item.bytes, supplier_count: item.suppliers.size, suppliers: [...item.suppliers].join("|") });
  writeCsv(path.join(OUT, "POST_EVICTION_AGGREGATES.csv"), aggregates);
  console.log(JSON.stringify({
    proven: chainSummary.proven_rows,
    proven_bytes: chainSummary.proven_bytes,
    handoffs: chainSummary.handoff_rows,
    orphan: orphanTotal,
    statuses: chainSummary.statuses,
    gap_min: chainSummary.gap_min_ms,
    gap_p50: chainSummary.gap_p50_ms,
    gap_max: chainSummary.gap_max_ms,
    ttl_exceeded: chainSummary.ttl_exceeded,
    manifest_ok: summary.manifest_matches_candidate,
    worker_ok: summary.worker_matches_candidate,
    cells: cells.length,
    qoe: qoeSummary,
    capacity_tail: capacity.filter((row) => row.config === "S3-FIFO-530-global-cap-1024").map((row) => ({
      seed: row.seed,
      origin: row.origin_bytes,
      peak_objects: row.peak_resident_objects,
      peak_bytes: row.peak_resident_bytes,
      entry_bound: row.entry_bound_while_bytes_free,
      reduction: row.reduction_vs_peer,
      matches: row.matches_per_trace_cap,
    })),
  }, null, 2));
}

main();
