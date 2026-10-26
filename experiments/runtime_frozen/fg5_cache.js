"use strict";

const { createCache } = require("./matched_cache");

class Fg5 {
  constructor(cap, maxEntries, regime) {
    if (regime === "synchronized") this.mode = "FIFO";
    else if (regime === "staggered") this.mode = "S3-FIFO";
    else throw new Error("FG5_REGIME_UNKNOWN");
    this.regime = regime;
    this.cache = createCache(this.mode, cap, maxEntries);
  }

  lookup(key) {
    return this.cache.lookup(key);
  }

  admit(key, nbytes, data) {
    return this.cache.admit(key, nbytes, data) || [];
  }
}

module.exports = { Fg5 };
