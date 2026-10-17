"use strict";

const MISSING = 0xffffffff;

function pixelScale(splat, view) {
  const dx = splat.x - view.origin[0];
  const dy = splat.y - view.origin[1];
  const dz = splat.z - view.origin[2];
  const distance = Math.max(Math.hypot(dx, dy, dz), 1e-6);
  const inv = 1 / distance;
  let scale = splat.size * inv * view.lodScale;
  const forwardDot = dx * view.forward[0] + dy * view.forward[1] + dz * view.forward[2];
  let foveate;
  if (forwardDot <= 0) {
    foveate = view.behind;
  } else {
    const dot = forwardDot * inv;
    if (dot >= view.coneDot0) foveate = 1;
    else if (dot >= view.coneDot) {
      const t = (dot - view.coneDot) / (view.coneDot0 - view.coneDot);
      foveate = view.coneFoveate + (1 - view.coneFoveate) * t;
    } else {
      const t = dot / view.coneDot;
      foveate = view.behind + (view.coneFoveate - view.behind) * t;
    }
  }
  return foveate * scale;
}

function higher(a, b) {
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] > b[2];
}

function heapPush(heap, item) {
  heap.push(item);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (!higher(heap[index], heap[parent])) break;
    const swap = heap[parent];
    heap[parent] = heap[index];
    heap[index] = swap;
    index = parent;
  }
}

function heapPop(heap) {
  const last = heap.pop();
  if (heap.length === 0) return last;
  const root = heap[0];
  heap[0] = last;
  let index = 0;
  for (;;) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    let best = left;
    const right = left + 1;
    if (right < heap.length && higher(heap[right], heap[best])) best = right;
    if (!higher(heap[best], heap[index])) break;
    const swap = heap[index];
    heap[index] = heap[best];
    heap[best] = swap;
    index = best;
  }
  return root;
}

function traverseLod(splats, chunkToPage, view, maxSplats, pixelLimit) {
  const counts = {
    pixel_evals: 0,
    expanded: 0,
    leaf_emitted: 0,
    resident_rejected: 0,
    budget_stopped: 0,
    below_limit_emitted: 0,
    frontier_pushed: 0,
    frontier_popped: 0,
    frontier_max: 0,
    frontier_drained: 0,
  };
  const heap = [];
  const output = [];
  const root = splats[0];
  counts.pixel_evals += 1;
  heapPush(heap, [pixelScale(root, view), 0, 0]);
  counts.frontier_pushed += 1;
  let numSplats = 1;

  while (heap.length > 0) {
    const [scale, inst, index] = heap[0];
    if (scale <= pixelLimit) break;
    const splat = splats[index];
    if (splat.childCount === 0) {
      heapPop(heap);
      counts.frontier_popped += 1;
      output.push(index);
      counts.leaf_emitted += 1;
      continue;
    }
    const nextCount = numSplats - 1 + splat.childCount;
    if (nextCount > maxSplats) {
      counts.budget_stopped += 1;
      break;
    }
    heapPop(heap);
    counts.frontier_popped += 1;
    counts.expanded += 1;
    const firstChunk = splat.childStart >>> 16;
    const lastChunk = (splat.childStart + splat.childCount - 1) >>> 16;
    if (lastChunk >= chunkToPage.length || chunkToPage[firstChunk] === MISSING || chunkToPage[lastChunk] === MISSING) {
      output.push(index);
      counts.resident_rejected += 1;
      continue;
    }
    for (let child = splat.childStart; child < splat.childStart + splat.childCount; child += 1) {
      const childChunk = child >>> 16;
      const page = chunkToPage[childChunk];
      const paged = (page << 16) | (child & 0xffff);
      const childScale = pixelScale(splats[paged], view);
      counts.pixel_evals += 1;
      if (childScale <= pixelLimit) {
        output.push(paged);
        counts.below_limit_emitted += 1;
      } else {
        heapPush(heap, [childScale, inst, paged]);
        counts.frontier_pushed += 1;
        if (heap.length > counts.frontier_max) counts.frontier_max = heap.length;
      }
    }
    numSplats = nextCount;
  }
  while (heap.length > 0) {
    output.push(heapPop(heap)[2]);
    counts.frontier_drained += 1;
  }
  return { indices: output, counts };
}

function indexCapacity(numSplats) {
  const rows = Math.ceil(numSplats / 16384);
  return rows * 16384;
}

module.exports = { traverseLod, pixelScale, indexCapacity, MISSING };
