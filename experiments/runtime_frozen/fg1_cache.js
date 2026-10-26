"use strict";

const MAIN_BYTES = 8 * 1024 * 1024;
const MAIN_ENTRIES = 16;
const GHOST_LIMIT = 100;
const GHOST_TTL_MS = 60 * 1000;
const MIN_LAG_MS = 500;
const MAX_LAG_MS = 15 * 1000;

function strongEtag(value) {
  return typeof value === "string" && value.length > 0 && !value.startsWith("W/");
}

function ghostRecordBytes(entry) {
  return Buffer.byteLength(JSON.stringify({
    key: entry.key,
    etag: entry.etag,
    firstTs: entry.firstTs,
    firstUser: entry.firstUser,
    evictTs: entry.evictTs,
  }));
}

class Fg1 {
  constructor(cap, maxEntries, options = {}) {
    this.cap = cap;
    this.maxEntries = maxEntries;
    this.enabled = options.enabled !== false;
    this.cold = new Map();
    this.coldQ = [];
    this.main = new Map();
    this.mainQ = [];
    this.nbytes = 0;
    this.ghost = [];
    this.stats = {
      promotions: 0,
      demotions: 0,
      ghost_readmits: 0,
      ghost_origin_bytes: 0,
      rejected_promotions: 0,
      metadata_bytes: 0,
    };
  }

  residentCount() {
    return this.cold.size + this.main.size;
  }

  mainBytes() {
    let total = 0;
    for (const obj of this.main.values()) total += obj.nbytes;
    return total;
  }

  recomputeMetadata() {
    let total = 0;
    for (const entry of this.ghost) total += ghostRecordBytes(entry);
    this.stats.metadata_bytes = total;
    return total;
  }

  expireGhost(now) {
    this.ghost = this.ghost.filter((entry) => now - entry.evictTs <= GHOST_TTL_MS);
    this.recomputeMetadata();
  }

  findGhost(key, etag) {
    for (let i = this.ghost.length - 1; i >= 0; i -= 1) {
      const entry = this.ghost[i];
      if (entry.key === key && entry.etag === etag) return entry;
    }
    return null;
  }

  dropGhost(key) {
    this.ghost = this.ghost.filter((entry) => entry.key !== key);
    this.recomputeMetadata();
  }

  rememberGhost(key, obj, now) {
    if (!this.enabled || !strongEtag(obj.etag) || !obj.versionProven) return;
    this.expireGhost(now);
    this.dropGhost(key);
    this.ghost.push({
      key,
      etag: obj.etag,
      firstTs: obj.firstTs,
      firstUser: obj.firstUser,
      evictTs: now,
    });
    while (this.ghost.length > GHOST_LIMIT) this.ghost.shift();
    this.recomputeMetadata();
  }

  lagOk(firstTs, time) {
    const lag = time - firstTs;
    return lag >= MIN_LAG_MS && lag <= MAX_LAG_MS;
  }

  secondTouch(obj, meta) {
    if (!this.enabled || !meta || meta.inflight) return false;
    if (!meta.userId || !obj.firstUser || meta.userId === obj.firstUser) return false;
    if (!strongEtag(obj.etag) || !obj.versionProven) return false;
    if (meta.etag && meta.etag !== obj.etag) return false;
    if (!meta.etag && meta.residentHit !== true) return false;
    return this.lagOk(obj.firstTs, meta.time);
  }

  mainHasRoom(nbytes) {
    return this.main.size + 1 <= MAIN_ENTRIES && this.mainBytes() + nbytes <= MAIN_BYTES;
  }

  removeFromQueue(queue, key) {
    const index = queue.indexOf(key);
    if (index >= 0) queue.splice(index, 1);
  }

  promote(key) {
    const obj = this.cold.get(key);
    if (!obj) return false;
    if (!this.mainHasRoom(obj.nbytes)) {
      this.stats.rejected_promotions += 1;
      return false;
    }
    this.removeFromQueue(this.coldQ, key);
    this.cold.delete(key);
    obj.queue = "main";
    obj.promotedTs = obj.lastTs;
    this.main.set(key, obj);
    this.mainQ.push(key);
    this.stats.promotions += 1;
    return true;
  }

  demoteExpired(now) {
    if (!this.enabled) return;
    const keep = [];
    for (const key of this.mainQ) {
      const obj = this.main.get(key);
      if (obj && obj.promotedTs != null && now - obj.promotedTs > MAX_LAG_MS) {
        this.main.delete(key);
        obj.queue = "cold";
        obj.promotedTs = null;
        this.cold.set(key, obj);
        this.coldQ.push(key);
        this.stats.demotions += 1;
      } else keep.push(key);
    }
    this.mainQ = keep;
  }

