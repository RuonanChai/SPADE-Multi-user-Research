"use strict";

const assert = require("assert");

function viewToken(state) {
  return JSON.stringify({
    position: state.position,
    quaternion: state.quaternion,
    fov: state.fov,
    viewport: state.viewport,
    lodThreshold: state.lodThreshold,
    treeVersion: state.treeVersion,
  });
}

function sameDrawView(a, b) {
  return viewToken(a) === viewToken(b);
}

function visible(chunk, view) {
  if (chunk.cancelled) return false;
  return (chunk.id + view.lodThreshold) % 5 !== 0;
}

function rebuild(resident, view) {
  const pages = new Map();
  for (const chunk of resident) {
    const current = pages.get(chunk.page);
    if (!current || chunk.generation > current.generation) pages.set(chunk.page, chunk);
  }
  const selected = [];
  for (const chunk of pages.values()) {
    if (!visible(chunk, view)) continue;
    const child = [...pages.values()].some((other) => other.parentId === chunk.id && visible(other, view));
    if (child) continue;
    selected.push(chunk.id);
  }
  selected.sort((a, b) => a - b);
  return selected;
}

function incremental(previous, resident, arrived, evicted, view, previousView) {
  if (!sameDrawView(view, previousView)) return null;
  const next = resident
    .filter((chunk) => !evicted.some((item) => item.page === chunk.page && item.generation === chunk.generation))
    .concat(arrived);
  const selected = rebuild(next, view);
  return { selected, visits: arrived.length + evicted.length, previousSize: previous.length };
}

const base = {
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  fov: 75,
  viewport: [1280, 720],
  lodThreshold: 2,
  treeVersion: 4,
};
const turned = { ...base, quaternion: [0, 1, 0, 0] };
const zoomed = { ...base, fov: 40 };
const resized = { ...base, viewport: [1920, 1080] };
const retuned = { ...base, lodThreshold: 3 };
const revised = { ...base, treeVersion: 5 };
assert.strictEqual(sameDrawView(base, { ...base }), true);
for (const changed of [turned, zoomed, resized, retuned, revised]) {
  assert.strictEqual(sameDrawView(base, changed), false);
}

const parent = { id: 1, page: 1, generation: 1, parentId: null };
const child = { id: 2, page: 2, generation: 1, parentId: 1 };
const reused = { id: 9, page: 2, generation: 2, parentId: 1 };
let resident = [parent, child];
let selected = rebuild(resident, base);
assert.deepStrictEqual(selected, [2]);

const arrived = [reused];
const evicted = [child];
const step = incremental(selected, resident, arrived, evicted, base, base);
const full = rebuild([parent, reused], base);
assert.deepStrictEqual(step.selected, full);
assert.deepStrictEqual(step.selected, [9]);
assert.ok(step.visits < resident.length + arrived.length);
assert.strictEqual(incremental(selected, resident, arrived, evicted, turned, base), null);

const cancelled = incremental(selected, resident, [{ id: 8, page: 8, generation: 1, parentId: null, cancelled: true }], [], base, base);
assert.deepStrictEqual(cancelled.selected, rebuild(resident.concat([{ id: 8, page: 8, generation: 1, parentId: null, cancelled: true }]), base));
assert.ok(!cancelled.selected.includes(8));

assert.deepStrictEqual(rebuild([], base), []);
assert.deepStrictEqual(rebuild([parent, child, { ...child, generation: 0 }], base), [2]);

console.log("VIEW_IDENTITY_OK");
