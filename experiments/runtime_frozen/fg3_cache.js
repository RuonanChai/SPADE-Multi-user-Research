"use strict";

const { createCache } = require("./matched_cache");

class Fg3 {
  constructor(cap, maxEntries, regime) {
    if (regime === "synchronized") this.mode = "FIFO";
    else if (regime === "staggered") this.mode = "S3-FIFO";
    else throw new Error("FG3_REGIME_UNKNOWN");
    this.cache = createCache(this.mode, cap, maxEntries);
  }

  lookup(key) {
    return this.cache.lookup(key);
  }

  admit(key, nbytes, data) {
    return this.cache.admit(key, nbytes, data) || [];
  }
}

module.exports = { Fg3 };
