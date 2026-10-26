"use strict";

const { createIdentity } = require("./request_trace");

const ids = createIdentity();
const first = ids.nextId();
const second = ids.nextId();
if (first !== "req_1" || second !== "req_2") throw new Error("REQUEST_ID");
if (ids.observe("W/\"abc\"").version_proven !== false) throw new Error("WEAK");
if (ids.key("https://origin/a.rad", 0, 1023) !== "UNVERSIONED|https://origin/a.rad|0-1023") throw new Error("UNVERSIONED_KEY");
if (ids.observe("\"c63451f94630f45659334d7d1ea5d20b-153\"").version_proven !== false) throw new Error("SINGLE_ETAG_PROVED");
if (ids.observe("\"c63451f94630f45659334d7d1ea5d20b-153\"").version_proven !== true) throw new Error("STRONG");
if (!ids.key("https://origin/a.rad", 0, 1023).startsWith("\"c63451f94630f45659334d7d1ea5d20b-153\"|")) throw new Error("VERSIONED_KEY");
if (ids.observe("\"other\"").version_proven !== false) throw new Error("CONFLICT");
if (!ids.key("https://origin/a.rad", 0, 1023).startsWith("UNVERSIONED|")) throw new Error("CONFLICT_KEY");
const onlyTotal = createIdentity();
if (onlyTotal.observe(null).reason !== "NO_STRONG_ETAG") throw new Error("RANGE_TOTAL_IS_NOT_VERSION");
console.log("REQUEST_TRACE_PASS");
