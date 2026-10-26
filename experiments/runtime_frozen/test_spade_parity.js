"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { replay, createLiveCache } = require("./spade_f_live");

function lruReplay(requests, capacity, entries) {
  const rows = requests.slice().sort((a, b) => a.ts - b.ts || String(a.user).localeCompare(String(b.user)) || String(a.key).localeCompare(String(b.key)));
  const order = [];
  const meta = new Map();
  let used = 0;
  let origin = 0;
  const victims = [];
  for (const row of rows) {
    if (meta.has(row.key)) {
      order.splice(order.indexOf(row.key), 1);
      order.push(row.key);
      continue;
    }
    meta.set(row.key, row.bytes);
    order.push(row.key);
    used += row.bytes;
    origin += row.bytes;
    while (order.length > entries || used > capacity) {
      if (order.length <= 1 && meta.get(order[0]) > capacity) break;
      const victim = order.shift();
      used -= meta.get(victim);
      meta.delete(victim);
      victims.push(victim);
    }
  }
  return { origin, victims };
}

function sameVictims(left, right) {
  return JSON.stringify(left.map((row) => row.victim)) === JSON.stringify(right);
}

const repeated = [];
for (let index = 0; index < 4; index += 1) {
  repeated.push({ user: "A", key: `k${index}`, bytes: 10, ts: index + 1, request_id: `a${index}` });
}
repeated.push({ user: "A", key: "k1", bytes: 10, ts: 5, request_id: "hit" });
const lru = lruReplay(repeated, 30, 3);
const off = replay(repeated, false, true, 30, 3);
const unproven = replay(repeated, true, false, 30, 3);
if (off.origin !== lru.origin || !sameVictims(off.decisions, lru.victims)) throw new Error("CROSS_USER_OFF_NOT_LRU");
if (unproven.origin !== lru.origin || !sameVictims(unproven.decisions, lru.victims)) throw new Error("VERSION_OFF_NOT_LRU");

let divergent = null;
for (let lag = 5; lag <= 40; lag += 1) {
  for (let evictAt = lag + 1; evictAt <= lag + 30; evictAt += 1) {
    const requests = [
      { user: "A", key: "a", bytes: 10, ts: 1, request_id: "1" },
      { user: "A", key: "b", bytes: 10, ts: 2, request_id: "2" },
      { user: "A", key: "f1", bytes: 10, ts: 3, request_id: "3" },
      { user: "A", key: "f2", bytes: 10, ts: 4, request_id: "4" },
      { user: "B", key: "a", bytes: 10, ts: 1 + lag, request_id: "5" },
      { user: "B", key: "b", bytes: 10, ts: 2 + lag, request_id: "6" },
      { user: "B", key: "b", bytes: 10, ts: evictAt - 1, request_id: "7" },
      { user: "A", key: "f2", bytes: 10, ts: evictAt - 1, request_id: "8" },
      { user: "C", key: "z", bytes: 10, ts: evictAt, request_id: "9" },
    ];
    const spade = replay(requests, true, true, 30, 3);
    const base = lruReplay(requests, 30, 3);
    const changed = spade.decisions.some((row) => row.reason === "EVICT_OLDEST_UNPROTECTED" && row.victim !== row.lru_head);
    if (changed && spade.origin !== base.origin) {
      divergent = { lag, evictAt, spade, base };
      break;
    }
  }
  if (divergent) break;
}
if (!divergent) throw new Error("NO_DIVERGENT_VICTIM");

const cache = createLiveCache(30, 3);
if (cache.policy.versionProven !== false) throw new Error("VERSION_DEFAULTED_TRUE");
const weak = cache.observeVersion("W/\"abc\"");
if (weak.version_proven !== false) throw new Error("WEAK_ETAG_ACCEPTED");
const strong = cache.observeVersion("\"abc-153\"");
if (strong.version_proven !== false || strong.reason !== "FIRST_ETAG_UNCONFIRMED") throw new Error("SINGLE_ETAG_PROVED");
const confirmed = cache.observeVersion("\"abc-153\"");
if (confirmed.version_proven !== true || confirmed.reason !== "STABLE_STRONG_ETAG") throw new Error("STRONG_ETAG_REJECTED");
const clash = cache.observeVersion("\"other\"");
if (clash.version_proven !== false) throw new Error("CONFLICT_NOT_CLOSED");

