"use strict";

const assert = require("assert");
const { replayDecisions } = require("./shadow_queue_replay");

const decisions = [
  { timestamp: 1, type: "client_observation", user_id: "user_C4_1", uses_future_trace_frame: false, queued_unsent: [{ start: 0, end: 1 }], pose: [1, 2, 3], viewport: [1280, 720] },
  { timestamp: 2, type: "cache_miss", user_id: "user_C3_0", cache_key: "UNVERSIONED|https://o/a|0-1" },
  { timestamp: 2, type: "origin_response", cache_key: "UNVERSIONED|https://o/a|0-1", bytes: 2 },
  { timestamp: 3, type: "cache_miss", user_id: "user_C3_0", cache_key: "UNVERSIONED|https://o/a|2-3" },
  { timestamp: 3, type: "origin_response", cache_key: "UNVERSIONED|https://o/a|2-3", bytes: 2 },
  { timestamp: 4, type: "cache_miss", user_id: "user_C3_0", cache_key: "UNVERSIONED|https://o/a|4-5" },
  { timestamp: 4, type: "origin_response", cache_key: "UNVERSIONED|https://o/a|4-5", bytes: 2 },
  { timestamp: 5, type: "cache_miss", user_id: "user_C4_1", cache_key: "UNVERSIONED|https://o/a|0-1" },
];
const result = replayDecisions(decisions, 4, 2);
assert.strictEqual(result.lru_origin_bytes, 8);
assert.strictEqual(result.spade_origin_bytes, 6);
assert.strictEqual(result.net_bytes, 2);
assert.ok(result.protects > 0);
assert.strictEqual(result.uses_future_trace_frame, false);

const future = JSON.parse(JSON.stringify(decisions));
future[0].uses_future_trace_frame = true;
const blocked = replayDecisions(future, 4, 2);
assert.strictEqual(blocked.net_bytes, 0);
assert.strictEqual(blocked.protects, 0);
console.log("SHADOW_REPLAY_PASS");
