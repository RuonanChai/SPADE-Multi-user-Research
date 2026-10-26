"use strict";

const fs = require("fs");
const { createCache } = require("./matched_cache");
const { SpadeQueueCache, shouldProtect } = require("./observation_signal");

function replayDecisions(decisions, cap = 52428800, entries = 100) {
  const sizes = new Map();
  for (const row of decisions) {
    if (row.cache_key && Number(row.bytes) > 0) sizes.set(row.cache_key, Number(row.bytes));
  }
  function run(policy) {
    const obs = new Map();
    let activeUser = "";
    let now = 0;
    let futureRejected = 0;
    const cache = policy === "SPADE_Q"
      ? new SpadeQueueCache(cap, entries, (key) => shouldProtect(key, obs, now, activeUser).protect)
      : createCache("LRU", cap, entries);
    let origin = 0;
    let unknown = 0;
    let requests = 0;
    for (const row of decisions) {
      now = Number(row.timestamp) || now;
      if (row.type === "client_observation" || (row.type === "request" && row.observation_header === "PRESENT")) {
        if (row.uses_future_trace_frame === true) futureRejected += 1;
        obs.set(row.user_id, {
          received_ms: now,
          uses_future_trace_frame: row.uses_future_trace_frame === true,
          queued_unsent: row.queued_unsent || [],
          pose: row.pose || null,
          viewport: row.viewport || null,
        });
      }
      if (row.type !== "cache_miss" && row.type !== "cache_hit") continue;
      requests += 1;
      activeUser = row.user_id;
      if (cache.lookup(row.cache_key) !== null) continue;
      const nbytes = sizes.get(row.cache_key);
      if (!nbytes) {
        unknown += 1;
        continue;
      }
      origin += nbytes;
      cache.admit(row.cache_key, nbytes, 1);
    }
    return { origin, unknown, requests, protects: cache.protects || 0, future_rejected: futureRejected };
  }
  const lru = run("LRU");
  const spade = run("SPADE_Q");
  return {
    lru_origin_bytes: lru.origin,
    spade_origin_bytes: spade.origin,
    net_bytes: lru.origin - spade.origin,
    protects: spade.protects,
    requests: lru.requests,
    unknown: lru.unknown,
    future_rejected: spade.future_rejected,
    uses_future_trace_frame: false,
  };
}

function loadJsonl(file) {
  return fs.readFileSync(file, "utf8").split(/\n/).filter(Boolean).map((line) => JSON.parse(line));
}

module.exports = { replayDecisions, loadJsonl };

if (require.main === module) {
  const file = process.argv[2];
  const result = replayDecisions(loadJsonl(file));
  process.stdout.write(JSON.stringify(result));
}