const smoke = createLiveCache(100, 2);
smoke.note("A", 1);
if (smoke.lookup("range") !== null) throw new Error("SMOKE_FALSE_HIT");
smoke.admit("range", 40, Buffer.from("one"));
smoke.note("A", 2);
if (!smoke.lookup("range")) throw new Error("SMOKE_MISS_AFTER_ADMIT");
smoke.note("B", 3);
smoke.admit("other", 40, Buffer.from("two"));
smoke.note("C", 4);
const evicted = smoke.admit("third", 40, Buffer.from("three"));
if (evicted.length !== 1) throw new Error("SMOKE_EVICTION_COUNT");

const payload = {
  requests: [
    { user: "A", key: "a", bytes: 10, ts: 1, request_id: "1" },
    { user: "A", key: "b", bytes: 10, ts: 2, request_id: "2" },
    { user: "A", key: "f1", bytes: 10, ts: 3, request_id: "3" },
    { user: "B", key: "a", bytes: 10, ts: 10, request_id: "4" },
    { user: "B", key: "b", bytes: 10, ts: 11, request_id: "5" },
    { user: "C", key: "z", bytes: 10, ts: 12, request_id: "6" },
  ],
  divergent_requests: [
    { user: "A", key: "a", bytes: 10, ts: 1, request_id: "1" },
    { user: "A", key: "b", bytes: 10, ts: 2, request_id: "2" },
    { user: "A", key: "f1", bytes: 10, ts: 3, request_id: "3" },
    { user: "A", key: "f2", bytes: 10, ts: 4, request_id: "4" },
    { user: "B", key: "a", bytes: 10, ts: 1 + divergent.lag, request_id: "5" },
    { user: "B", key: "b", bytes: 10, ts: 2 + divergent.lag, request_id: "6" },
    { user: "B", key: "b", bytes: 10, ts: divergent.evictAt - 1, request_id: "7" },
    { user: "A", key: "f2", bytes: 10, ts: divergent.evictAt - 1, request_id: "8" },
    { user: "C", key: "z", bytes: 10, ts: divergent.evictAt, request_id: "9" },
  ],
};
const outDir = __dirname;
fs.writeFileSync(path.join(outDir, "parity_input.json"), JSON.stringify(payload));
const python = "D:/Download/MinGW-W64/ucrt64/bin/python.exe";
const compared = spawnSync(python, [path.join(outDir, "compare_frozen_spade.py"), path.join(outDir, "parity_input.json")], { encoding: "utf8" });
if (compared.status !== 0) {
  console.error(compared.stdout);
  console.error(compared.stderr);
  throw new Error("PYTHON_PARITY_FAILED");
}
const pythonResult = JSON.parse(compared.stdout);
const nodeShared = replay(payload.requests, true, true, 30, 3);
if (nodeShared.origin !== pythonResult.shared.origin) throw new Error(`ORIGIN_MISMATCH node=${nodeShared.origin} python=${pythonResult.shared.origin}`);
if (JSON.stringify(nodeShared.decisions.map((row) => [row.victim, row.reason])) !== JSON.stringify(pythonResult.shared.decisions)) {
  throw new Error(`DECISION_MISMATCH ${JSON.stringify(nodeShared.decisions)} vs ${JSON.stringify(pythonResult.shared.decisions)}`);
}
const nodeDivergent = replay(payload.divergent_requests, true, true, 30, 3);
if (JSON.stringify(nodeDivergent.decisions.map((row) => [row.victim, row.reason])) !== JSON.stringify(pythonResult.divergent.decisions)) {
  throw new Error("DIVERGENT_PARITY_MISMATCH");
}

const result = {
  pass: true,
  lru_fallback: true,
  version_default_false: true,
  divergent_victim: divergent.spade.decisions.filter((row) => row.victim !== row.lru_head).map((row) => ({ victim: row.victim, lru_head: row.lru_head, reason: row.reason })),
  python: pythonResult.python,
};
fs.writeFileSync(path.join(outDir, "POLICY_PARITY_RESULT.json"), JSON.stringify(result, null, 2));
console.log("POLICY_PARITY_PASS");
