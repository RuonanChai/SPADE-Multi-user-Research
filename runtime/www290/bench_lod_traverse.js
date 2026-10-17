"use strict";

const fs = require("fs");
const { traverseLod, indexCapacity } = require("./lod_traverse");

function node(x, y, z, size, childStart, childCount) {
  return { x, y, z, size, childStart, childCount };
}

function buildQuaternary(depth) {
  const splats = [];
  function attach(index, depthLeft, size) {
    if (depthLeft === 0) return;
    const parent = splats[index];
    const childStart = splats.length;
    for (let child = 0; child < 4; child += 1) {
      splats.push(node(parent.x + (child - 1.5) * size, 0, parent.z + size, size * 0.5, 0, 0));
    }
    parent.childStart = childStart;
    parent.childCount = 4;
    for (let child = 0; child < 4; child += 1) attach(childStart + child, depthLeft - 1, size * 0.5);
  }
  splats.push(node(0, 0, 10, 64, 0, 0));
  attach(0, depth, 64);
  return splats;
}

function percentile(values, q) {
  const ordered = values.slice().sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.round(q * (ordered.length - 1)))];
}

function timeAlloc(length, repeats) {
  const source = new Uint32Array(length);
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const start = performance.now();
    const output = new Uint32Array(length);
    output.set(source);
    samples.push(performance.now() - start);
  }
  return { n: samples.length, p50_ms: percentile(samples, 0.5), p95_ms: percentile(samples, 0.95) };
}

const view = {
  origin: [0, 0, 0],
  forward: [0, 0, 1],
  lodScale: 1,
  behind: 0.2,
  coneFoveate: 0.4,
  coneDot0: Math.cos((45 * Math.PI) / 180),
  coneDot: Math.cos((60 * Math.PI) / 180),
};

const tree = buildQuaternary(8);
const pages = new Array(tree.length).fill(0);
const budget = traverseLod(tree, pages, view, 20000, 0);
const coarse = traverseLod(tree, pages, view, 20000, 1);
const capacity = indexCapacity(3750000);
const alloc = timeAlloc(capacity, 11);
const report = {
  tree_nodes: tree.length,
  budget_cut: { max_splats: 20000, pixel_limit: 0, output_n: budget.indices.length, counts: budget.counts },
  pixel_cut: { max_splats: 20000, pixel_limit: 1, output_n: coarse.indices.length, counts: coarse.counts },
  full_index_capacity: capacity,
  full_index_bytes: capacity * 4,
  alloc_and_copy: alloc,
  note: "JS reference of the Rust control flow, not the deployed wasm binary. Allocation is the per-call Uint32Array created before the wasm call returns.",
};
fs.writeFileSync("F:/WWW_N3_MUX/results/WWW290_WASM_PROFILE.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
