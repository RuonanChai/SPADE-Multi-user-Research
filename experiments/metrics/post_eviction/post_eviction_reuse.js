"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = "D:/Program/SPADE_WWW_EVIDENCE_V2_20261024/P2_CORE";
const OUT = "D:/Program/SPADE_WWW_EVIDENCE_V2_20261024/P2_CACHE_EQUAL";
const IP = { user_C3_0: "192.168.1.197", user_C4_1: "192.168.1.196", user_C5_2: "192.168.1.195" };

function walk(dir, name, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) walk(full, name, acc);
    else if (entry === name) acc.push(full);
  }
  return acc;
}

function parseKey(key) {
  const match = /^(.*)\|(https?:\/\/[^|]+)\|(\d+)-(\d+)$/.exec(key || "");
  if (!match) return null;
  return { version: match[1], url: match[2], start: Number(match[3]), end: Number(match[4]) };
}

function analyze(attempt) {
  const evidence = path.join(ROOT, "attempts", attempt, "evidence");
  const proxyFile = walk(evidence, "proxy.jsonl")[0];
  const decisionFile = walk(evidence, "proxy_decisions.jsonl")[0];
  if (!proxyFile || !decisionFile) return { attempt, status: "LOG_MISSING" };
  const verify = new Map();
  const evict = [];
  let evictionRows = 0;
  for (const line of fs.readFileSync(decisionFile, "utf8").split(/\n/)) {
    if (!line) continue;
    const row = JSON.parse(line);
    if (row.type === "peer_verify") verify.set(row.request_id, row);
    else if (row.type === "cache_eviction") {
      evictionRows += 1;
      evict.push({ t: row.timestamp, key: row.cache_key });
    }
  }
  const admit = [];
  const peers = [];
  for (const line of fs.readFileSync(proxyFile, "utf8").split(/\n/)) {
    if (!line) continue;
    const row = JSON.parse(line);
    if (row.decision === "origin_fetch" || row.decision === "peer_handoff") {
      admit.push({ t: row.timestamp, key: row.cache_key });
    }
    if (row.decision === "peer_handoff") peers.push(row);
  }
  const mutations = [
    ...evict.map((row) => ({ t: row.t, order: 0, kind: "evict", key: row.key })),
    ...admit.map((row) => ({ t: row.t, order: 1, kind: "admit", key: row.key })),
  ].sort((left, right) => left.t - right.t || left.order - right.order);
  const resident = new Set();
  const lastEvict = new Map();
  let index = 0;
  let orphan = 0;
  const counts = {
    peer_objects: 0, peer_bytes: 0, proven_objects: 0, proven_bytes: 0,
    no_prior_eviction: 0, still_resident: 0, identity_mismatch: 0, untrusted: 0,
    same_viewer: 0, unparsed_key: 0,
  };
  function advance(time) {
    while (index < mutations.length && mutations[index].t < time) {
      const event = mutations[index];
      index += 1;
      if (event.kind === "evict") {
        if (!resident.delete(event.key)) orphan += 1;
        lastEvict.set(event.key, event.t);
      } else if (!resident.has(event.key)) resident.add(event.key);
    }
  }
  for (const row of peers.sort((left, right) => left.request_start_ms - right.request_start_ms)) {
    counts.peer_objects += 1;
    counts.peer_bytes += Number(row.bytes_to_client) || 0;
    const parsed = parseKey(row.cache_key);
    const check = verify.get(row.request_id) || verify.get(row.origin_request_id);
    const trusted = check && (check.reason === "DIGEST_MATCH" || check.reason === "DIGEST_MATCH_PEER_ETAG_IGNORED") && check.digest_sha256 && check.source === "peer";
    if (!trusted) counts.untrusted += 1;
    if (!parsed || parsed.url !== row.url || parsed.start !== row.range_start || parsed.end !== row.range_end || parsed.version !== row.etag) {
      counts.identity_mismatch += 1;
      continue;
    }
    if (IP[row.user_id] && row.peer_ip === IP[row.user_id]) counts.same_viewer += 1;
    advance(row.request_start_ms);
    const evictedAt = lastEvict.get(row.cache_key);
    if (resident.has(row.cache_key)) {
      counts.still_resident += 1;
      continue;
    }
    if (!evictedAt || evictedAt >= row.request_start_ms) {
      counts.no_prior_eviction += 1;
      continue;
    }
    if (!trusted || (IP[row.user_id] && row.peer_ip === IP[row.user_id])) continue;
    counts.proven_objects += 1;
    counts.proven_bytes += Number(row.bytes_to_client) || 0;
  }
  return {
    attempt, status: orphan === 0 ? "CHAIN_RECONSTRUCTED" : "CHAIN_INCOMPLETE_ORPHAN_EVICTION",
    eviction_rows: evictionRows, orphan_evictions: orphan, admit_rows: admit.length, ...counts,
  };
}

function csv(rows) {
  const header = Object.keys(rows[0]);
  return [header.join(","), ...rows.map((row) => header.map((key) => JSON.stringify(row[key] ?? "")).join(","))].join("\n") + "\n";
}

const master = fs.readFileSync(path.join(ROOT, "metrics", "P2_CELL_MASTER.csv"), "utf8").split(/\n/).filter(Boolean);
const header = master[0].split(",");
const arm = header.indexOf("arm");
const attempt = header.indexOf("attempt_id");
const cell = header.indexOf("cell_id");
const rows = [];
for (const line of master.slice(1)) {
  const cols = line.split(",");
  if (cols[arm] !== "B") continue;
  rows.push({ cell_id: cols[cell], ...analyze(cols[attempt]) });
}
fs.writeFileSync(path.join(OUT, "POST_EVICTION_REUSE.csv"), csv(rows));
const proven = rows.reduce((sum, row) => sum + (row.proven_objects || 0), 0);
const provenBytes = rows.reduce((sum, row) => sum + (row.proven_bytes || 0), 0);
const peer = rows.reduce((sum, row) => sum + (row.peer_objects || 0), 0);
console.log(JSON.stringify({ cells: rows.length, peer_objects: peer, proven_objects: proven, proven_bytes: provenBytes, incomplete: rows.filter((row) => row.status !== "CHAIN_RECONSTRUCTED").map((row) => row.attempt) }));
