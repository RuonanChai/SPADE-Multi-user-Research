"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createCache } = require("./matched_cache");

function run(policy, spec) {
  const cache = createCache(policy, spec.cap, spec.entries);
  const victims = [];
  for (const step of spec.steps) {
    if (step.op === "hit") {
      const found = cache.lookup(step.key);
      assert.notStrictEqual(found, null, `${policy} hit ${step.key}`);
    } else if (step.op === "admit") {
      const evicted = cache.admit(step.key, step.nbytes, 1);
      for (const item of evicted) victims.push(`${item.key}:${item.reason}`);
    } else if (step.op === "miss") {
      assert.strictEqual(cache.lookup(step.key), null, `${policy} miss ${step.key}`);
    }
  }
  return { cache, victims };
}

const sieve = run("SIEVE", {
  cap: 100,
  entries: 4,
  steps: [
    { op: "admit", key: "A", nbytes: 1 },
    { op: "admit", key: "B", nbytes: 1 },
    { op: "admit", key: "C", nbytes: 1 },
    { op: "hit", key: "A" },
    { op: "admit", key: "D", nbytes: 1 },
    { op: "admit", key: "E", nbytes: 1 },
    { op: "hit", key: "C" },
    { op: "admit", key: "F", nbytes: 1 },
  ],
});
assert.deepStrictEqual(sieve.victims, ["B:SIEVE_HAND", "D:SIEVE_HAND"]);
assert.strictEqual(sieve.cache.order.includes("A"), true);
assert.strictEqual(sieve.cache.order.includes("B"), false);
assert.strictEqual(sieve.cache.order.includes("D"), false);
assert.strictEqual(sieve.cache.cache.get("A").visited, 0);
assert.strictEqual(sieve.cache.hand, "E");
assert.deepStrictEqual(sieve.cache.order, ["A", "C", "E", "F"]);

const fifo = run("FIFO", {
  cap: 6,
  entries: 3,
  steps: [
    { op: "admit", key: "A", nbytes: 2 },
    { op: "admit", key: "B", nbytes: 2 },
    { op: "admit", key: "C", nbytes: 2 },
    { op: "hit", key: "A" },
    { op: "admit", key: "D", nbytes: 2 },
  ],
});
assert.deepStrictEqual(fifo.victims, ["A:FIFO_OLDEST"]);
assert.deepStrictEqual(fifo.cache.order, ["B", "C", "D"]);

const lru = run("LRU", {
  cap: 6,
  entries: 3,
  steps: [
    { op: "admit", key: "A", nbytes: 2 },
    { op: "admit", key: "B", nbytes: 2 },
    { op: "admit", key: "C", nbytes: 2 },
    { op: "hit", key: "A" },
    { op: "admit", key: "D", nbytes: 2 },
  ],
});
assert.deepStrictEqual(lru.victims, ["B:LRU_HEAD"]);
assert.deepStrictEqual(lru.cache.order, ["C", "A", "D"]);

const sieveSame = run("SIEVE", {
  cap: 6,
  entries: 3,
  steps: [
    { op: "admit", key: "A", nbytes: 2 },
    { op: "admit", key: "B", nbytes: 2 },
    { op: "admit", key: "C", nbytes: 2 },
    { op: "hit", key: "A" },
    { op: "admit", key: "D", nbytes: 2 },
  ],
});
assert.deepStrictEqual(sieveSame.victims, ["B:SIEVE_HAND"]);

const s3 = run("S3-FIFO", {
  cap: 100,
  entries: 2,
  steps: [
    { op: "admit", key: "A", nbytes: 1 },
    { op: "admit", key: "B", nbytes: 1 },
    { op: "hit", key: "B" },
    { op: "admit", key: "C", nbytes: 1 },
    { op: "admit", key: "D", nbytes: 1 },
    { op: "hit", key: "B" },
    { op: "admit", key: "A", nbytes: 1 },
  ],
});
assert.deepStrictEqual(s3.victims, ["A:S3FIFO_SMALL", "C:S3FIFO_SMALL", "A:S3FIFO_MAIN"]);
assert.strictEqual(s3.cache.small.has("D"), true);
assert.strictEqual(s3.cache.main.has("B"), true);
assert.strictEqual(s3.cache.main.get("B").freq, 0);
assert.strictEqual(s3.cache.small.has("A") || s3.cache.main.has("A"), false);
assert.strictEqual(s3.cache.ghostSet.has("A"), false);
assert.strictEqual(s3.cache.ghostSet.has("C"), true);
assert.strictEqual(s3.cache.smallByte, 10);
assert.strictEqual(s3.cache.smallEntries, 1);

