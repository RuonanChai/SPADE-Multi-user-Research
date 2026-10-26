"use strict";

const assert = require("assert");
const { createCache } = require("./matched_cache");
const { Fg4 } = require("./fg4_cache");

function meta(user, time) {
  return { userId: user, time, etag: '"v"', versionProven: true, residentHit: true, inflight: false };
}

function fifoKeys() {
  const cache = createCache("FIFO", 6, 3);
  cache.admit("A", 2, 1);
  cache.admit("B", 2, 1);
  cache.admit("C", 2, 1);
  cache.lookup("A");
  return cache.admit("D", 2, 1).map((item) => item.key);
}

const plain = new Fg4(6, 3);
plain.admit("A", 2, 1, meta("C3", 0));
plain.admit("B", 2, 1, meta("C3", 10));
plain.admit("C", 2, 1, meta("C3", 20));
plain.lookup("A", meta("C3", 30));
assert.deepStrictEqual(plain.admit("D", 2, 1, meta("C3", 40)).map((item) => item.key), fifoKeys());
assert.strictEqual(plain.snapshot().main_objects, 0);

const offband = new Fg4(6, 3);
offband.admit("A", 2, 1, meta("C3", 0));
offband.admit("B", 2, 1, meta("C3", 10));
offband.admit("C", 2, 1, meta("C3", 20));
offband.lookup("A", meta("C4", 7000));
assert.strictEqual(offband.snapshot().main_objects, 0);
assert.deepStrictEqual(offband.admit("D", 2, 1, meta("C3", 7010)).map((item) => item.key), ["A"]);

const band = new Fg4(6, 3);
band.admit("A", 2, 1, meta("C3", 0));
band.admit("B", 2, 1, meta("C3", 10));
band.admit("C", 2, 1, meta("C3", 20));
band.lookup("A", meta("C4", 5000));
assert.strictEqual(band.snapshot().main_objects, 1);
assert.deepStrictEqual(band.admit("D", 2, 1, meta("C3", 5010)).map((item) => item.key + ":" + item.reason), ["B:FG4_COLD_OLDEST"]);

const ten = new Fg4(20, 4);
ten.admit("K", 2, 1, meta("C3", 0));
ten.lookup("K", meta("C5", 10000));
assert.strictEqual(ten.snapshot().main_objects, 1);
ten.lookup("K", meta("C5", 10200));
assert.strictEqual(ten.snapshot().promotions, 1);

let bytes = 0;
const capped = new Fg4(10, 4);
for (let i = 0; i < 12; i += 1) {
  capped.admit("O" + i, 4, i, meta("C3", i));
  bytes = capped.snapshot().nbytes;
  assert.ok(bytes <= 10);
  assert.ok(capped.snapshot().objects <= 4);
}

console.log(JSON.stringify({ fg4: "PASS", bytes }));
