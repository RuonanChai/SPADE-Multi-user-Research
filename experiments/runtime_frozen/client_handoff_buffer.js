"use strict";

const http = require("http");

const HOLD_MS = 15000;
const CAP_BYTES = 160 * 1024 * 1024;
const PORT = 19081;

class HandoffBuffer {
  constructor() {
    this.items = new Map();
    this.order = [];
    this.bytes = 0;
    this.server = null;
  }
  remember(key, body) {
    if (!key || !body || !body.length) return false;
    this.forget(key);
    this.items.set(key, { body, at: Date.now() });
    this.order.push(key);
    this.bytes += body.length;
    this.evict();
    return this.items.has(key);
  }
  forget(key) {
    const old = this.items.get(key);
    if (!old) return;
    this.items.delete(key);
    this.bytes -= old.body.length;
    const index = this.order.indexOf(key);
    if (index >= 0) this.order.splice(index, 1);
  }
  evict() {
    const now = Date.now();
    while (this.order.length) {
      const key = this.order[0];
      const item = this.items.get(key);
      const expired = !item || now - item.at > HOLD_MS;
      if (!expired && this.bytes <= CAP_BYTES) break;
      this.order.shift();
      if (item) {
        this.items.delete(key);
        this.bytes -= item.body.length;
      }
    }
  }
  get(key) {
    this.evict();
    const item = this.items.get(key);
    return item ? item.body : null;
  }
  start() {
    if (this.server) return Promise.resolve();
    this.server = http.createServer((req, res) => {
      const remote = String(req.socket.remoteAddress || "");
      const host = remote.replace(/^::ffff:/, "");
      const allowed = host === "192.168.1.200" || host === "127.0.0.1" || remote === "::1";
      if (!allowed) {
        res.writeHead(403);
        res.end();
        return;
      }
      const url = new URL(req.url, "http://127.0.0.1");
      const key = url.searchParams.get("key");
      const body = this.get(key);
      const range = /\|(\d+)-(\d+)$/.exec(String(key || ""));
      const start = range ? Number(range[1]) : NaN;
      const end = range ? Number(range[2]) : NaN;
      if (!body || !Number.isInteger(start) || !Number.isInteger(end) || body.length !== end - start + 1) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Type": "application/octet-stream",
        "Content-Length": body.length,
        "Content-Range": `bytes ${start}-${end}/*`,
        "X-P5-Handoff-Hold-Ms": String(HOLD_MS),
      });
      res.end(body);
    });
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(PORT, "0.0.0.0", resolve);
    });
  }
}

module.exports = { HandoffBuffer, HOLD_MS, CAP_BYTES, PORT };
