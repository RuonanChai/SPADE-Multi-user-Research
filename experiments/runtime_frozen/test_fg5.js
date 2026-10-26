"use strict";

const assert = require("assert");
const { createCache } = require("./matched_cache");
const { Fg5 } = require("./fg5_cache");

function drive(cache) {
  const victims = [];
  const keys = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  keys.forEach((key, index) => {
    if (index % 3 === 0 && index > 0) cache.lookup(keys[index - 1]);
    if (index % 4 === 0 && index > 2) cache.lookup(keys[0]);
    for (const item of cache.admit(key, 2, key) || []) victims.push(item.key + ":" + item.reason);
  });
  return victims;
}

assert.deepStrictEqual(
  drive(new Fg5(20, 8, "synchronized")),
  drive(createCache("FIFO", 20, 8))
);
assert.deepStrictEqual(
  drive(new Fg5(20, 8, "staggered")),
  drive(createCache("S3-FIFO", 20, 8))
);
assert.throws(() => new Fg5(20, 8, "adaptive"), /FG5_REGIME_UNKNOWN/);

const production = new Fg5(52428800, 100, "synchronized");
for (let i = 0; i < 120; i += 1) production.admit("P" + i, 600000, i);
assert.ok(production.cache.nbytes <= 52428800);
assert.strictEqual(production.mode, "FIFO");
assert.strictEqual(new Fg5(1024, 2, "staggered").mode, "S3-FIFO");

console.log(JSON.stringify({ fg5: "PASS", synchronized_victims: drive(new Fg5(20, 8, "synchronized")).length }));
