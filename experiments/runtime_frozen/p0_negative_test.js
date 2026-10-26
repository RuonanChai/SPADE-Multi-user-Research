"use strict";

const http = require("http");
const { TrustedDigestStore, resolveMiss, fetchPeerChecked, sha256, RUNTIME_VERSION } = require("./verified_peer");

const URL_A = "https://origin.example/coit.rad";
const URL_B = "https://origin.example/poland.rad";
const START = 0;
const END = 15;
const V1 = '"v1-strong"';
const V2 = '"v2-strong"';
const GOOD = Buffer.from("0123456789abcdef");
const SHORT = GOOD.subarray(0, 8);
const LONG = Buffer.concat([GOOD, Buffer.from("X")]);
const EQUAL_BAD = Buffer.from("0123456789abcdeX");
const ORIGIN_HEADERS = { etag: V1, "content-range": "bytes 0-15/100" };

function originOf(body, etag = V1) {
  return async () => ({ statusCode: 206, headers: { etag, "content-range": "bytes 0-15/100" }, body });
}
function peerOf(body, statusCode, headers) {
  return { statusCode, headers: headers || { "content-range": "bytes 0-15/100", etag: V1 }, body, peerMs: 4 };
}

async function runCase(name, fn) {
  const cache = [];
  const badBodies = [];
  const result = await fn({ cache, badBodies });
  const badDelivered = badBodies.some((bad) => result.delivered && bad.equals(result.delivered)) ? 1 : 0;
  const badCached = badBodies.some((bad) => cache.some((item) => item.equals(bad))) ? 1 : 0;
  const pass = result.pass && badDelivered === 0 && badCached === 0;
  return { case: name, expected: result.expected, actual: result.actual, pass, bad_delivered: badDelivered, bad_cached: badCached, runtime: RUNTIME_VERSION };
}

