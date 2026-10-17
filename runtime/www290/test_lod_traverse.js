"use strict";

const assert = require("assert");
const { traverseLod, indexCapacity, MISSING } = require("./lod_traverse");

const view = {
  origin: [0, 0, 0],
  forward: [0, 0, 1],
  lodScale: 1,
  behind: 0.2,
  coneFoveate: 0.4,
  coneDot0: Math.cos((45 * Math.PI) / 180),
  coneDot: Math.cos((60 * Math.PI) / 180),
};

function node(x, y, z, size, childStart, childCount) {
  return { x, y, z, size, childStart, childCount };
}

const resident = [0];
const leaf = traverseLod([node(0, 0, 10, 1, 0, 0)], resident, view, 10, 0);
assert.deepStrictEqual(leaf.indices, [0]);
assert.strictEqual(leaf.counts.expanded, 0);
assert.strictEqual(leaf.counts.pixel_evals, 1);
assert.strictEqual(leaf.counts.leaf_emitted, 1);

const two = [
  node(0, 0, 10, 8, 1, 2),
  node(-1, 0, 10, 2, 0, 0),
  node(1, 0, 10, 2, 0, 0),
];
const opened = traverseLod(two, [0, 0, 0], view, 10, 0);
assert.deepStrictEqual(new Set(opened.indices), new Set([1, 2]));
assert.deepStrictEqual(opened.indices, [2, 1]);
assert.strictEqual(opened.counts.expanded, 1);
assert.strictEqual(opened.counts.pixel_evals, 3);
assert.strictEqual(opened.counts.leaf_emitted, 2);

const hidden = traverseLod(two, [MISSING], view, 10, 0);
assert.deepStrictEqual(hidden.indices, [0]);
assert.strictEqual(hidden.counts.resident_rejected, 1);
assert.strictEqual(hidden.counts.pixel_evals, 1);

const capped = traverseLod(two, [0, 0, 0], view, 1, 0);
assert.deepStrictEqual(capped.indices, [0]);
assert.strictEqual(capped.counts.budget_stopped, 1);
assert.strictEqual(capped.counts.expanded, 0);

const coarseTree = [
  node(0, 0, 10, 80, 1, 2),
  node(-1, 0, 10, 2, 0, 0),
  node(1, 0, 10, 2, 0, 0),
];
const coarse = traverseLod(coarseTree, [0, 0, 0], view, 10, 1);
assert.ok(coarse.indices.includes(1) && coarse.indices.includes(2));
assert.strictEqual(coarse.counts.below_limit_emitted, 2);
assert.strictEqual(coarse.counts.expanded, 1);

const far = { ...view, origin: [0, 0, 100], forward: [0, 0, -1] };
const nearSet = traverseLod(coarseTree, [0, 0, 0], view, 10, 1).indices.slice().sort();
const farSet = traverseLod(coarseTree, [0, 0, 0], far, 10, 1).indices.slice().sort();
assert.deepStrictEqual(nearSet, [1, 2]);
assert.deepStrictEqual(farSet, [0]);

const updated = traverseLod(two, [0, 0, 0], view, 10, 0).indices.slice().sort();
const stale = traverseLod(two, [MISSING], view, 10, 0).indices.slice().sort();
assert.notDeepStrictEqual(updated, stale);

assert.strictEqual(indexCapacity(3750000), 229 * 16384);
assert.strictEqual(indexCapacity(0), 0);

console.log("LOD_TRAVERSE_OK");
