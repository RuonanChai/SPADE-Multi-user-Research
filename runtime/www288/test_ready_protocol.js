"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { acceptReady, writeReadyAtomic, receiveReady } = require("./ready_protocol");
const root = path.join("F:\\WWW_N3_MUX", "runtime", "www288", "tmp");

const expected = { runId: "nsdi_N2_LRU_example_r1", clientId: "C4" };
const doc = {
  runId: expected.runId,
  clientId: "C4",
  trace_loaded: true,
  frames_replayed_at_ready: 0,
};

function tempDir() {
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, "ready-"));
}

const echoed = "cmd /c if exist D:\\evidence\\RUN\\C4\\READY echo READY";
assert.strictEqual(acceptReady(echoed, expected).reason, "CORRUPT");
assert.strictEqual(acceptReady("", expected).reason, "EMPTY");
assert.strictEqual(acceptReady(JSON.stringify({ ...doc, runId: "other" }), expected).reason, "RUN_MISMATCH");
assert.strictEqual(acceptReady(JSON.stringify({ ...doc, clientId: "C3" }), expected).reason, "CLIENT_MISMATCH");
assert.strictEqual(acceptReady(JSON.stringify({ ...doc, trace_loaded: false }), expected).reason, "TRACE_NOT_LOADED");
assert.strictEqual(acceptReady(JSON.stringify({ ...doc, frames_replayed_at_ready: 4 }), expected).reason, "REPLAY_ALREADY_STARTED");

const dir = tempDir();
fs.writeFileSync(path.join(dir, "READY.partial"), "{");
assert.strictEqual(fs.existsSync(path.join(dir, "READY")), false);
const written = writeReadyAtomic(fs, dir, doc);
assert.strictEqual(acceptReady(fs.readFileSync(written, "utf8"), expected).ok, true);
assert.strictEqual(fs.existsSync(path.join(dir, "READY.partial")), false);

const local = path.join(tempDir(), "C4", "READY");
let reads = 0;
const flaky = receiveReady({
  fs,
  localPath: local,
  expected,
  readRemote() {
    reads += 1;
    if (reads === 1) throw new Error("ssh timeout");
    return JSON.stringify(doc);
  },
});
assert.strictEqual(flaky.reason, "TRANSFER_FAILED");
assert.strictEqual(fs.existsSync(local), false);
const recovered = receiveReady({
  fs,
  localPath: local,
  expected,
  readRemote() {
    reads += 1;
    return JSON.stringify(doc);
  },
});
assert.strictEqual(recovered.ok, true);
assert.strictEqual(recovered.idempotent, false);
const again = receiveReady({
  fs,
  localPath: local,
  expected,
  readRemote() {
    throw new Error("remote disappeared");
  },
});
assert.strictEqual(again.ok, true);
assert.strictEqual(again.idempotent, true);

const rejected = path.join(tempDir(), "bad", "READY");
const wrong = receiveReady({
  fs,
  localPath: rejected,
  expected,
  readRemote() {
    return echoed;
  },
});
assert.strictEqual(wrong.reason, "CORRUPT");
assert.strictEqual(fs.existsSync(rejected), false);

console.log("READY_PROTOCOL_OK");
