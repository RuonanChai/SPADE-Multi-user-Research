"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createCache, replayOutcomes } = require("./matched_cache");

function boundary(dir) {
  const root = path.resolve("D:\\Program\\SPADE_REUSE_AND_EXECUTE_20261019");
  const resolved = path.resolve(dir);
  const prefix = (root.endsWith(path.sep) ? root : root + path.sep).toLowerCase();
  const value = resolved.toLowerCase();
  return value === root.toLowerCase() || value.startsWith(prefix);
}

const historical = [
  "D:\\Program\\SPADE_F_PROSPECTIVE_DIAG_20261018\\c1\\evidence\\C3",
  "D:\\Program\\SPADE_POST_A4_PROSPECTIVE_20261019\\c1\\evidence\\C3",
  "D:\\Program\\SPADE_FINAL_SINGLEPASS_20261019\\b1\\evidence\\C3",
  "D:\\Program\\SPADE_BOUNDED_20261019\\cell\\evidence\\C3",
  "D:\\Program\\SPADE_REUSE_AND_EXECUTE_20261019_EVIL\\evidence\\C3",
];
for (const dir of historical) assert.strictEqual(boundary(dir), false, dir);
assert.strictEqual(boundary("D:\\Program\\SPADE_REUSE_AND_EXECUTE_20261019\\cell1\\evidence\\run\\C3"), true);
const worker = fs.readFileSync(path.join(__dirname, "remote_worker_bundle.js"), "utf8");
assert.ok(worker.includes("const REMOTE_ALLOW = 'D:\\\\Program\\\\SPADE_REUSE_AND_EXECUTE_20261019';"));
assert.ok(!worker.includes("SPADE_FINAL_SINGLEPASS"));
assert.ok(!worker.includes("SPADE_F_PROSPECTIVE"));
assert.ok(/Math\.abs\(measurementStartSkewMs\) > 3000/.test(worker));
const capture = fs.readFileSync(path.join(__dirname, "capture_checkpoint.js"), "utf8");
assert.ok(capture.includes("}), { count, timeoutMs });"));
assert.ok(!capture.includes("}), count, timeoutMs);"));

function residual(observed, epoch, offset) {
  return observed - (epoch + offset);
}
const epoch = 1792347066910;
assert.strictEqual(residual(epoch + 5000, epoch, 5000), 0);
assert.strictEqual(residual(epoch, epoch, 0), 0);
assert.ok(Math.abs(residual(epoch + 5000 + 5203.5, epoch, 5000)) > 3000);
assert.ok(Math.abs(residual(epoch + 5000 + 6199.5, epoch, 5000)) > 3000);
assert.ok(Math.abs(residual(epoch + 5000 + 2999, epoch, 5000)) <= 3000);
assert.ok(Math.abs(residual(epoch + 5000 + 3001, epoch, 5000)) > 3000);
assert.notStrictEqual(residual(epoch + 5000 + 203.5, epoch, 0), residual(epoch + 5000 + 203.5, epoch, 5000));

function victims(policy, reqs, cap, entries) {
  const cache = createCache(policy, cap, entries);
  const evicted = [];
  for (const req of reqs) {
    if (cache.lookup(req.key) !== null) evicted.push([]);
    else evicted.push(cache.admit(req.key, req.nbytes, 1).map((item) => item.key));
  }
  return evicted;
}
const sized = [
  { key: "A", nbytes: 2 },
  { key: "B", nbytes: 2 },
  { key: "C", nbytes: 2 },
  { key: "A", nbytes: 2 },
  { key: "D", nbytes: 2 },
];
assert.deepStrictEqual(victims("LRU", sized, 6, 3), [[], [], [], [], ["B"]]);
assert.deepStrictEqual(victims("FIFO", sized, 6, 3), [[], [], [], [], ["A"]]);
assert.deepStrictEqual(victims("SIEVE", sized, 6, 3), [[], [], [], [], ["B"]]);
assert.deepStrictEqual(victims("S3-FIFO", sized, 6, 3), [[], [], [], [], ["B"]]);
const small = [
  { key: "A", nbytes: 1 }, { key: "B", nbytes: 1 }, { key: "C", nbytes: 1 }, { key: "D", nbytes: 1 },
];
assert.deepStrictEqual(victims("S3-FIFO", small, 3, 3), [[], [], [], ["A"]]);
const users = { C3: new Map(), C4: new Map() };
function indLookup(user, key) { return users[user].has(key); }
function indAdmit(user, key) { users[user].set(key, true); }
indAdmit("C3", "A");
assert.strictEqual(indLookup("C3", "A"), true);
assert.strictEqual(indLookup("C4", "A"), false);
assert.deepStrictEqual(replayOutcomes("FIFO", sized, 6, 3).outcomes, ["miss", "miss", "miss", "hit", "miss"]);
const fifo = createCache("FIFO", 6, 3);
fifo.admit("A", 2, 1); fifo.admit("B", 2, 1); fifo.lookup("A"); fifo.admit("C", 2, 1);
assert.deepStrictEqual(fifo.order, ["A", "B", "C"]);

console.log("PHASE1_LOCAL_PASS");
