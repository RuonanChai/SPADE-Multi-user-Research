const assert = require("assert");
require("D:/Program/NSDI_SPADE_DIAG_W04/spark/examples/streaming-lod/draw_inclusion.js");
const { chunksInDraw } = globalThis;

const pageSplats = 65536;
const pageToChunk = [null, 10, 20];
const indices = [pageSplats, pageSplats + 3, pageSplats * 2, 0];

const drawn = chunksInDraw(indices, 3, pageSplats, pageToChunk);
assert.strictEqual(drawn.status, "MEASURED");
assert.deepStrictEqual(drawn.chunk_ids, [10, 20]);
assert.strictEqual(drawn.unmapped_splats, 0);

const prefix = chunksInDraw(indices, 1, pageSplats, pageToChunk);
assert.deepStrictEqual(prefix.chunk_ids, [10]);

const missing = chunksInDraw(null, 4, pageSplats, pageToChunk);
assert.strictEqual(missing.status, "NOT_INSTRUMENTED");
assert.strictEqual(missing.chunk_ids, null);

const unmapped = chunksInDraw([0], 1, pageSplats, pageToChunk);
assert.deepStrictEqual(unmapped.chunk_ids, []);
assert.strictEqual(unmapped.unmapped_splats, 1);
assert.notStrictEqual(unmapped.chunk_ids, 0);

const empty = chunksInDraw([], 0, pageSplats, pageToChunk);
assert.strictEqual(empty.status, "MEASURED");
assert.deepStrictEqual(empty.chunk_ids, []);

const demanded = chunksInDraw([pageSplats * 3], 1, pageSplats, [null, null, null, 7]);
assert.deepStrictEqual(demanded.chunk_ids, [7]);

const recycled = chunksInDraw(
  [pageSplats * 3],
  1,
  pageSplats,
  [null, null, null, { chunk: 9, generation: 2 }],
  [null, null, null, 1]
);
assert.deepStrictEqual(recycled.chunk_ids, []);
assert.strictEqual(recycled.stale_splats, 1);

const sameCount = chunksInDraw([pageSplats, pageSplats * 2], 2, pageSplats, [null, 1, 2]);
const changedIdentity = chunksInDraw([pageSplats, pageSplats * 2], 2, pageSplats, [null, 1, 3]);
assert.strictEqual(sameCount.chunk_ids.length, changedIdentity.chunk_ids.length);
assert.notDeepStrictEqual(sameCount.chunk_ids, changedIdentity.chunk_ids);

const uploadedButHidden = chunksInDraw([pageSplats], 1, pageSplats, [null, 7, 8]);
assert.deepStrictEqual(uploadedButHidden.chunk_ids, [7]);
assert.ok(!uploadedButHidden.chunk_ids.includes(8));

const current = chunksInDraw(
  [pageSplats * 3],
  1,
  pageSplats,
  [null, null, null, { chunk: 9, generation: 2 }],
  [null, null, null, 2]
);
assert.deepStrictEqual(current.chunk_ids, [9]);
assert.strictEqual(current.stale_splats, 0);

console.log("DRAW_INCLUSION_OK");
