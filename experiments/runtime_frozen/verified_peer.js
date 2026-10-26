"use strict";

const crypto = require("crypto");
const http = require("http");

const RUNTIME_VERSION = "SPADE-VERIFIED-20261024";
const PRIOR_RUNTIME_VERSION = "SPADE-BYTE-UNVERIFIED-20261023";

function sha256(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function strongValidator(etag) {
  if (etag == null) return null;
  const text = String(etag).trim();
  if (!text || text.startsWith("W/") || text.startsWith("w/")) return null;
  if (!(text.startsWith('"') && text.endsWith('"') && text.length >= 2)) return null;
  return text;
}

function header(headers, name) {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return null;
}

function contentRangeMatches(value, start, end, length) {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(value || "").trim());
  if (!match) return false;
  const rangeStart = Number(match[1]);
  const rangeEnd = Number(match[2]);
  return rangeStart === start && rangeEnd === end && rangeEnd - rangeStart + 1 === length;
}

class TrustedDigestStore {
  constructor() {
    this.rows = new Map();
    this.current = new Map();
  }
  key(url, start, end, validator) {
    return `${validator}|${url}|${start}-${end}`;
  }
  rememberOrigin({ url, start, end, statusCode, headers, body }) {
    if (statusCode !== 206 && statusCode !== 200) return { ok: false, reason: "ORIGIN_STATUS" };
    const validator = strongValidator(header(headers, "etag"));
    if (!validator) return { ok: false, reason: "ORIGIN_NO_STRONG_ETAG" };
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return { ok: false, reason: "RANGE_INVALID" };
    const expected = end - start + 1;
    if (!body || body.length !== expected) return { ok: false, reason: "ORIGIN_LENGTH" };
    if (!contentRangeMatches(header(headers, "content-range"), start, end, body.length)) return { ok: false, reason: "ORIGIN_CONTENT_RANGE" };
    const digest = sha256(body);
    const id = this.key(url, start, end, validator);
    const record = {
      url, start, end, validator, sha256: digest, bytes: body.length,
      source: "proxy_sha256_of_origin_body",
      metadata_bytes: Buffer.byteLength(id) + 32,
      stored_at: Date.now(),
    };
    this.rows.set(id, record);
    this.current.set(url, validator);
    return { ok: true, ...record };
  }
  lookup(url, start, end, validator) {
    return this.rows.get(this.key(url, start, end, validator)) || null;
  }
  hasOtherVersion(url, start, end, validator) {
    for (const record of this.rows.values()) {
      if (record.url === url && record.start === start && record.end === end && record.validator !== validator) return record;
    }
    return null;
  }
}

function reject(reason) {
  return { accept: false, reason, sha256: null, validator: null, metadata_bytes: 0, source: null };
}

function verifyPeer({ statusCode, headers, body, url, start, end, store }) {
  if (statusCode === 404) return reject("PEER_404");
  if (statusCode === 416) return reject("PEER_416");
  if (!body || body.length === 0) return reject("EMPTY_BODY");
  if (statusCode !== 200 && statusCode !== 206) return reject(`PEER_STATUS_${statusCode || 0}`);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return reject("RANGE_INVALID");
  const expected = end - start + 1;
  if (body.length < expected) return reject("SHORT_BODY");
  if (body.length > expected) return reject("LONG_BODY");
  if (!contentRangeMatches(header(headers, "content-range"), start, end, body.length)) return reject("CONTENT_RANGE_MISMATCH");
  const expectedValidator = store.current.get(url) || null;
  if (!expectedValidator) {
    return store.hasOtherVersion(url, start, end, null) ? reject("STALE_VERSION") : reject("NO_TRUSTED_DIGEST");
  }
  const record = store.lookup(url, start, end, expectedValidator);
  if (!record) {
    return store.hasOtherVersion(url, start, end, expectedValidator) ? reject("STALE_VERSION") : reject("NO_TRUSTED_DIGEST");
  }
  const digest = sha256(body);
  const peerEtag = header(headers, "etag");
  if (digest !== record.sha256) {
    if (peerEtag && peerEtag !== record.validator) return reject("FORGED_ETAG");
    return reject("DIGEST_MISMATCH");
  }
  return {
    accept: true,
    reason: peerEtag && peerEtag !== record.validator ? "DIGEST_MATCH_PEER_ETAG_IGNORED" : "DIGEST_MATCH",
    sha256: digest,
    validator: record.validator,
    metadata_bytes: record.metadata_bytes,
    source: record.source,
  };
}

async function resolveMiss({ peer, fetchOrigin, store, url, start, end }) {
  const peerMs = peer && Number.isFinite(peer.peerMs) ? peer.peerMs : null;
  if (peer) {
    const verdict = verifyPeer({ statusCode: peer.statusCode, headers: peer.headers, body: peer.body, url, start, end, store });
    if (verdict.accept) {
      return {
        source: "peer", statusCode: 206, body: peer.body, cached: true, sha256: verdict.sha256,
        validator: verdict.validator, reason: verdict.reason, peerMs, metadata_bytes: verdict.metadata_bytes,
        digest_source: verdict.source, delivered_etag: verdict.validator,
        headers: { etag: verdict.validator, "content-range": `bytes ${start}-${end}/*`, "content-type": "application/octet-stream" },
      };
    }
    peer = { ...peer, rejectReason: verdict.reason };
  }
  const origin = await fetchOrigin();
  const remembered = store.rememberOrigin({ url, start, end, statusCode: origin.statusCode, headers: origin.headers, body: origin.body });
  if (!remembered.ok) {
    return {
      source: "origin_untrusted", statusCode: origin.statusCode, body: origin.body, headers: origin.headers, cached: false,
      sha256: null, validator: null, reason: remembered.reason, peerMs,
      peer_reject: peer && peer.rejectReason || null, metadata_bytes: 0, digest_source: null, delivered_etag: null,
    };
  }
  return {
    source: "origin", statusCode: origin.statusCode, body: origin.body, headers: origin.headers, cached: true, sha256: remembered.sha256,
    validator: remembered.validator, reason: "ORIGIN_TRUSTED", peerMs,
    peer_reject: peer && peer.rejectReason || null, metadata_bytes: remembered.metadata_bytes,
    digest_source: remembered.source, delivered_etag: remembered.validator,
  };
}

function fetchPeerChecked(ip, key, port, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    const req = http.request({
      hostname: ip, port, method: "GET", timeout: timeoutMs,
      path: `/handoff?key=${encodeURIComponent(key)}`,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks),
        error: null, peerMs: Date.now() - started,
      }));
    });
    req.on("error", (error) => resolve({ statusCode: 0, headers: {}, body: Buffer.alloc(0), error: error.message, peerMs: Date.now() - started }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ statusCode: 0, headers: {}, body: Buffer.alloc(0), error: "TIMEOUT", peerMs: Date.now() - started });
    });
    req.end();
  });
}

module.exports = {
  RUNTIME_VERSION, PRIOR_RUNTIME_VERSION, TrustedDigestStore, verifyPeer, resolveMiss,
  fetchPeerChecked, sha256, strongValidator, contentRangeMatches,
};
