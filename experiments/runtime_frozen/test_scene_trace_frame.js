"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { FRAMES, mapTrace } = require("./scene_trace_frame");
const { framesFromViewer, frameMatches } = require("./parse_viewer_worlds");
const { buildQueue, summarize } = require("../generate_baseline_queue");

const trace = {
  name: "stop_go",
  frames: [{ time: 0, camera: { x: 7.142, y: 4.203, z: -1.128 } }],
};
const coit = mapTrace(trace, "coit-40m-sh1-lod");
assert.strictEqual(coit.identity, true);
assert.strictEqual(coit.trace.frames[0].camera.x, 7.142);

const poland = mapTrace(trace, "poland-lod");
assert.strictEqual(poland.identity, false);
assert.strictEqual(poland.gain, 1);
assert.ok(Math.abs(poland.trace.frames[0].camera.x - 51.7) < 1e-9);
assert.ok(Math.abs(poland.trace.frames[0].camera.y + 1.5) < 1e-9);
assert.ok(Math.abs(poland.trace.frames[0].camera.z + 1.7) < 1e-9);
assert.notStrictEqual(poland.trace.frames[0].camera.x, 7.142);

const cozy = mapTrace(trace, "cozy-spaceship_2-lod");
assert.ok(Math.abs(cozy.trace.frames[0].camera.x - 0.8) < 1e-9);
assert.ok(Math.abs(cozy.trace.frames[0].camera.y - 0.2) < 1e-9);

const hobbit = mapTrace(trace, "tijerin_w6_hobbiton-lod");
assert.ok(Math.abs(hobbit.trace.frames[0].camera.x - cozy.trace.frames[0].camera.x) < 1e-9);
assert.throws(() => mapTrace(trace, "missing"), /SCENE_FRAME_UNKNOWN/);

const parsed = framesFromViewer();
for (const file of Object.keys(FRAMES)) {
  assert.ok(frameMatches(FRAMES[file], parsed[file]), file);
}
assert.strictEqual(parsed["cozy-spaceship_2-lod"].worldPosition[1], -6.5);
assert.deepStrictEqual(parsed["tijerin_w6_hobbiton-lod"].worldQuaternion, [1, 0, 0, 0]);
assert.deepStrictEqual(parsed["tijerin_w6_hobbiton-lod"].camera, [0, 0, 0]);
assert.strictEqual(parsed["poland-lod"].scale, 0.05);

const worker = fs.readFileSync(path.join(__dirname, "remote_worker_bundle.next.js"), "utf8");
const hold = worker.indexOf("burst_turn_hold_lod");
const pose = worker.indexOf("prepareStartPose");
const replay = worker.indexOf("holdLod");
const moving = worker.indexOf("CAMERA_DID_NOT_MOVE_AFTER_BARRIER");
const release = worker.indexOf("burst_turn_release_lod");
const skew = worker.indexOf("MEASUREMENT_START_SKEW_INVALID");
assert.ok(hold > 0 && hold < pose);
assert.ok(replay > pose && replay < moving);
assert.ok(release > moving && release < skew);
const liveWorker = fs.readFileSync(path.join(__dirname, "remote_worker_bundle.js"), "utf8");
assert.ok(!liveWorker.includes("burst_turn_hold_lod"));
const liveCell = fs.readFileSync(path.join(__dirname, "isolated_run_cell.js"), "utf8");
assert.ok(!liveCell.includes("remote_worker_bundle.next.js"));

const csv = path.join(__dirname, "..", "BASELINE_PRIORITY_83.csv");
const csvBefore = fs.statSync(csv).mtimeMs;
const rows = buildQueue();
assert.strictEqual(fs.statSync(csv).mtimeMs, csvBefore);
const summary = summarize(rows);
assert.strictEqual(rows.length, 113);
assert.strictEqual(summary.N1, 4);
assert.strictEqual(summary.N2, 74);
assert.strictEqual(summary.N3, 35);
assert.strictEqual(new Set(rows.map((row) => row.logical_id)).size, rows.length);
assert.ok(!rows.some((row) => row.block_reason === "SCENE_TRANSFORM_UNQUALIFIED"));
assert.ok(!rows.some((row) => row.block_reason === "BURST_TURN_STARTUP_FAILURE_AFTER_ARMED_CLOCK_FIX"));
const seeds = {
  "cozy|random_walk|staggered|N2|C3+C4|LRU": 27231212,
  "cozy|burst_turn|synchronized|N2|C3+C4|LRU": 27231302,
  "hobbiton|random_walk|staggered|N2|C3+C4|LRU": 27232212,
  "hobbiton|burst_turn|synchronized|N2|C3+C4|LRU": 27232302,
  "poland|random_walk|staggered|N2|C3+C4|LRU": 27233212,
  "poland|burst_turn|synchronized|N2|C3+C4|LRU": 27233302,
  "cozy|stop_go|synchronized|N2|C3+C4|LRU": 27231002,
};
for (const [id, seed] of Object.entries(seeds)) {
  const row = rows.find((item) => item.logical_id === id);
  assert.ok(row, id);
  assert.strictEqual(row.seed, seed);
  assert.strictEqual(row.phase, "P3");
}
for (const scene of ["cozy", "hobbiton", "poland"]) {
  const traces = new Set(rows.filter((row) => row.scene === scene).map((row) => row.trace));
  assert.deepStrictEqual([...traces].sort(), ["burst_turn", "orbit", "random_walk", "stop_go"]);
}
const coitBurst = rows.find((row) => row.logical_id === "coit|burst_turn|synchronized|N2|C3+C4|LRU");
assert.notStrictEqual(coitBurst.block_reason, "BURST_TURN_STARTUP_FAILURE_AFTER_ARMED_CLOCK_FIX");
assert.ok(coitBurst.execution_state === "READY" || coitBurst.execution_state === "ATTEMPTED");
const cozyWalk = rows.find((row) => row.logical_id === "cozy|random_walk|staggered|N2|C3+C4|LRU");
const coitP5 = rows.find((row) => row.phase === "P5" && row.scene === "coit" && row.execution_state === "READY");
function rank(row) {
  const methodRank = ["LRU", "FIFO", "SIEVE", "S3-FIFO", "IND"].indexOf(row.method);
  const phaseRank = row.phase === "P2" ? 0 : row.phase === "P1" ? 1 : row.phase === "P5" ? 2 : row.phase === "P6" ? 3 : 4;
  return phaseRank * 100000 + row.plan_index * 10 + methodRank;
}
if (coitP5) assert.ok(rank(coitP5) < rank(cozyWalk));
const runner = fs.readFileSync(path.join(__dirname, "..", "run_recoverable_queue.js"), "utf8");
assert.ok(runner.includes('row.scene !== "coit" || row.trace === "burst_turn"'));
assert.ok(runner.includes("isolated_run_cell.next.js"));
const waiter = fs.readFileSync(path.join(__dirname, "..", "wait_queue_resume.js"), "utf8");
assert.ok(!waiter.includes("copyFileSync"));

console.log("SCENE_TRACE_FRAME_PASS");
