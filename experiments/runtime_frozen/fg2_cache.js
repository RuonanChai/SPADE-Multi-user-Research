"use strict";

const { createCache } = require("./matched_cache");

const LAG_MIN_MS = 500;
const LAG_MAX_MS = 15000;
const SWITCH_LAG_MS = 5000;
const SWITCH_SAMPLES = 8;

class Fg2 {
  constructor(cap, maxEntries) {
    this.cap = cap;
    this.maxEntries = maxEntries;
    this.fifo = createCache("FIFO", cap, maxEntries);
    this.s3 = null;
    this.mode = "FIFO";
    this.first = new Map();
    this.lags = [];
  }

  note(key, meta) {
    if (!meta || !meta.userId || !Number.isFinite(meta.time)) return;
    const prev = this.first.get(key);
    if (!prev) {
      this.first.set(key, { user: meta.userId, time: meta.time });
      return;
    }
    if (prev.user === meta.userId) return;
    const lag = meta.time - prev.time;
    if (lag < LAG_MIN_MS || lag > LAG_MAX_MS) return;
    this.lags.push(lag);
    if (this.lags.length > SWITCH_SAMPLES) this.lags.shift();
  }

  maybeSwitch() {
    if (this.mode !== "FIFO" || this.lags.length < SWITCH_SAMPLES) return;
    const sorted = this.lags.slice().sort((left, right) => left - right);
    if (sorted[3] < SWITCH_LAG_MS) return;
    this.s3 = createCache("S3-FIFO", this.cap, this.maxEntries);
    const seen = new Set();
    for (const key of this.fifo.order) {
      if (seen.has(key) || !this.fifo.cache.has(key)) continue;
      seen.add(key);
      const obj = this.fifo.cache.get(key);
      this.s3.admit(key, obj.nbytes, obj.data);
    }
    this.mode = "S3-FIFO";
  }

  active() {
    return this.mode === "S3-FIFO" ? this.s3 : this.fifo;
  }

  lookup(key, meta) {
    this.note(key, meta);
    this.maybeSwitch();
    return this.active().lookup(key);
  }

  admit(key, nbytes, data, meta) {
    this.note(key, meta);
    this.maybeSwitch();
    return this.active().admit(key, nbytes, data) || [];
  }
}

module.exports = { Fg2, LAG_MIN_MS, LAG_MAX_MS, SWITCH_LAG_MS, SWITCH_SAMPLES };
