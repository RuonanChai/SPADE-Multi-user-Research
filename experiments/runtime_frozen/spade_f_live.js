"use strict";

const fs = require("fs");

const LOCK_PATH = "F:/WWW_N3_MUX/research_control/SPADE_F_PILOT_20261018/02_PRE_REGISTERED_DESIGN_LOCK.json";
const LOCK = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
const HISTORY_K = LOCK.K;
const ANCHOR_COUNT = LOCK.anchors;
const FRONTIER_COUNT = LOCK.frontier;
const PROTECT_BUDGET = LOCK.protect_budget_bytes;
const CAP = LOCK.capacity_bytes;
const ENTRIES = LOCK.entry_limit;

class History {
  constructor() {
    this.order = [];
    this.timestamps = new Map();
    this.lastTs = new Map();
    this.seen = new Set();
  }

  observe(key, timestamp) {
    this.seen.add(key);
    this.lastTs.set(key, timestamp);
    if (!this.timestamps.has(key)) {
      this.timestamps.set(key, timestamp);
      this.order.push(key);
    }
    if (this.order.length > HISTORY_K) {
      const newest = new Set(this.order.slice().sort((left, right) => this.lastTs.get(left) - this.lastTs.get(right)).slice(-HISTORY_K));
      this.order = this.order.filter((item) => newest.has(item));
      for (const item of [...this.timestamps.keys()]) {
        if (!newest.has(item)) this.timestamps.delete(item);
      }
      for (const item of [...this.lastTs.keys()]) {
        if (!newest.has(item)) this.lastTs.delete(item);
      }
    }
  }
}

