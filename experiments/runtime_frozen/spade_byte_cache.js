"use strict";

/** S3-FIFO data plane. Concurrent viewers widen the small queue. Separated viewers need two hits before promotion. */

const BURST_MS = 1000;
const WINDOW_MS = 5000;
const MIN_SAMPLES = 20;
const BURST_RATE = 0.2;
const RHO_QUIET = 0.1;
const RHO_BURST = 0.5;
const PROMOTE_QUIET = 2;
const PROMOTE_BURST = 1;

class SpadeByteCache {
  constructor(cap, maxEntries) {
    this.cap = cap;
    this.maxEntries = maxEntries;
    this.small = new Map();
    this.main = new Map();
    this.smallQ = [];
    this.mainQ = [];
    this.ghost = [];
    this.ghostSet = new Set();
    this.nbytes = 0;
    this.recent = [];
    this.last = new Map();
    this.onRho = null;
    this.burstRate = BURST_RATE;
    this.promoteAt = PROMOTE_BURST;
    this.setMode(RHO_QUIET, PROMOTE_BURST);
  }
  contract() {
    return {
      implementation: "spade_byte_cache.SpadeByteCache",
      data_plane: "S3-FIFO",
      burst_ms: BURST_MS,
      window_ms: WINDOW_MS,
      min_samples: MIN_SAMPLES,
      burst_rate_threshold: BURST_RATE,
      rho_quiet: RHO_QUIET,
      rho_burst: RHO_BURST,
      promote_quiet: PROMOTE_QUIET,
      promote_burst: PROMOTE_BURST,
      reorder_on_hit: false,
      uses_future_trace_frame: false,
      regime_label_used: false,
    };
  }
  setMode(rho, promoteAt) {
    const changed = this.smallFraction !== rho || this.promoteAt !== promoteAt;
    this.promoteAt = promoteAt;
    this.smallFraction = rho;
    this.smallByte = Math.max(1, Math.floor(this.cap * rho));
    this.smallEntries = Math.max(1, Math.floor(this.maxEntries * rho));
    if (changed && this.onRho) this.onRho({ small_fraction: rho, promote_at: promoteAt, small_bytes: this.smallByte, small_entries: this.smallEntries });
  }
  touch(obj) {
    obj.freq = Math.min(this.promoteAt, obj.freq + 1);
  }
  observe(key, meta) {
    const user = meta && meta.userId ? String(meta.userId) : "";
    const time = meta && Number.isFinite(meta.time) ? meta.time : 0;
    const prev = this.last.get(key);
    const burst = Boolean(prev && user && prev.user !== user && time - prev.time < BURST_MS && time >= prev.time);
    if (user) this.last.set(key, { time, user });
    this.recent.push({ time, burst });
    const cutoff = time - WINDOW_MS;
    while (this.recent.length && this.recent[0].time < cutoff) this.recent.shift();
    if (this.recent.length < MIN_SAMPLES) return;
    const rate = this.recent.filter((row) => row.burst).length / this.recent.length;
    if (rate > this.burstRate) this.setMode(RHO_BURST, PROMOTE_BURST);
    else this.setMode(RHO_QUIET, PROMOTE_QUIET);
  }
  lookup(key, meta) {
    this.observe(key, meta || {});
    if (this.small.has(key)) {
      this.touch(this.small.get(key));
      return this.small.get(key).data;
    }
    if (this.main.has(key)) {
      this.touch(this.main.get(key));
      return this.main.get(key).data;
    }
    return null;
  }
  remember(key) {
    if (this.ghostSet.has(key)) return;
    this.ghost.push(key);
    this.ghostSet.add(key);
    while (this.ghost.length > this.maxEntries) this.ghostSet.delete(this.ghost.shift());
  }
  forget(key) {
    this.ghostSet.delete(key);
    const index = this.ghost.indexOf(key);
    if (index >= 0) this.ghost.splice(index, 1);
  }
  evictSmall() {
    const key = this.smallQ.shift();
    const obj = this.small.get(key);
    this.small.delete(key);
    this.nbytes -= obj.nbytes;
    if (obj.freq >= this.promoteAt) {
      obj.freq = 0;
      this.main.set(key, obj);
      this.mainQ.push(key);
      this.nbytes += obj.nbytes;
      return null;
    }
    this.remember(key);
    return { key, nbytes: obj.nbytes, reason: "S3FIFO_SMALL" };
  }
  evictMain() {
    const key = this.mainQ.shift();
    const obj = this.main.get(key);
    this.main.delete(key);
    this.nbytes -= obj.nbytes;
    if (obj.freq >= this.promoteAt) {
      obj.freq = 0;
      this.main.set(key, obj);
      this.mainQ.push(key);
      this.nbytes += obj.nbytes;
      return null;
    }
    return { key, nbytes: obj.nbytes, reason: "S3FIFO_MAIN" };
  }
  admit(key, nbytes, data) {
    const evicted = [];
    const obj = { nbytes, freq: 0, data };
    if (this.ghostSet.has(key)) {
      this.main.set(key, obj);
      this.mainQ.push(key);
      this.forget(key);
    } else {
      this.small.set(key, obj);
      this.smallQ.push(key);
    }
    this.nbytes += nbytes;
    let guard = 0;
    while (this.nbytes > this.cap || this.small.size + this.main.size > this.maxEntries) {
      guard += 1;
      if (guard > 100000) throw new Error("SPADE_BYTE_EVICTION");
      if (this.small.size + this.main.size === 1 && this.nbytes > this.cap) break;
      let smallBytes = 0;
      for (const item of this.small.values()) smallBytes += item.nbytes;
      const smallOver = smallBytes > this.smallByte || this.small.size > this.smallEntries;
      let victim = null;
      if (this.smallQ.length && smallOver) victim = this.evictSmall();
      else if (this.mainQ.length) victim = this.evictMain();
      else if (this.smallQ.length) victim = this.evictSmall();
      else break;
      if (victim) evicted.push(victim);
    }
    return evicted;
  }
}

module.exports = { SpadeByteCache, BURST_MS, WINDOW_MS, MIN_SAMPLES, BURST_RATE, RHO_QUIET, RHO_BURST, PROMOTE_QUIET, PROMOTE_BURST };
