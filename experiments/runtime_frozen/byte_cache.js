"use strict";

const { SpadeCache } = require("./spade_byte_impl");

class ByteCache {
  constructor(cap, maxEntries) {
    this.inner = new SpadeCache(cap, maxEntries, { admitFraction: 0.1, maxRequesters: 16 });
  }

  lookup(key, meta) {
    const data = this.inner.get(key, meta && meta.userId, meta && meta.time);
    return data === undefined ? null : data;
  }

  admit(key, nbytes, data, meta) {
    const before = new Map();
    for (const [name, entry] of this.inner.cache) before.set(name, entry.size);
    this.inner.set(key, data, nbytes, meta && meta.userId, meta && meta.time);
    const evicted = [];
    for (const [name, size] of before) {
      if (!this.inner.cache.has(name)) evicted.push({ key: name, nbytes: size, reason: "SPADE_BYTE" });
    }
    return evicted;
  }
}

module.exports = { ByteCache };