  note(key, obj, meta) {
    if (!meta || meta.inflight) return;
    if (!obj.firstUser && meta.userId) {
      obj.firstUser = meta.userId;
      obj.firstTs = meta.time;
    }
    if (meta.userId) obj.viewers.add(meta.userId);
    obj.lastTs = meta.time;
    if (meta.etag && strongEtag(meta.etag)) obj.etag = obj.etag || meta.etag;
    if (meta.versionProven === true) obj.versionProven = true;
    if (obj.queue === "cold" && this.secondTouch(obj, Object.assign({ residentHit: true }, meta))) this.promote(key);
  }

  lookup(key, meta) {
    this.demoteExpired(meta && meta.time || 0);
    const cold = this.cold.get(key);
    if (cold) {
      this.note(key, cold, meta);
      return cold.data;
    }
    const main = this.main.get(key);
    if (main) {
      this.note(key, main, meta);
      return main.data;
    }
    return null;
  }

  takeOldest(queue, map, reason, now) {
    while (queue.length && !map.has(queue[0])) queue.shift();
    if (!queue.length) return null;
    const key = queue.shift();
    const obj = map.get(key);
    map.delete(key);
    this.nbytes -= obj.nbytes;
    this.rememberGhost(key, obj, now);
    const fifoReason = !this.enabled ? "FIFO_OLDEST" : reason;
    return { key, nbytes: obj.nbytes, reason: fifoReason };
  }

  evictUntilFit(evicted, now) {
    let guard = 0;
    while (this.nbytes > this.cap || this.residentCount() > this.maxEntries) {
      guard += 1;
      if (guard > 100000) throw new Error("fg1 eviction did not converge");
      if (this.residentCount() === 1 && this.nbytes > this.cap) break;
      if (this.coldQ.length) {
        const victim = this.takeOldest(this.coldQ, this.cold, "FG1_COLD_OLDEST", now);
        if (victim) evicted.push(victim);
      } else if (this.mainQ.length) {
        const victim = this.takeOldest(this.mainQ, this.main, "FG1_MAIN_OLDEST", now);
        if (victim) evicted.push(victim);
      } else break;
    }
  }

  dropExisting(key) {
    if (this.cold.has(key)) {
      this.nbytes -= this.cold.get(key).nbytes;
      this.cold.delete(key);
      this.removeFromQueue(this.coldQ, key);
    }
    if (this.main.has(key)) {
      this.nbytes -= this.main.get(key).nbytes;
      this.main.delete(key);
      this.removeFromQueue(this.mainQ, key);
    }
  }

  admit(key, nbytes, data, meta) {
    const now = meta && Number.isFinite(meta.time) ? meta.time : 0;
    this.demoteExpired(now);
    this.expireGhost(now);
    this.dropExisting(key);
    const info = meta || {};
    const etag = strongEtag(info.etag) ? info.etag : null;
    const ghost = this.enabled && etag && info.versionProven === true && !info.inflight
      ? this.findGhost(key, etag) : null;
    const ghostOk = !!(ghost && info.userId && ghost.firstUser && info.userId !== ghost.firstUser && this.lagOk(ghost.firstTs, now));
    const toMain = ghostOk && this.mainHasRoom(nbytes);
    const obj = {
      nbytes,
      data,
      etag,
      versionProven: info.versionProven === true && !!etag,
      firstUser: info.userId || null,
      firstTs: ghostOk ? ghost.firstTs : now,
      lastTs: now,
      promotedTs: toMain ? now : null,
      viewers: new Set(info.userId ? [info.userId] : []),
      queue: toMain ? "main" : "cold",
    };
    if (toMain) {
      this.main.set(key, obj);
      this.mainQ.push(key);
      this.dropGhost(key);
      this.stats.ghost_readmits += 1;
      this.stats.ghost_origin_bytes += nbytes;
    } else {
      this.cold.set(key, obj);
      this.coldQ.push(key);
    }
    this.nbytes += nbytes;
    const evicted = [];
    this.evictUntilFit(evicted, now);
    return evicted;
  }

  snapshot() {
    return {
      nbytes: this.nbytes,
      objects: this.residentCount(),
      cold_objects: this.cold.size,
      main_objects: this.main.size,
      main_bytes: this.mainBytes(),
      ghost_keys: this.ghost.length,
      metadata_bytes: this.stats.metadata_bytes,
      promotions: this.stats.promotions,
      demotions: this.stats.demotions,
      ghost_readmits: this.stats.ghost_readmits,
      ghost_origin_bytes: this.stats.ghost_origin_bytes,
      rejected_promotions: this.stats.rejected_promotions,
    };
  }
}

module.exports = {
  Fg1,
  MAIN_BYTES,
  MAIN_ENTRIES,
  GHOST_LIMIT,
  GHOST_TTL_MS,
  MIN_LAG_MS,
  MAX_LAG_MS,
};
