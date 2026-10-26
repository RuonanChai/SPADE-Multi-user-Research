"use strict";

const assert = require("assert");
const { createCache } = require("./matched_cache");
const { Fg2 } = require("./fg2_cache");

function fifoVictims() {
  const cache = createCache("FIFO", 6, 3);
  cache.admit("A", 2, 1);
  cache.admit("B", 2, 1);
  cache.admit("C", 2, 1);
  cache.lookup("A");
  return cache.admit("D", 2, 1).map((item) => item.key + ":" + item.reason);
}

const fg = new Fg2(6, 3);
fg.admit("A", 2, 1, { userId: "C3", time: 0 });
fg.admit("B", 2, 1, { userId: "C3", time: 10 });
fg.admit("C", 2, 1, { userId: "C3", time: 20 });
fg.lookup("A", { userId: "C3", time: 30 });
const early = fg.admit("D", 2, 1, { userId: "C3", time: 40 }).map((item) => item.key + ":" + item.reason);
assert.deepStrictEqual(early, fifoVictims());
assert.strictEqual(fg.mode, "FIFO");

const stay = new Fg2(100, 20);
for (let i = 0; i < 8; i += 1) {
  stay.lookup("K" + i, { userId: "C3", time: i * 1000 });
  stay.lookup("K" + i, { userId: "C4", time: i * 1000 + 200 });
}
assert.strictEqual(stay.mode, "FIFO");

const flip = new Fg2(100, 20);
flip.admit("KEEP", 4, "body", { userId: "C3", time: 0 });
for (let i = 0; i < 8; i += 1) {
  flip.lookup("P" + i, { userId: "C3", time: 1000 + i * 1000 });
  flip.lookup("P" + i, { userId: "C4", time: 1000 + i * 1000 + 6000 });
}
assert.strictEqual(flip.mode, "S3-FIFO");
assert.strictEqual(flip.lookup("KEEP", { userId: "C5", time: 99999 }), "body");

console.log(JSON.stringify({ fg2: "PASS", mode: flip.mode }));
