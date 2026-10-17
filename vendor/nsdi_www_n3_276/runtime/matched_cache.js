"use strict";

/** Replay-matched LRU, SIEVE, and S3-FIFO. No future access. */

class Sieve {
  constructor(cap, maxEntries) {
    this.cap = cap;
    this.maxEntries = maxEntries;
    this.cache = new Map();
    this.order = [];
    this.hand = null;
    this.nbytes = 0;
  }
  lookup(key) {
    const obj = this.cache.get(key);
    if (!obj) return null;
    obj.visited = 1;
    return obj.data;
  }
  admit(key, nbytes, data) {
    const evicted = [];
    this.cache.set(key, { nbytes, visited: 0, data });
    this.order.push(key);
    this.nbytes += nbytes;
    while (this.nbytes > this.cap || this.cache.size > this.maxEntries) {
      if (this.cache.size === 1 && this.nbytes > this.cap) break;
      evicted.push(this.evictOne());
    }
    return evicted;
  }
  evictOne() {
    if (this.hand === null || !this.cache.has(this.hand)) this.hand = this.order[0];
    let guard = 0;
    while (true) {
      guard += 1;
      if (guard > this.order.length + 2) throw new Error("sieve hand failed");
      const obj = this.cache.get(this.hand);
      const pos = this.order.indexOf(this.hand);
      const nxt = pos + 1 < this.order.length ? this.order[pos + 1] : null;
      if (obj.visited) {
        obj.visited = 0;
        this.hand = nxt !== null ? nxt : this.order[0];
        continue;
      }
      this.order.splice(pos, 1);
      this.nbytes -= this.cache.get(this.hand).nbytes;
      const victim = this.hand;
      const size = this.cache.get(victim).nbytes;
      this.cache.delete(victim);
      this.hand = nxt !== null && this.cache.has(nxt) ? nxt : (this.order[0] || null);
      return { key: victim, nbytes: size };
    }
  }
}

class S3Fifo {
  constructor(cap, maxEntries) {
    this.cap = cap;
    this.maxEntries = maxEntries;
    this.smallByte = Math.max(1, Math.floor(cap * 0.1));
    this.smallEntries = Math.max(1, Math.floor(maxEntries * 0.1));
    this.small = new Map();
    this.main = new Map();
    this.smallQ = [];
    this.mainQ = [];
    this.ghost = [];
    this.ghostSet = new Set();
    this.ghostLimit = maxEntries;
    this.nbytes = 0;
  }
  lookup(key) {
    if (this.small.has(key)) {
      this.small.get(key).freq = 1;
      return this.small.get(key).data;
    }
    if (this.main.has(key)) {
      this.main.get(key).freq = 1;
      return this.main.get(key).data;
    }
    return null;
  }
  remember(key) {
    if (this.ghostSet.has(key)) return;
    this.ghost.push(key);
    this.ghostSet.add(key);
    while (this.ghost.length > this.ghostLimit) this.ghostSet.delete(this.ghost.shift());
  }
  forget(key) {
    this.ghostSet.delete(key);
    const idx = this.ghost.indexOf(key);
    if (idx >= 0) this.ghost.splice(idx, 1);
  }
  evictSmall() {
    const key = this.smallQ.shift();
    const obj = this.small.get(key);
    this.small.delete(key);
    this.nbytes -= obj.nbytes;
    if (obj.freq > 0) {
      obj.freq = 0;
      this.main.set(key, obj);
      this.mainQ.push(key);
      this.nbytes += obj.nbytes;
      return null;
    }
    this.remember(key);
    return { key, nbytes: obj.nbytes };
  }
  evictMain() {
    const key = this.mainQ.shift();
    const obj = this.main.get(key);
    this.main.delete(key);
    this.nbytes -= obj.nbytes;
    if (obj.freq > 0) {
      obj.freq = 0;
      this.main.set(key, obj);
      this.mainQ.push(key);
      this.nbytes += obj.nbytes;
      return null;
    }
    return { key, nbytes: obj.nbytes };
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
      if (guard > 100000) throw new Error("s3fifo eviction did not converge");
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

class Lru {
  constructor(cap, maxEntries) {
    this.cap = cap;
    this.maxEntries = maxEntries;
    this.cache = new Map();
    this.order = [];
    this.nbytes = 0;
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
    this.cache.set(key, { nbytes, data });
    this.order.push(key);
    this.nbytes += nbytes;
    while (this.nbytes > this.cap || this.cache.size > this.maxEntries) {
      if (this.order.length <= 1 && this.cache.get(this.order[0]).nbytes > this.cap) break;
      const victim = this.order.shift();
      const size = this.cache.get(victim).nbytes;
      this.nbytes -= size;
      this.cache.delete(victim);
      evicted.push({ key: victim, nbytes: size });
    }
    return evicted;
  }
}

function createCache(policy, cap, maxEntries) {
  if (policy === "LRU") return new Lru(cap, maxEntries);
  if (policy === "SIEVE") return new Sieve(cap, maxEntries);
  if (policy === "S3-FIFO") return new S3Fifo(cap, maxEntries);
  throw new Error(`unknown policy ${policy}`);
}

function replayOutcomes(policy, reqs, cap, maxEntries) {
  const cache = createCache(policy, cap, maxEntries);
  const outcomes = [];
  let origin = 0;
  for (const req of reqs) {
    if (cache.lookup(req.key) !== null) outcomes.push("hit");
    else {
      outcomes.push("miss");
      origin += req.nbytes;
      cache.admit(req.key, req.nbytes, 1);
    }
  }
  return { origin, outcomes };
}

module.exports = { createCache, replayOutcomes };

if (require.main === module) {
  const fs = require("fs");
  const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const result = replayOutcomes(input.policy, input.reqs, input.cap, input.entries);
  process.stdout.write(JSON.stringify({ origin: result.origin, outcomes: result.outcomes }));
}
