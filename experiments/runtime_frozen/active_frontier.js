"use strict";

const fs = require("fs");
const C = require("./constants");
const { S3Frontier } = require("./s3_frontier");

const LOCK = require("path").join(__dirname, "V02_VARIANT.json");
const spec = JSON.parse(fs.readFileSync(LOCK, "utf8"));
for (const [key, value] of Object.entries(spec.patch || {})) C[key] = value;

class ActiveFrontier extends S3Frontier {
  constructor() {
    super({ frontierShield: true, opportunityVeto: spec.rule && spec.rule.veto !== false });
    this.rule = spec.rule || {};
    this.variantId = spec.id;
  }

  trySpare(state, key, obj, now) {
    if (!this.frontierShield || obj.tokenUsed) return null;
    if (this.rule.maxObjectBytes != null && obj.nbytes > this.rule.maxObjectBytes) return null;
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
    if (this.rule.victimMustBeZeroCross && victimCross !== 0) return null;
    if (this.rule.victimNoLarger && victimObj.nbytes > obj.nbytes) return null;
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
}

module.exports = { S3Frontier: ActiveFrontier, variantId: spec.id };
