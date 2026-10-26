"use strict";

const C = require("./constants");

function upperMedian(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function floorProduct(factors, divisors) {
  let numerator = 1n;
  for (const factor of factors) numerator *= BigInt(Math.floor(factor));
  let denominator = 1n;
  for (const divisor of divisors) denominator *= BigInt(Math.floor(divisor));
  if (denominator <= 0n) return 0;
  return Number(numerator / denominator);
}

class S3Frontier {
  constructor(options = {}) {
    this.cap = options.capacityBytes == null ? C.CAPACITY_BYTES : options.capacityBytes;
    this.maxEntries = options.capacityEntries == null ? C.CAPACITY_ENTRIES : options.capacityEntries;
    this.smallByte = Math.max(1, Math.floor(this.cap * 0.1));
    this.smallEntries = Math.max(1, Math.floor(this.maxEntries * 0.1));
    this.frontierShield = options.frontierShield !== false;
    this.opportunityVeto = options.opportunityVeto !== false;
    this.viewersAllowed = new Set(options.viewers || C.VIEWERS);
    this.small = new Map();
    this.main = new Map();
    this.smallQ = [];
    this.mainQ = [];
    this.ghost = [];
    this.ghostSet = new Set();
    this.ghostLimit = this.maxEntries;
    this.nbytes = 0;
    this.viewerRings = new Map();
    this.pairs = new Map();
    this.lastTime = null;
    this.demandSeq = 0;
    this.overrideSeqs = [];
    this.evictedAt = new Map();
    this.stats = {
      anchors_created: 0,
      anchors_rejected_stale: 0,
      shields_created: 0,
      follower_hits: 0,
      follower_hit_bytes: 0,
      victim_refetch_bytes: 0,
    };
  }

  crossScore(bytes, anchors, eta) {
    if (!(anchors >= C.MIN_ANCHORS) || !(eta > 0 && eta <= C.MAX_LAG_MS)) return 0;
    return floorProduct(
      [bytes, Math.min(8, anchors), C.MAX_LAG_MS - eta, this.cap],
      [anchors + 4, C.MAX_LAG_MS, this.cap],
    );
  }

  timeOk(time) {
    if (!Number.isInteger(time)) return false;
    if (this.lastTime != null && time < this.lastTime) return false;
    this.lastTime = time;
    return true;
  }

  ring(viewer) {
    if (!this.viewerRings.has(viewer)) this.viewerRings.set(viewer, []);
    return this.viewerRings.get(viewer);
  }

  prune(now) {
    for (const [id, anchors] of this.pairs) {
      const kept = anchors.filter((anchor) => anchor.followerTime >= now - C.LOOKBACK_MS && anchor.leaderTime >= now - C.LOOKBACK_MS);
      this.stats.anchors_rejected_stale += anchors.length - kept.length;
      this.pairs.set(id, kept);
    }
    for (const ring of this.viewerRings.values()) {
      for (let index = ring.length - 1; index >= 0; index -= 1) {
        if (now - ring[index].firstTime > C.LOOKBACK_MS) ring.splice(index, 1);
      }
    }
  }

  rememberRequest(viewer, key, time) {
    const ring = this.ring(viewer);
    const existing = ring.find((item) => item.key === key);
    if (existing) return existing;
    ring.push({ key, firstTime: time });
    while (ring.length > C.VIEWER_RING) ring.shift();
    return ring[ring.length - 1];
  }

  firstRequest(viewer, key, now) {
    const row = this.ring(viewer).find((item) => item.key === key);
    if (!row || now - row.firstTime > C.LOOKBACK_MS) return null;
    return row;
  }

  pair(leader, follower) {
    const id = `${leader}>${follower}`;
    if (!this.pairs.has(id)) this.pairs.set(id, []);
    return this.pairs.get(id);
  }

  addAnchor(leader, follower, key, leaderTime, followerTime) {
    const lag = followerTime - leaderTime;
    if (!(lag > 0 && lag <= C.MAX_LAG_MS) || lag > C.LOOKBACK_MS) return false;
    const anchors = this.pair(leader, follower);
    if (anchors.some((anchor) => anchor.key === key && followerTime - anchor.followerTime <= C.LOOKBACK_MS)) return false;
    anchors.push({ key, lag, leaderTime, followerTime });
    while (anchors.length > C.ANCHOR_CAP) anchors.shift();
    this.stats.anchors_created += 1;
    return true;
  }

  observeAnchors(viewer, key, time, strong) {
    if (strong !== true) return;
    this.prune(time);
    for (const other of this.viewersAllowed) {
      if (other === viewer) continue;
      const prior = this.firstRequest(other, key, time);
      if (prior && prior.firstTime < time) this.addAnchor(other, viewer, key, prior.firstTime, time);
    }
  }

  anchorsValid(anchors, leader, follower, now) {
    const fresh = anchors.filter((anchor) => anchor.followerTime >= now - C.LOOKBACK_MS);
    if (fresh.length < C.MIN_ANCHORS) return false;
    const keys = fresh.slice(-C.MIN_ANCHORS).map((anchor) => anchor.key);
    const leaderKeys = this.ring(leader).map((item) => item.key);
    const followerKeys = this.ring(follower).map((item) => item.key);
    let leaderAt = -1;
    let followerAt = -1;
    for (const key of keys) {
      const nextLeader = leaderKeys.indexOf(key, leaderAt + 1);
      const nextFollower = followerKeys.indexOf(key, followerAt + 1);
      if (nextLeader < 0 || nextFollower < 0) return false;
      leaderAt = nextLeader;
      followerAt = nextFollower;
    }
    return true;
  }

  lagStats(anchors, now) {
    const fresh = anchors.filter((anchor) => anchor.followerTime >= now - C.LOOKBACK_MS && anchor.lag > 0);
    if (!fresh.length) return null;
    const lags = fresh.map((anchor) => anchor.lag);
    const median = upperMedian(lags);
    const mad = upperMedian(lags.map((lag) => Math.abs(lag - median)));
    if (mad * 2 > median) return null;
    return { median, anchors: fresh.length };
  }

  find(state, key) {
    if (state.small.has(key)) return state.small.get(key);
    if (state.main.has(key)) return state.main.get(key);
    return null;
  }

  pendingFor(state, key, now) {
    this.prune(now);
    let best = null;
    for (const [id, anchors] of this.pairs) {
      if (!this.anchorsValid(anchors, ...id.split(">"), now)) continue;
      const [leader, follower] = id.split(">");
      const leaderSeen = this.firstRequest(leader, key, now);
      if (!leaderSeen || this.firstRequest(follower, key, now)) continue;
      const stats = this.lagStats(anchors, now);
      if (!stats) continue;
      const eta = stats.median - (now - leaderSeen.firstTime);
      if (!(eta > 0 && eta <= C.MAX_LAG_MS)) continue;
      const resident = this.find(state, key);
      const cross = resident ? this.crossScore(resident.nbytes, stats.anchors, eta) : 0;
      if (!best || cross > best.cross || (cross === best.cross && eta < best.eta) || (cross === best.cross && eta === best.eta && follower < best.follower)) {
        best = { leader, follower, eta, cross, anchors: stats.anchors };
      }
    }
    return best;
  }

  remember(state, key) {
    if (state.ghostSet.has(key)) return;
    state.ghost.push(key);
    state.ghostSet.add(key);
    while (state.ghost.length > state.ghostLimit) state.ghostSet.delete(state.ghost.shift());
  }

  forget(state, key) {
    state.ghostSet.delete(key);
    const index = state.ghost.indexOf(key);
    if (index >= 0) state.ghost.splice(index, 1);
  }

  blank() {
    return {
      small: new Map(),
      main: new Map(),
      smallQ: [],
      mainQ: [],
      ghost: [],
      ghostSet: new Set(),
      ghostLimit: this.ghostLimit,
      nbytes: 0,
      seenSkip: new Set(),
    };
  }

  cloneState() {
    const state = this.blank();
    for (const [key, obj] of this.small) state.small.set(key, { nbytes: obj.nbytes, freq: obj.freq, token: obj.token ? { until: obj.token.until, follower: obj.token.follower } : null, tokenUsed: obj.tokenUsed === true });
    for (const [key, obj] of this.main) state.main.set(key, { nbytes: obj.nbytes, freq: obj.freq, token: obj.token ? { until: obj.token.until, follower: obj.token.follower } : null, tokenUsed: obj.tokenUsed === true });
    state.smallQ = this.smallQ.slice();
    state.mainQ = this.mainQ.slice();
    state.ghost = this.ghost.slice();
    state.ghostSet = new Set(this.ghostSet);
    state.nbytes = this.nbytes;
    return state;
  }

  commit(state) {
    this.small = state.small;
    this.main = state.main;
    this.smallQ = state.smallQ;
    this.mainQ = state.mainQ;
    this.ghost = state.ghost;
    this.ghostSet = state.ghostSet;
    this.nbytes = state.nbytes;
  }

  protectedBytes(state) {
    let bytes = 0;
    let count = 0;
    for (const obj of [...state.small.values(), ...state.main.values()]) {
      if (!obj.token) continue;
      bytes += obj.nbytes;
      count += 1;
    }
    return { bytes, count };
  }

  discard(state, key, reason) {
    const small = state.small.get(key);
    if (small) {
      const index = state.smallQ.indexOf(key);
      if (index >= 0) state.smallQ.splice(index, 1);
      state.small.delete(key);
      state.nbytes -= small.nbytes;
      this.remember(state, key);
      return { key, nbytes: small.nbytes, reason };
    }
    const main = state.main.get(key);
    if (!main || main.freq > 0) return null;
    const index = state.mainQ.indexOf(key);
    if (index >= 0) state.mainQ.splice(index, 1);
    state.main.delete(key);
    state.nbytes -= main.nbytes;
    return { key, nbytes: main.nbytes, reason };
  }

  trySpare(state, key, obj, now) {
    if (!this.frontierShield || obj.tokenUsed) return null;
    const pending = this.pendingFor(state, key, now);
    if (!pending || pending.cross <= 0) return null;
    const retained = this.protectedBytes(state);
    const recent = this.overrideSeqs.filter((seq) => this.demandSeq - seq < C.TRAILING).length;
    if (obj.token || retained.bytes + obj.nbytes > C.MAX_RETAINED || retained.count >= C.MAX_PROTECTED || recent >= C.MAX_OVERRIDES) return null;
    const scan = [];
    for (const other of state.smallQ) {
      const item = state.small.get(other);
      if (item && item.freq === 0 && !(item.token && item.token.until > now)) scan.push(other);
      if (scan.length >= C.VICTIM_SCAN) break;
    }
    if (scan.length < C.VICTIM_SCAN) {
      for (const other of state.mainQ) {
        const item = state.main.get(other);
        if (item && item.freq === 0 && !(item.token && item.token.until > now)) scan.push(other);
        if (scan.length >= C.VICTIM_SCAN) break;
      }
    }
    let victim = null;
    let victimCross = 0;
    for (const other of scan) {
      const score = this.pendingFor(state, other, now);
      const cross = score ? score.cross : 0;
      if (!victim || cross < victimCross) {
        victim = other;
        victimCross = cross;
      }
    }
    if (!victim) return null;
    const victimObj = this.find(state, victim);
    const gap = pending.cross - victimCross;
    const costOk = !this.opportunityVeto || (pending.cross >= 2 * victimCross && gap >= Math.floor(Math.min(obj.nbytes, victimObj.nbytes) / 4));
    if (!costOk) return null;
    const removed = this.discard(state, victim, "R4_S3_SHIELD");
    if (!removed) return null;
    obj.token = { until: Math.min(now + C.PROTECT_TTL_MS, now + pending.eta + C.PROTECT_EXTRA_MS), follower: pending.follower };
    obj.tokenUsed = true;
    state.smallQ.push(key);
    this.overrideSeqs.push(this.demandSeq);
    this.stats.shields_created += 1;
    return removed;
  }

  evictSmall(state, now) {
    const key = state.smallQ.shift();
    const obj = state.small.get(key);
    if (!obj) return null;
    if (obj.freq > 0) {
      state.small.delete(key);
      state.nbytes -= obj.nbytes;
      obj.freq = 0;
      state.main.set(key, obj);
      state.mainQ.push(key);
      state.nbytes += obj.nbytes;
      return null;
    }
    if (obj.token && obj.token.until > now && !state.seenSkip.has(key)) {
      state.seenSkip.add(key);
      state.smallQ.push(key);
      return { skipped: true };
    }
    const spared = this.trySpare(state, key, obj, now);
    if (spared) return spared;
    state.small.delete(key);
    state.nbytes -= obj.nbytes;
    this.remember(state, key);
    return { key, nbytes: obj.nbytes, reason: "S3FIFO_SMALL" };
  }

  evictMain(state) {
    const key = state.mainQ.shift();
    const obj = state.main.get(key);
    if (!obj) return null;
    state.main.delete(key);
    state.nbytes -= obj.nbytes;
    if (obj.freq > 0) {
      obj.freq = 0;
      state.main.set(key, obj);
      state.mainQ.push(key);
      state.nbytes += obj.nbytes;
      return null;
    }
    return { key, nbytes: obj.nbytes, reason: "S3FIFO_MAIN" };
  }

  admitOn(state, key, nbytes, now) {
    const evicted = [];
    const obj = { nbytes, freq: 0, token: null, tokenUsed: false };
    if (state.ghostSet.has(key)) {
      state.main.set(key, obj);
      state.mainQ.push(key);
      this.forget(state, key);
    } else {
      state.small.set(key, obj);
      state.smallQ.push(key);
    }
    state.nbytes += nbytes;
    state.seenSkip = new Set();
    let guard = 0;
    while (state.nbytes > this.cap || state.small.size + state.main.size > this.maxEntries) {
      guard += 1;
      if (guard > 100000) throw new Error("s3fifo eviction did not converge");
      if (state.small.size + state.main.size === 1 && state.nbytes > this.cap) break;
      let smallBytes = 0;
      for (const item of state.small.values()) smallBytes += item.nbytes;
      const smallOver = smallBytes > this.smallByte || state.small.size > this.smallEntries;
      let victim = null;
      if (state.smallQ.length && smallOver) victim = this.evictSmall(state, now);
      else if (state.mainQ.length) victim = this.evictMain(state);
      else if (state.smallQ.length) victim = this.evictSmall(state, now);
      else break;
      if (victim && victim.skipped) continue;
      if (victim) evicted.push(victim);
    }
    return evicted;
  }

  demand(event) {
    if (!this.timeOk(event.time)) return { accepted: false, reason: "CLOCK_REGRESSION", hit: false };
    if (!this.viewersAllowed.has(event.viewer)) return { accepted: false, reason: "VIEWER_UNMAPPED", hit: false };
    this.demandSeq += 1;
    this.prune(event.time);
    const obj = this.small.get(event.key) || this.main.get(event.key);
    if (obj) {
      obj.freq = 1;
      if (obj.token && obj.token.follower === event.viewer && event.time <= obj.token.until) {
        this.stats.follower_hits += 1;
        this.stats.follower_hit_bytes += obj.nbytes;
        obj.token = null;
      } else if (obj.token && event.time > obj.token.until) obj.token = null;
      this.rememberRequest(event.viewer, event.key, event.time);
      this.observeAnchors(event.viewer, event.key, event.time, event.strong === true);
      return { accepted: true, reason: "HIT", hit: true };
    }
    this.rememberRequest(event.viewer, event.key, event.time);
    this.observeAnchors(event.viewer, event.key, event.time, event.strong === true);
    return { accepted: true, reason: "MISS", hit: false };
  }

  complete(event) {
    if (!this.timeOk(event.time)) return { accepted: false, reason: "CLOCK_REGRESSION", admitted: false, evicted: [] };
    if (!this.viewersAllowed.has(event.viewer)) return { accepted: false, reason: "VIEWER_UNMAPPED", admitted: false, evicted: [] };
    this.prune(event.time);
    if (!(event.success === true) || !(Number(event.bytes) > 0) || (event.statusCode != null && event.statusCode !== 206)) {
      return { accepted: true, reason: "ORIGIN_NOT_ADMITTED", admitted: false, evicted: [] };
    }
    if (this.small.has(event.key) || this.main.has(event.key)) return { accepted: true, reason: "ALREADY_RESIDENT", admitted: false, evicted: [] };
    const state = this.cloneState();
    const evicted = this.admitOn(state, event.key, event.bytes, event.time);
    if (state.nbytes > this.cap && state.small.size + state.main.size > 1) throw new Error("CAPACITY_BROKEN");
    if (state.small.size + state.main.size > this.maxEntries) throw new Error("CAPACITY_BROKEN");
    this.commit(state);
    for (const row of evicted) this.evictedAt.set(row.key, { time: event.time, override: row.reason === "R4_S3_SHIELD" });
    const prior = this.evictedAt.get(event.key);
    if (prior && prior.override) this.stats.victim_refetch_bytes += event.bytes;
    const admitted = this.small.has(event.key) || this.main.has(event.key);
    return { accepted: true, reason: admitted ? "ADMITTED" : "EVICTED_SAME_ADMIT", admitted, evicted };
  }

  telemetry() {
    return {
      live_anchors: [...this.pairs.values()].reduce((sum, rows) => sum + rows.length, 0),
      anchors_created: this.stats.anchors_created,
      shields_created: this.stats.shields_created,
      follower_hits: this.stats.follower_hits,
      follower_hit_bytes: this.stats.follower_hit_bytes,
      victim_refetch_bytes: this.stats.victim_refetch_bytes,
      net_followed_minus_refetch: this.stats.follower_hit_bytes - this.stats.victim_refetch_bytes,
      occupancy_bytes: this.nbytes,
      occupancy_entries: this.small.size + this.main.size,
    };
  }
}

module.exports = { S3Frontier };
