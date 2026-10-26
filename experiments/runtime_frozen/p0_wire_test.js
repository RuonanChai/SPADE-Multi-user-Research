"use strict";

const { HandoffBuffer } = require("./client_handoff_buffer");
const { TrustedDigestStore, resolveMiss, fetchPeerChecked, sha256 } = require("./verified_peer");

const URL_A = "https://origin.example/scene.rad";
const GOOD = Buffer.from("0123456789abcdef");
const BAD = Buffer.from("0123456789abcdeX");
const V1 = '"v1-strong"';

function originOf(body) {
  return async () => ({
    statusCode: 206,
    headers: { etag: V1, "content-range": "bytes 0-15/100" },
    body,
    originTtfbMs: 4,
  });
}

async function main() {
  const buffer = new HandoffBuffer();
  await buffer.start();
  const key = `${URL_A}|0-15`;
  buffer.remember(key, GOOD);
  const store = new TrustedDigestStore();
  await resolveMiss({ peer: null, fetchOrigin: originOf(GOOD), store, url: URL_A, start: 0, end: 15 });
  const goodPeer = await fetchPeerChecked("127.0.0.1", key, 19081, 1500);
  const good = await resolveMiss({ peer: goodPeer, fetchOrigin: originOf(GOOD), store, url: URL_A, start: 0, end: 15 });
  buffer.remember(key, BAD);
  const badPeer = await fetchPeerChecked("127.0.0.1", key, 19081, 1500);
  const bad = await resolveMiss({ peer: badPeer, fetchOrigin: originOf(GOOD), store, url: URL_A, start: 0, end: 15 });
  buffer.server.close();
  const pass = good.source === "peer"
    && good.body.equals(GOOD)
    && good.sha256 === sha256(GOOD)
    && bad.peer_reject === "DIGEST_MISMATCH"
    && bad.body.equals(GOOD)
    && bad.cached === true
    && bad.source === "origin";
  console.log(JSON.stringify({
    gate: pass ? "P0_WIRE_PASS" : "P0_WIRE_FAIL",
    good: good.reason,
    bad: bad.peer_reject,
    goodStatus: goodPeer.statusCode,
    goodRange: goodPeer.headers && goodPeer.headers["content-range"],
  }));
  if (!pass) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
