"use strict";

const assert = require("assert");
const { createCache } = require("./matched_cache");
const { Fg3 } = require("./fg3_cache");

function victims(cache) {
  const out = [];
  const admit = (key) => {
    for (const item of cache.admit(key, 2, 1) || []) out.push(item.key + ":" + item.reason);
  };
  admit("A");
  admit("B");
  admit("C");
  cache.lookup("A");
  admit("D");
  admit("E");
  admit("F");
  return out;
}

assert.deepStrictEqual(victims(new Fg3(6, 3, "synchronized")), victims(createCache("FIFO", 6, 3)));
assert.deepStrictEqual(victims(new Fg3(6, 3, "staggered")), victims(createCache("S3-FIFO", 6, 3)));
assert.throws(() => new Fg3(6, 3, "adaptive"), /FG3_REGIME_UNKNOWN/);
console.log(JSON.stringify({ fg3: "PASS" }));