function listen(port, handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function main() {
  const rows = [];
  rows.push(await runCase("correct_content", async ({ cache }) => {
    const store = new TrustedDigestStore();
    await resolveMiss({ peer: null, fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END });
    const result = await resolveMiss({ peer: peerOf(GOOD, 206), fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END });
    if (result.cached) cache.push(result.body);
    const same = result.source === "peer" && result.body.equals(GOOD) && result.sha256 === sha256(GOOD) && result.body.length === GOOD.length && result.delivered_etag === V1;
    return { pass: same, expected: "peer digest match", actual: result.reason, delivered: result.body };
  }));

  rows.push(await runCase("short_body", async ({ cache, badBodies }) => {
    badBodies.push(SHORT);
    const store = new TrustedDigestStore();
    await resolveMiss({ peer: null, fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END });
    const result = await resolveMiss({ peer: peerOf(SHORT, 206), fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END });
    if (result.cached) cache.push(result.body);
    const ok = result.source === "origin" && result.body.equals(GOOD) && result.peer_reject === "SHORT_BODY" && result.sha256 === sha256(GOOD);
    return { pass: ok, expected: "SHORT_BODY then origin", actual: result.peer_reject, delivered: result.body };
  }));

  rows.push(await runCase("long_body", async ({ cache, badBodies }) => {
    badBodies.push(LONG);
    const store = new TrustedDigestStore();
    await resolveMiss({ peer: null, fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END });
    const result = await resolveMiss({ peer: peerOf(LONG, 206), fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END });
    if (result.cached) cache.push(result.body);
    return { pass: result.peer_reject === "LONG_BODY" && result.body.equals(GOOD), expected: "LONG_BODY then origin", actual: result.peer_reject, delivered: result.body };
  }));

  rows.push(await runCase("equal_length_wrong_body", async ({ cache, badBodies }) => {
    badBodies.push(EQUAL_BAD);
    const store = new TrustedDigestStore();
    await resolveMiss({ peer: null, fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END });
    const result = await resolveMiss({ peer: peerOf(EQUAL_BAD, 206), fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END });
    if (result.cached) cache.push(result.body);
    return { pass: result.peer_reject === "DIGEST_MISMATCH" && result.body.equals(GOOD) && cache.length === 1 && cache[0].equals(GOOD), expected: "DIGEST_MISMATCH then origin", actual: result.peer_reject, delivered: result.body };
  }));

  rows.push(await runCase("stale_version", async ({ cache, badBodies }) => {
    badBodies.push(GOOD);
    const store = new TrustedDigestStore();
    await resolveMiss({ peer: null, fetchOrigin: originOf(GOOD, V1), store, url: URL_A, start: START, end: END });
    store.current.set(URL_A, V2);
    const result = await resolveMiss({ peer: peerOf(GOOD, 206), fetchOrigin: originOf(Buffer.from("zzzzzzzzzzzzzzzz"), V2), store, url: URL_A, start: START, end: END });
    if (result.cached) cache.push(result.body);
    return { pass: result.peer_reject === "STALE_VERSION" && result.validator === V2 && !result.body.equals(GOOD), expected: "STALE_VERSION", actual: result.peer_reject, delivered: result.body };
  }));

  rows.push(await runCase("forged_etag_wrong_body", async ({ cache, badBodies }) => {
    badBodies.push(EQUAL_BAD);
    const store = new TrustedDigestStore();
    await resolveMiss({ peer: null, fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END });
    const result = await resolveMiss({
      peer: peerOf(EQUAL_BAD, 206, { "content-range": "bytes 0-15/100", etag: '"forged"' }),
      fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END,
    });
    if (result.cached) cache.push(result.body);
    return { pass: result.peer_reject === "FORGED_ETAG" && result.delivered_etag === V1 && result.body.equals(GOOD), expected: "FORGED_ETAG", actual: result.peer_reject, delivered: result.body };
  }));

  rows.push(await runCase("forged_etag_correct_body_keeps_origin_validator", async ({ cache }) => {
    const store = new TrustedDigestStore();
    await resolveMiss({ peer: null, fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END });
    const result = await resolveMiss({
      peer: peerOf(GOOD, 206, { "content-range": "bytes 0-15/100", etag: '"forged"' }),
      fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END,
    });
    if (result.cached) cache.push(result.body);
    return { pass: result.source === "peer" && result.delivered_etag === V1 && result.reason === "DIGEST_MATCH_PEER_ETAG_IGNORED", expected: "ignore forged etag", actual: result.reason, delivered: result.body };
  }));

  rows.push(await runCase("bad_content_range", async ({ cache, badBodies }) => {
    const store = new TrustedDigestStore();
    await resolveMiss({ peer: null, fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END });
    const result = await resolveMiss({
      peer: peerOf(GOOD, 206, { "content-range": "bytes 0-3/100", etag: V1 }),
      fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END,
    });
    if (result.cached) cache.push(result.body);
    return { pass: result.peer_reject === "CONTENT_RANGE_MISMATCH" && result.body.equals(GOOD), expected: "CONTENT_RANGE_MISMATCH", actual: result.peer_reject, delivered: result.body };
  }));

  rows.push(await runCase("empty_response", async ({ cache }) => {
    const store = new TrustedDigestStore();
    await resolveMiss({ peer: null, fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END });
    const result = await resolveMiss({ peer: peerOf(Buffer.alloc(0), 200, {}), fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END });
    if (result.cached) cache.push(result.body);
    return { pass: result.peer_reject === "EMPTY_BODY" && result.body.equals(GOOD), expected: "EMPTY_BODY", actual: result.peer_reject, delivered: result.body };
  }));

  rows.push(await runCase("peer_404", async ({ cache }) => {
    const store = new TrustedDigestStore();
    await resolveMiss({ peer: null, fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END });
    const result = await resolveMiss({ peer: { statusCode: 404, headers: {}, body: Buffer.from("missing"), peerMs: 3 }, fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END });
    if (result.cached) cache.push(result.body);
    return { pass: result.peer_reject === "PEER_404" && result.body.equals(GOOD), expected: "PEER_404", actual: result.peer_reject, delivered: result.body };
  }));

  rows.push(await runCase("peer_416", async ({ cache }) => {
    const store = new TrustedDigestStore();
    await resolveMiss({ peer: null, fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END });
    const result = await resolveMiss({ peer: { statusCode: 416, headers: {}, body: Buffer.from("bad-range"), peerMs: 3 }, fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END });
    if (result.cached) cache.push(result.body);
    return { pass: result.peer_reject === "PEER_416" && result.body.equals(GOOD), expected: "PEER_416", actual: result.peer_reject, delivered: result.body };
  }));

  const slow = await listen(19181, (req, res) => setTimeout(() => res.end("late"), 3000));
  const timed = await fetchPeerChecked("127.0.0.1", "k", 19181, 1500);
  slow.close();
  rows.push({ case: "timeout_1500ms", expected: "TIMEOUT 1500-2500ms", actual: `${timed.error} ${timed.peerMs}`, pass: timed.error === "TIMEOUT" && timed.peerMs >= 1500 && timed.peerMs <= 2500, bad_delivered: 0, bad_cached: 0, runtime: RUNTIME_VERSION });

  const down = await fetchPeerChecked("127.0.0.1", "k", 19182, 1500);
  const downStore = new TrustedDigestStore();
  await resolveMiss({ peer: null, fetchOrigin: originOf(GOOD), store: downStore, url: URL_A, start: START, end: END });
  const downResolved = await resolveMiss({ peer: down, fetchOrigin: originOf(GOOD), store: downStore, url: URL_A, start: START, end: END });
  rows.push({ case: "peer_unreachable", expected: "origin fallback", actual: `${down.error}|${downResolved.source}`, pass: down.statusCode === 0 && downResolved.source === "origin" && downResolved.body.equals(GOOD), bad_delivered: 0, bad_cached: 0, runtime: RUNTIME_VERSION });

  rows.push(await runCase("concurrent_miss", async ({ cache, badBodies }) => {
    const store = new TrustedDigestStore();
    await resolveMiss({ peer: null, fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END });
    const pair = await Promise.all([
      resolveMiss({ peer: peerOf(GOOD, 206), fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END }),
      resolveMiss({ peer: peerOf(EQUAL_BAD, 206), fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END }),
    ]);
    for (const result of pair) if (result.cached) cache.push(result.body);
    badBodies.push(EQUAL_BAD);
    const ok = pair[0].source === "peer" && pair[0].sha256 === sha256(GOOD) && pair[1].peer_reject === "DIGEST_MISMATCH" && pair[1].body.equals(GOOD);
    return { pass: ok, expected: "one peer one origin", actual: `${pair[0].source}|${pair[1].peer_reject}`, delivered: pair[1].body };
  }));

  rows.push(await runCase("user_switch_same_object", async ({ cache }) => {
    const store = new TrustedDigestStore();
    await resolveMiss({ peer: null, fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END });
    const result = await resolveMiss({ peer: peerOf(GOOD, 206), fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END });
    if (result.cached) cache.push(result.body);
    return { pass: result.source === "peer" && result.delivered_etag === V1, expected: "second user verified", actual: result.reason, delivered: result.body };
  }));

  rows.push(await runCase("different_url_same_range", async ({ cache, badBodies }) => {
    badBodies.push(GOOD);
    const store = new TrustedDigestStore();
    await resolveMiss({ peer: null, fetchOrigin: originOf(GOOD), store, url: URL_A, start: START, end: END });
    const other = Buffer.from("abcdefghijklmnopqrstuv".slice(0, 16));
    const result = await resolveMiss({ peer: peerOf(GOOD, 206), fetchOrigin: originOf(other), store, url: URL_B, start: START, end: END });
    if (result.cached) cache.push(result.body);
    return { pass: result.peer_reject === "NO_TRUSTED_DIGEST" && result.body.equals(other) && result.validator === V1, expected: "NO_TRUSTED_DIGEST", actual: result.peer_reject, delivered: result.body };
  }));

  const weak = new TrustedDigestStore();
  const weakRemember = weak.rememberOrigin({ url: URL_A, start: START, end: END, statusCode: 206, headers: { etag: "W/\"weak\"", "content-range": "bytes 0-15/100" }, body: GOOD });
  rows.push({ case: "weak_etag_not_a_validator", expected: "ORIGIN_NO_STRONG_ETAG", actual: weakRemember.reason, pass: weakRemember.ok === false, bad_delivered: 0, bad_cached: 0, runtime: RUNTIME_VERSION });

  const badDelivered = rows.reduce((sum, row) => sum + row.bad_delivered, 0);
  const badCached = rows.reduce((sum, row) => sum + row.bad_cached, 0);
  const failed = rows.filter((row) => !row.pass);
  const gate = failed.length === 0 && badDelivered === 0 && badCached === 0 ? "P0_PASS" : "P0_FAIL";
  const fs = require("fs");
  const path = require("path");
  const out = path.join("D:/Program/SPADE_WWW_EVIDENCE_V2_20261024", "PROTOCOL_INTEGRITY_TESTS.csv");
  const lines = ["case,expected,actual,pass,bad_delivered,bad_cached,runtime"];
  for (const row of rows) lines.push([row.case, row.expected, row.actual, row.pass, row.bad_delivered, row.bad_cached, row.runtime].map((value) => `"${String(value).replace(/"/g, '""')}"`).join(","));
  fs.writeFileSync(out, lines.join("\n") + "\n");
  console.log(JSON.stringify({ gate, cases: rows.length, failed: failed.map((row) => row.case), badDelivered, badCached, runtime: RUNTIME_VERSION }));
  if (gate !== "P0_PASS") process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
