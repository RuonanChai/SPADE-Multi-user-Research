"use strict";

function createIdentity() {
  let sequence = 0;
  let token = null;
  let seen = 0;
  let conflict = false;
  return {
    nextId() {
      sequence += 1;
      return `req_${sequence}`;
    },
    observe(etag) {
      if (!etag || String(etag).startsWith("W/")) return { version_proven: false, reason: "NO_STRONG_ETAG", token };
      if (conflict) return { version_proven: false, reason: "VERSION_CONFLICT", token: null };
      if (token && token !== etag) {
        conflict = true;
        token = null;
        seen = 0;
        return { version_proven: false, reason: "VERSION_CONFLICT", token: null };
      }
      token = etag;
      seen += 1;
      const proven = seen >= 2;
      return { version_proven: proven, reason: proven ? "STABLE_STRONG_ETAG" : "FIRST_ETAG_UNCONFIRMED", token };
    },
    key(url, start, end) {
      const version = !conflict && seen >= 2 && token ? token : "UNVERSIONED";
      return `${version}|${url}|${start}-${end === null || end === undefined ? "*" : end}`;
    },
    get versionProven() {
      return seen >= 2 && !conflict;
    },
  };
}

module.exports = { createIdentity };
