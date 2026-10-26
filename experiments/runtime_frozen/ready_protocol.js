"use strict";

const path = require("path");

function acceptReady(text, expected) {
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, reason: "EMPTY" };
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, reason: "CORRUPT" };
  }
  if (!doc || typeof doc !== "object") return { ok: false, reason: "CORRUPT" };
  if (doc.runId !== expected.runId) return { ok: false, reason: "RUN_MISMATCH" };
  if (doc.clientId !== expected.clientId) return { ok: false, reason: "CLIENT_MISMATCH" };
  if (doc.trace_loaded !== true) return { ok: false, reason: "TRACE_NOT_LOADED" };
  if (doc.frames_replayed_at_ready !== 0) return { ok: false, reason: "REPLAY_ALREADY_STARTED" };
  return { ok: true, doc };
}

function replaceFile(fs, partial, finalPath) {
  if (!fs.existsSync(finalPath)) {
    fs.renameSync(partial, finalPath);
    return;
  }
  const backup = `${finalPath}.old`;
  fs.renameSync(finalPath, backup);
  fs.renameSync(partial, finalPath);
  fs.unlinkSync(backup);
}

function writeReadyAtomic(fs, dir, doc) {
  const finalPath = path.join(dir, "READY");
  const partial = path.join(dir, "READY.partial");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(partial, JSON.stringify(doc));
  replaceFile(fs, partial, finalPath);
  return finalPath;
}

function receiveReady({ fs, localPath, expected, readRemote }) {
  if (fs.existsSync(localPath)) {
    const held = acceptReady(fs.readFileSync(localPath, "utf8"), expected);
    if (held.ok) return { ok: true, idempotent: true, doc: held.doc };
  }
  let remote;
  try {
    remote = readRemote();
  } catch (error) {
    return { ok: false, reason: "TRANSFER_FAILED", detail: String(error && error.message ? error.message : error) };
  }
  if (remote == null) return { ok: false, reason: "REMOTE_MISSING" };
  const accepted = acceptReady(remote, expected);
  if (!accepted.ok) return accepted;
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  const partial = `${localPath}.partial`;
  fs.writeFileSync(partial, JSON.stringify(accepted.doc));
  replaceFile(fs, partial, localPath);
  return { ok: true, idempotent: false, doc: accepted.doc };
}

module.exports = { acceptReady, writeReadyAtomic, receiveReady };
