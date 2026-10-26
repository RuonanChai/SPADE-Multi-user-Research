"use strict";

const assert = require("assert");
const { SpadeQueueCache, shouldProtect, observationFromHeaders } = require("./observation_signal");

function obs(user, start, end, received, future) {
  return [user, {
    received_ms: received,
    uses_future_trace_frame: future === true,
    queued_unsent: [{ start, end, range_known: true }],
  }];
}

const now = 1000;
const observations = new Map([
  obs("user_C4_1", 10, 19, 900, false),
  obs("user_C5_2", 30, 39, 1100, false),
  obs("user_C3_0", 10, 19, 900, false),
]);
const key = "UNVERSIONED|https://origin/a.rad|10-19";
assert.strictEqual(shouldProtect(key, observations, now, "user_C3_0").protect, true);
assert.strictEqual(shouldProtect(key, observations, now, "user_C3_0").user_id, "user_C4_1");
assert.strictEqual(shouldProtect(key, observations, 800, "user_C3_0").protect, false);
const future = new Map([obs("user_C4_1", 10, 19, 900, true)]);
assert.strictEqual(shouldProtect(key, future, now, "user_C3_0").protect, false);

const absent = observationFromHeaders({}, now);
assert.strictEqual(absent.header_present, false);
assert.strictEqual(absent.pose, null);
assert.strictEqual(absent.viewport, null);

function protectA(cacheKey) {
  return cacheKey.endsWith("|0-1");
}
const cache = new SpadeQueueCache(6, 3, protectA);
cache.admit("A|0-1", 2, 1);
cache.admit("B|2-3", 2, 1);
cache.admit("C|4-5", 2, 1);
const evicted = cache.admit("D|6-7", 2, 1);
assert.strictEqual(evicted.length, 1);
assert.strictEqual(evicted[0].key, "B|2-3");
assert.strictEqual(evicted[0].reason, "SPADE_Q_AFTER_QUEUED_PROTECT");
assert.strictEqual(cache.cache.has("A|0-1"), true);
const second = cache.admit("E|8-9", 2, 1);
assert.strictEqual(second[0].key, "A|0-1");

const plain = new SpadeQueueCache(6, 3, () => false);
plain.admit("A|0-1", 2, 1);
plain.admit("B|2-3", 2, 1);
plain.admit("C|4-5", 2, 1);
assert.strictEqual(plain.admit("D|6-7", 2, 1)[0].reason, "SPADE_Q_LRU_HEAD");

console.log("OBSERVATION_SIGNAL_PASS");
