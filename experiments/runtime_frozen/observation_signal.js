"use strict";

function parseNums(value) {
  if (value == null || value === "") return null;
  const nums = String(value).split(",").map(Number);
  return nums.every((n) => Number.isFinite(n)) ? nums : null;
}

function parseRanges(value) {
  if (!value) return [];
  return String(value).split(",").filter(Boolean).map((part) => {
    const [a, b] = part.split("-");
    const start = Number(a);
    const end = Number(b);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return { start, end, bytes: end - start + 1, range_known: true };
  }).filter(Boolean);
}

function keyMatchesRange(cacheKey, range) {
  return String(cacheKey).endsWith(`|${range.start}-${range.end}`);
}

function observationFromHeaders(headers, now) {
  const present = headers["x-p5-obs-reason"] != null;
  return {
    received_ms: now,
    source: present ? "request_header" : "header_absent",
    pose: parseNums(headers["x-p5-pose"]),
    quaternion: parseNums(headers["x-p5-quat"]),
    fov: headers["x-p5-fov"] == null || headers["x-p5-fov"] === "" ? null : Number(headers["x-p5-fov"]),
    viewport: parseNums(headers["x-p5-vp"]),
    visible_splats: headers["x-p5-vis"] == null || headers["x-p5-vis"] === "" ? null : Number(headers["x-p5-vis"]),
    queued_unsent: parseRanges(headers["x-p5-queued"]),
    renderer_demand: parseRanges(headers["x-p5-demand"]),
    uses_future_trace_frame: headers["x-p5-future-frame"] === "1",
    header_present: present,
  };
}

function normalizePosted(body, now) {
  return {
    received_ms: now,
    source: "client_post",
    pose: body.camera_position || null,
    quaternion: body.quaternion || null,
    fov: body.fov == null ? null : Number(body.fov),
    viewport: body.viewport || null,
    visible_splats: body.visible_splats == null ? null : Number(body.visible_splats),
    queued_unsent: Array.isArray(body.queued_unsent) ? body.queued_unsent : [],
    renderer_demand: Array.isArray(body.renderer_demand) ? body.renderer_demand : [],
    uses_future_trace_frame: body.uses_future_trace_frame === true || Number(body.lookahead_ms) > 0,
    meta_ready: body.meta_ready === true,
    header_present: true,
  };
}

function shouldProtect(cacheKey, observations, now, selfUser) {
  for (const [user, obs] of observations) {
    if (user === selfUser) continue;
    if (!obs || obs.received_ms > now) continue;
    if (obs.uses_future_trace_frame) continue;
    for (const range of obs.queued_unsent || []) {
      if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end)) continue;
      if (keyMatchesRange(cacheKey, range)) {
        return { protect: true, user_id: user, received_ms: obs.received_ms, start: range.start, end: range.end };
      }
    }
  }
  return { protect: false, user_id: null, received_ms: null, start: null, end: null };
}

class SpadeQueueCache {
  constructor(cap, maxEntries, protectFn) {
    this.cap = cap;
    this.maxEntries = maxEntries;
    this.cache = new Map();
    this.order = [];
    this.nbytes = 0;
    this.protectFn = protectFn;
    this.protects = 0;
  }

  lookup(key) {
    if (!this.cache.has(key)) return null;
    const pos = this.order.indexOf(key);
    this.order.splice(pos, 1);
    this.order.push(key);
    return this.cache.get(key).data;
  }

  admit(key, nbytes, data) {
    const evicted = [];
    this.cache.set(key, { nbytes, data, queueProtected: false });
    this.order.push(key);
    this.nbytes += nbytes;
    while (this.nbytes > this.cap || this.cache.size > this.maxEntries) {
      if (this.order.length <= 1 && this.cache.get(this.order[0]).nbytes > this.cap) break;
      let victim = null;
      let skipped = false;
      for (let idx = 0; idx < this.order.length; idx += 1) {
        const candidate = this.order[idx];
        if (candidate === key) continue;
        const obj = this.cache.get(candidate);
        const another = this.order.some((other) => other !== key && other !== candidate);
        if (another && !obj.queueProtected && this.protectFn(candidate)) {
          obj.queueProtected = true;
          this.protects += 1;
          skipped = true;
          continue;
        }
        victim = candidate;
        break;
      }
      if (victim == null) victim = this.order.find((candidate) => candidate !== key) || this.order[0];
      const pos = this.order.indexOf(victim);
      this.order.splice(pos, 1);
      const size = this.cache.get(victim).nbytes;
      this.nbytes -= size;
      this.cache.delete(victim);
      evicted.push({
        key: victim,
        nbytes: size,
        reason: skipped ? "SPADE_Q_AFTER_QUEUED_PROTECT" : "SPADE_Q_LRU_HEAD",
      });
    }
    return evicted;
  }
}

module.exports = {
  parseRanges,
  observationFromHeaders,
  normalizePosted,
  shouldProtect,
  keyMatchesRange,
  SpadeQueueCache,
};