function medianUpper(values) {
  const ordered = values.slice().sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

function direction(leader, follower) {
  if (leader === follower) return null;
  const followerPos = new Map(follower.order.map((key, index) => [key, index]));
  const commons = [];
  let lastPos = -1;
  for (const key of leader.order) {
    if (!followerPos.has(key) || !leader.timestamps.has(key) || !follower.timestamps.has(key)) continue;
    if (!(leader.timestamps.get(key) < follower.timestamps.get(key))) continue;
    const position = followerPos.get(key);
    if (position <= lastPos) continue;
    commons.push(key);
    lastPos = position;
  }
  if (commons.length < ANCHOR_COUNT) return null;
  const anchors = commons.slice(-ANCHOR_COUNT);
  const lags = anchors.map((key) => follower.timestamps.get(key) - leader.timestamps.get(key));
  if (lags.some((lag) => lag <= 0)) return null;
  const start = leader.order.indexOf(anchors[anchors.length - 1]);
  const frontier = [];
  for (const key of leader.order.slice(start + 1)) {
    if (follower.seen.has(key)) continue;
    frontier.push(key);
    if (frontier.length === FRONTIER_COUNT) break;
  }
  return { lag: medianUpper(lags), anchor: anchors[anchors.length - 1], frontier };
}

class SpadeF {
  constructor(capacity, entryLimit, crossUser, versionProven) {
    this.capacity = capacity;
    this.entryLimit = entryLimit;
    this.crossUser = crossUser;
    this.versionProven = versionProven;
    this.order = [];
    this.meta = new Map();
    this.used = 0;
    this.histories = new Map();
    this.admittedBytes = 0;
    this.firstTs = null;
    this.protectedBytes = 0;
  }

  tRes(now) {
    if (this.firstTs === null || this.admittedBytes <= 0 || now <= this.firstTs) return null;
    return this.capacity * (now - this.firstTs) / this.admittedBytes;
  }

  history(user) {
    if (!this.histories.has(user)) this.histories.set(user, new History());
    return this.histories.get(user);
  }

  eligibility(key, now) {
    if (!this.crossUser) return { eligible: false, reason: "CROSS_USER_OFF", follower: null, predicted: null };
    if (!this.versionProven) return { eligible: false, reason: "VERSION_UNPROVEN", follower: null, predicted: null };
    if (!this.meta.has(key)) return { eligible: false, reason: "NOT_RESIDENT", follower: null, predicted: null };
    const residence = this.tRes(now);
    if (residence === null) return { eligible: false, reason: "T_RES_UNDEFINED", follower: null, predicted: null };
    if (this.meta.get(key).usedSkip) return { eligible: false, reason: "SKIP_ALREADY_USED", follower: null, predicted: null };
    const users = [...this.histories.keys()].sort();
    for (const leaderId of users) {
      for (const followerId of users) {
        if (leaderId === followerId) continue;
        const found = direction(this.histories.get(leaderId), this.histories.get(followerId));
        if (!found || !found.frontier.includes(key)) continue;
        if (this.histories.get(followerId).seen.size === 0) continue;
        const predicted = this.histories.get(leaderId).timestamps.get(key) + found.lag;
        if (predicted > now && predicted <= now + residence) {
          return { eligible: true, reason: "FRONTIER_ELIGIBLE", follower: followerId, predicted };
        }
      }
    }
    return { eligible: false, reason: "NO_ELIGIBLE_FOLLOWER", follower: null, predicted: null };
  }

  over() {
    return this.order.length > this.entryLimit || this.used > this.capacity;
  }

  protect(key) {
    const state = this.meta.get(key);
    state.usedSkip = true;
    state.protected = true;
    this.protectedBytes += state.bytes;
  }

  release(key) {
    const state = this.meta.get(key);
    if (state && state.protected) {
      this.protectedBytes -= state.bytes;
      state.protected = false;
    }
  }

  selectVictim(now) {
    const head = this.order[0];
    const decision = this.eligibility(head, now);
    const lruHead = head;
    if (!decision.eligible) return { victim: head, lruHead, ...decision };
    if (this.protectedBytes + this.meta.get(head).bytes > PROTECT_BUDGET) {
      return { victim: head, lruHead, eligible: false, reason: "BUDGET_EXHAUSTED", follower: decision.follower, predicted: decision.predicted };
    }
    this.protect(head);
    for (const key of this.order) {
      if (!this.meta.get(key).protected) {
        return { victim: key, lruHead, eligible: true, reason: "EVICT_OLDEST_UNPROTECTED", follower: decision.follower, predicted: decision.predicted };
      }
    }
    this.release(head);
    this.meta.get(head).usedSkip = false;
    return { victim: head, lruHead, eligible: false, reason: "ALL_PROTECTED_FALLBACK", follower: decision.follower, predicted: decision.predicted };
  }

  touch(user, key, size, timestamp) {
    this.history(user).observe(key, timestamp);
    if (this.meta.has(key)) {
      this.order.splice(this.order.indexOf(key), 1);
      this.order.push(key);
      return { hit: true, evictions: [] };
    }
    this.meta.set(key, { bytes: size, usedSkip: false, protected: false, admitTs: timestamp });
    this.order.push(key);
    this.used += size;
    const evictions = [];
    while (this.over()) {
      if (this.order.length <= 1 && this.meta.get(this.order[0]).bytes > this.capacity) break;
      const head = this.order[0];
      const chosen = this.selectVictim(timestamp);
      const protectedKey = chosen.victim !== head ? head : "";
      const state = this.meta.get(chosen.victim);
      this.release(chosen.victim);
      this.used -= state.bytes;
      this.order.splice(this.order.indexOf(chosen.victim), 1);
      this.meta.delete(chosen.victim);
      evictions.push({
        victim: chosen.victim,
        bytes: state.bytes,
        reason: chosen.reason,
        follower: chosen.follower,
        predicted: chosen.predicted,
        t_res: this.tRes(timestamp),
        timestamp,
        cause_user: user,
        cause_key: key,
        protected_key: protectedKey,
        lru_head: chosen.lruHead,
        protected_bytes: this.protectedBytes,
      });
    }
    if (this.firstTs === null) this.firstTs = timestamp;
    this.admittedBytes += size;
    return { hit: false, evictions };
  }
}

function replay(requests, crossUser, versionProven, capacity = CAP, entryLimit = ENTRIES) {
  const rows = requests.slice().sort((left, right) => left.ts - right.ts || String(left.request_id || "").localeCompare(String(right.request_id || "")) || String(left.user).localeCompare(String(right.user)) || String(left.key).localeCompare(String(right.key)));
  const policy = new SpadeF(capacity, entryLimit, crossUser, versionProven);
  let origin = 0;
  let hits = 0;
  const decisions = [];
  const outcomes = [];
  rows.forEach((row, index) => {
    const result = policy.touch(row.user, row.key, row.bytes, row.ts);
    if (result.hit) {
      hits += 1;
      outcomes.push("hit");
    } else {
      origin += row.bytes;
      outcomes.push("miss");
    }
    for (const eviction of result.evictions) {
      eviction.cause_index = index;
      decisions.push(eviction);
    }
  });
  return { origin, hits, decisions, outcomes };
}

class LiveCache {
  constructor(capacity, entryLimit) {
    this.policy = new SpadeF(capacity, entryLimit, true, false);
    this.bodies = new Map();
    this.user = "unknown";
    this.now = 0;
    this.versionToken = null;
    this.versionSeen = 0;
    this.versionConflict = false;
  }

  note(user, now) {
    this.user = user;
    this.now = now;
  }

  observeVersion(etag) {
    if (!etag || String(etag).startsWith("W/")) return { version_proven: false, reason: "NO_STRONG_ETAG" };
    if (this.versionConflict) return { version_proven: false, reason: "VERSION_CONFLICT" };
    if (this.versionToken && this.versionToken !== etag) {
      this.versionConflict = true;
      this.versionSeen = 0;
      this.policy.versionProven = false;
      return { version_proven: false, reason: "VERSION_CONFLICT" };
    }
    this.versionToken = etag;
    this.versionSeen += 1;
    const proven = this.versionSeen >= 2;
    this.policy.versionProven = proven;
    return { version_proven: proven, reason: proven ? "STABLE_STRONG_ETAG" : "FIRST_ETAG_UNCONFIRMED" };
  }

  lookup(key) {
    if (!this.bodies.has(key)) return null;
    const result = this.policy.touch(this.user, key, this.bodies.get(key).length, this.now);
    if (!result.hit) throw new Error("LOOKUP_NOT_RESIDENT");
    return this.bodies.get(key);
  }

  admit(key, nbytes, data) {
    const result = this.policy.touch(this.user, key, nbytes, this.now);
    for (const eviction of result.evictions) this.bodies.delete(eviction.victim);
    if (this.policy.meta.has(key)) this.bodies.set(key, data);
    return result.evictions.map((eviction) => ({ key: eviction.victim, nbytes: eviction.bytes, ...eviction }));
  }
}

function createLiveCache(capacity = CAP, entryLimit = ENTRIES) {
  return new LiveCache(capacity, entryLimit);
}

module.exports = {
  CAP, ENTRIES, HISTORY_K, ANCHOR_COUNT, FRONTIER_COUNT, PROTECT_BUDGET,
  SpadeF, replay, createLiveCache,
};
