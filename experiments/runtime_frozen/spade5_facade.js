"use strict";

const { S3Frontier } = require("./active_frontier");

const FACTORIES = {
  "SPADE-S3": () => new S3Frontier(),
};

function viewerOf(userId) {
  const text = String(userId || "");
  if (text.includes("C4")) return "C4";
  if (text.includes("C5")) return "C5";
  return "C3";
}

function demandFrom(lookupKey, ranges, time) {
  const parts = String(lookupKey || "").split("|");
  if (parts.length < 3) return [];
  const version = parts[0];
  const url = parts.slice(1, -1).join("|");
  const strong = version.startsWith("\"") && !version.startsWith("W/");
  return (ranges || []).map((range) => ({
    key: `${version}|${url}|${range.start}-${range.end}`,
    observedAt: time,
    strong,
  }));
}

class Spade5Facade {
  constructor(policy) {
    this.policy = policy;
    this.bodies = new Map();
    this.ctx = { time: 0, userId: "C3", requestId: "none", rendererDemand: [] };
    this.pending = new Map();
  }

  begin(ctx) {
    this.ctx = ctx;
  }

  lookup(key) {
    const time = Number.isInteger(this.ctx.time) ? this.ctx.time : Date.now();
    const viewer = viewerOf(this.ctx.userId);
    const version = String(key || "").split("|")[0];
    const strong = version.startsWith("\"") && !version.startsWith("W/");
    const result = this.policy.demand({
      time,
      viewer,
      key,
      strong,
      bytes: 0,
      requestId: this.ctx.requestId,
      rendererDemand: demandFrom(key, this.ctx.rendererDemand, time),
    });
    const requestId = this.ctx.requestId;
    if (!result.accepted || !result.hit) {
      this.pending.set(requestId, {
        key,
        requestId,
        viewer,
        strong,
        time,
        rendererDemand: demandFrom(key, this.ctx.rendererDemand, time),
      });
      return null;
    }
    const body = this.bodies.get(key);
    return body == null ? null : body;
  }

  admit(key, nbytes, data, meta) {
    const info = meta || {};
    const pending = this.pending.get(info.requestId);
    if (pending) this.pending.delete(info.requestId);
    const time = Number.isInteger(info.time) ? info.time : Date.now();
    const result = this.policy.complete({
      time,
      viewer: pending ? pending.viewer : viewerOf(info.userId || this.ctx.userId),
      key,
      strong: pending ? pending.strong : false,
      bytes: nbytes,
      success: nbytes > 0,
      requestId: pending ? pending.requestId : info.requestId || this.ctx.requestId,
      rendererDemand: pending ? pending.rendererDemand : [],
    });
    if (result.admitted) this.bodies.set(key, data);
    return (result.evicted || []).filter((item) => item && item.key).map((item) => {
      this.bodies.delete(item.key);
      return { key: item.key, nbytes: item.nbytes, reason: item.reason || "SPADE5" };
    });
  }

  telemetry() {
    return this.policy.telemetry ? this.policy.telemetry() : {};
  }
}

function createSpade5(method) {
  const factory = FACTORIES[method];
  if (!factory) return null;
  return new Spade5Facade(factory());
}

module.exports = { createSpade5, FACTORIES };