const production = createCache("S3-FIFO", 52428800, 100);
assert.strictEqual(production.smallByte, 5242880);
assert.strictEqual(production.smallEntries, 10);
assert.strictEqual(production.ghostLimit, 100);

const visitedWrap = run("SIEVE", {
  cap: 100,
  entries: 3,
  steps: [
    { op: "admit", key: "A", nbytes: 1 },
    { op: "admit", key: "B", nbytes: 1 },
    { op: "admit", key: "C", nbytes: 1 },
    { op: "hit", key: "A" },
    { op: "hit", key: "B" },
    { op: "hit", key: "C" },
    { op: "admit", key: "D", nbytes: 1 },
  ],
});
assert.deepStrictEqual(visitedWrap.victims, ["D:SIEVE_HAND"]);
assert.deepStrictEqual(visitedWrap.cache.order, ["A", "B", "C"]);
assert.strictEqual(visitedWrap.cache.cache.get("A").visited, 0);
assert.strictEqual(visitedWrap.cache.hand, "A");

const sieveOver = run("SIEVE", { cap: 10, entries: 10, steps: [{ op: "admit", key: "Z", nbytes: 11 }] });
assert.deepStrictEqual(sieveOver.victims, []);
assert.strictEqual(sieveOver.cache.cache.has("Z"), true);

const s3Bytes = run("S3-FIFO", {
  cap: 4,
  entries: 100,
  steps: [
    { op: "admit", key: "A", nbytes: 1 },
    { op: "admit", key: "B", nbytes: 1 },
    { op: "admit", key: "C", nbytes: 1 },
    { op: "admit", key: "D", nbytes: 1 },
    { op: "admit", key: "E", nbytes: 1 },
    { op: "admit", key: "A", nbytes: 1 },
    { op: "admit", key: "B", nbytes: 1 },
    { op: "admit", key: "C", nbytes: 1 },
    { op: "admit", key: "D", nbytes: 1 },
  ],
});
assert.deepStrictEqual(s3Bytes.victims, [
  "A:S3FIFO_SMALL",
  "B:S3FIFO_SMALL",
  "C:S3FIFO_SMALL",
  "D:S3FIFO_SMALL",
  "A:S3FIFO_MAIN",
]);
assert.deepStrictEqual([...s3Bytes.cache.small.keys()], ["E"]);
assert.deepStrictEqual([...s3Bytes.cache.main.keys()], ["B", "C", "D"]);
assert.strictEqual(s3Bytes.cache.ghostSet.has("A"), false);

const s3Over = run("S3-FIFO", { cap: 10, entries: 10, steps: [{ op: "admit", key: "Z", nbytes: 11 }] });
assert.deepStrictEqual(s3Over.victims, []);
assert.strictEqual(s3Over.cache.small.has("Z"), true);

const report = {
  verdict: "PASS",
  process_exit_is_not_evidence: true,
  matched_cache_sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(__dirname, "matched_cache.js"))).digest("hex"),
  sieve: {
    mechanism: "hit sets visited and does not reorder; hand persists and clears visited bits",
    persistent_hand_victims: sieve.victims,
    persistent_hand_order: sieve.cache.order,
    persistent_hand_next: sieve.cache.hand,
    same_fixture_as_fifo_and_lru: {
      fifo: fifo.victims,
      lru: lru.victims,
      sieve: sieveSame.victims,
    },
    all_visited_wrap_victim: visitedWrap.victims,
  },
  s3fifo: {
    mechanism: "small, main, and ghost queues with a frequency bit",
    small_ratio: 0.1,
    promotion_and_main_second_chance_victims: s3.victims,
    final_small: [...s3.cache.small.keys()],
    final_main: [...s3.cache.main.keys()],
    final_ghost: [...s3.cache.ghost],
    byte_budget_victim: s3Bytes.victims,
    production_small_bytes: production.smallByte,
    production_small_entries: production.smallEntries,
    production_ghost_limit: production.ghostLimit,
  },
};
fs.writeFileSync(path.join(__dirname, "..", "POLICY_MECHANISM_ORACLE.json"), JSON.stringify(report, null, 2));
console.log("POLICY_MECHANISM_ORACLE_PASS");
