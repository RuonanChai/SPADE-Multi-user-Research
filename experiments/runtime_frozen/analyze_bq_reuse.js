"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = "F:/WWW_N3_MUX/research_control/SPADE_REUSE_AND_EXECUTE_20261019";
const BLOCK = [
  ["bq1_n2_lru_stop_go_synchronized_seed27190001", "LRU", false],
  ["bq2_n2_fifo_stop_go_synchronized_seed27190001", "FIFO", false],
  ["bq3_n2_sieve_stop_go_synchronized_seed27190001", "SIEVE", false],
  ["bq4_n2_s3fifo_stop_go_synchronized_seed27190001", "S3-FIFO", false],
  ["bq5_n2_ind_stop_go_synchronized_seed27190001", "IND", true],
];
const PREREG_BYTES_FRACTION = 0.05;
const PREREG_ONLINE_COVER = 0.5;

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function readJsonl(file) {
  return fs.readFileSync(file, "utf8").split(/\n/).filter(Boolean).map((line) => JSON.parse(line));
}
function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function writeCsv(file, header, rows) {
  const body = [header.join(","), ...rows.map((row) => header.map((key) => csvCell(row[key])).join(","))].join("\n") + "\n";
  fs.writeFileSync(file, body);
}
function ownerOf(userId) {
  const text = String(userId || "");
  if (text.includes("C3")) return "C3";
  if (text.includes("C4")) return "C4";
  return "UNATTRIBUTABLE";
}
function splitKey(key) {
  const parts = String(key || "").split("|");
  const range = parts.pop();
  const version = parts.shift();
  const url = parts.join("|");
  return { version, url, range, identity: `${url}|${range}` };
}
function clientDir(evidenceRoot, id) {
  const nested = path.join(evidenceRoot, id, id);
  if (fs.existsSync(path.join(nested, `${id}_evidence.json`))) return nested;
  return path.join(evidenceRoot, id);
}
function percentile(values, p) {
  if (!values.length) return "";
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}
function mean(values) {
  if (!values.length) return "";
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function bins(values) {
  const out = { lt_200: 0, b200_1000: 0, b1_5s: 0, gt_5s: 0 };
  for (const value of values) {
    if (value < 200) out.lt_200 += 1;
    else if (value < 1000) out.b200_1000 += 1;
    else if (value < 5000) out.b1_5s += 1;
    else out.gt_5s += 1;
  }
  return out;
}
function previewVersion(state, etag) {
  const next = { ...state };
  if (!etag || String(etag).startsWith("W/")) return { ...next, proven: false };
  if (next.conflict) return { ...next, proven: false };
  if (next.token && next.token !== etag) return { seen: 0, token: null, conflict: true, proven: false };
  next.token = etag;
  next.seen += 1;
  next.proven = next.seen >= 2;
  return next;
}
function commitVersion(state, etag) {
  return previewVersion(state, etag);
}

function loadCell(attempt, method, independent) {
  const wave = path.join(ROOT, "cells", attempt);
  const runId = fs.readdirSync(path.join(wave, "evidence"))[0];
  const evidenceRoot = path.join(wave, "evidence", runId);
  const runtime = path.join(evidenceRoot, "S_runtime");
  const clients = {};
  for (const id of ["C3", "C4"]) {
    const dir = clientDir(evidenceRoot, id);
    const evidenceFile = path.join(dir, `${id}_evidence.json`);
    clients[id] = fs.existsSync(evidenceFile) ? readJson(evidenceFile) : null;
  }
  return {
    attempt, method, independent, runId,
    decisions: readJsonl(path.join(runtime, "proxy_decisions.jsonl")),
    served: readJsonl(path.join(runtime, "proxy.jsonl")),
    contract: readJson(path.join(runtime, "runtime_contract.json")),
    clients,
  };
}

function windows(cell) {
  const starts = [];
  const ends = [];
  for (const id of ["C3", "C4"]) {
    const evidence = cell.clients[id];
    if (!evidence) continue;
    starts.push(Date.parse(evidence.measurement_start));
    ends.push(Date.parse(evidence.measurement_end));
  }
  if (starts.length < 2) return { ok: false };
  return {
    ok: true,
    commonStart: Math.max(...starts),
    commonEnd: Math.min(...ends),
    unionStart: Math.min(...starts),
    unionEnd: Math.max(...ends),
    skew: { C3: cell.clients.C3.measurement_start_skew_ms, C4: cell.clients.C4.measurement_start_skew_ms },
  };
}

function analyze(cell) {
  const nsMaps = new Map();
  function nsFor(user) { return cell.independent ? user : "SHARED"; }
  function nsState(user) {
    const key = nsFor(user);
    if (!nsMaps.has(key)) {
      nsMaps.set(key, { resident: new Map(), admitted: new Set(), evicted: new Set() });
    }
    return nsMaps.get(key);
  }
  const completed = new Map();
  const originByRequest = new Map();
  const version = { seen: 0, token: null, conflict: false, proven: false };
  const missRows = [];
  const evictionRows = [];
  const lags = [];
  const firstRequest = new Map();
  const residence = [];
  const censored = [];
  const reasons = {};
  const requestsByUser = { C3: 0, C4: 0, UNATTRIBUTABLE: 0 };
  const classes = {};
  let originErrors = [];
  const win = windows(cell);
  const byteScopes = {
    all: emptyScope(), common: emptyScope(), union: emptyScope(), before_common: emptyScope(),
  };

  function emptyScope() {
    return { c3: 0, c4: 0, unattributable: 0, total: 0, responses: 0, requests: 0, identities: new Set() };
  }
  function addScope(scope, ms, owner, bytes, identity, isResponse) {
    if (isResponse) {
      scope.total += bytes;
      scope.responses += 1;
      if (owner === "C3") scope.c3 += bytes;
      else if (owner === "C4") scope.c4 += bytes;
      else scope.unattributable += bytes;
      if (identity) scope.identities.add(identity);
    } else scope.requests += 1;
  }

  for (const row of cell.decisions) {
    const user = ownerOf(row.user_id);
    const parsed = row.cache_key ? splitKey(row.cache_key) : null;
    const ms = Number(row.origin_end_ms || row.request_start_ms || row.timestamp);

    if (row.type === "request") {
      requestsByUser[user] = (requestsByUser[user] || 0) + 1;
      if (parsed && !firstRequest.has(parsed.identity)) firstRequest.set(parsed.identity, { user, ms, users: new Set([user]) });
      else if (parsed && firstRequest.has(parsed.identity)) {
        const first = firstRequest.get(parsed.identity);
        if (!first.users.has(user)) {
          lags.push({ method: cell.method, identity: parsed.identity, lag_ms: ms - first.ms, first_user: first.user, second_user: user });
          first.users.add(user);
        }
      }
      for (const [name, scope] of Object.entries(byteScopes)) {
        const inside = name === "all" || (win.ok && (
          (name === "common" && ms >= win.commonStart && ms <= win.commonEnd) ||
          (name === "union" && ms >= win.unionStart && ms <= win.unionEnd) ||
          (name === "before_common" && ms < win.commonStart)
        ));
        if (inside) addScope(scope, ms, user, 0, parsed && parsed.identity, false);
      }
    }

    if (row.type === "cache_miss" && parsed) {
      const state = nsState(user);
      const prior = completed.get(parsed.identity);
      const priorUsers = prior ? prior.users : new Set();
      let missClass = "UNKNOWN";
      if (!prior) {
        missClass = prior && prior.errors ? "REPEATED_MISS_WITHOUT_CAPACITY_CAUSE" : "FIRST_USE";
        if (completed.get(`${parsed.identity}#error`)) missClass = "REPEATED_MISS_WITHOUT_CAPACITY_CAUSE";
      } else if (state.admitted.has(row.cache_key) && state.evicted.has(row.cache_key) && !state.resident.has(row.cache_key)) {
        missClass = "POST_INFLIGHT_REUSE_AFTER_EVICTION";
      } else if (prior.storeKeys && ![...prior.storeKeys].includes(row.cache_key)) {
        missClass = "VERSION_UNPROVEN";
      } else if (!state.evicted.has(row.cache_key)) {
        missClass = "REPEATED_MISS_WITHOUT_CAPACITY_CAUSE";
      } else missClass = "UNKNOWN";
      let reuseScope = "NONE";
      if (priorUsers.size) {
        const others = [...priorUsers].filter((item) => item !== user);
        reuseScope = others.length ? (cell.independent ? "CROSS_USER_NO_SHARED_CACHE" : "CROSS_USER") : "SAME_USER";
      }
      const record = {
        method: cell.method, request_id: row.request_id, user, identity: parsed.identity,
        lookup_key: row.cache_key, miss_class: missClass, reuse_scope: reuseScope,
        origin_bytes: 0, prior_completion: Boolean(prior), evicted_before_miss: state.evicted.has(row.cache_key),
        version_proven_at_miss: version.proven, timestamp: row.timestamp,
      };
      missRows.push(record);
      classes[missClass] = classes[missClass] || { n: 0, bytes: 0 };
    }

    if (row.type === "origin_response") {
      originByRequest.set(row.request_id, row);
      const responseKey = splitKey(row.cache_key || "");
      const owner = ownerOf(row.user_id);
      const bytes = Number(row.bytes) || 0;
      const next = previewVersion(version, row.etag);
      const storeVersion = next.proven && next.token ? next.token : "UNVERSIONED";
      const storeKey = `${storeVersion}|${responseKey.url}|${responseKey.range}`;
      const state = nsState(owner);
      const info = state.resident.get(storeKey) || {
        bytes, at: row.timestamp, users: new Set(), hits: 0, identity: responseKey.identity,
      };
      info.users.add(owner);
      info.bytes = bytes;
      info.at = row.origin_end_ms || row.timestamp;
      state.resident.set(storeKey, info);
      state.admitted.add(storeKey);
      const done = completed.get(responseKey.identity) || { users: new Set(), storeKeys: new Set(), bytes: 0, count: 0, firstBytes: bytes };
      if (done.count > 0) done.repeatBytes = (done.repeatBytes || 0) + bytes;
      done.count += 1;
      done.bytes += bytes;
      done.users.add(owner);
      done.storeKeys.add(storeKey);
      completed.set(responseKey.identity, done);
      for (const [name, scope] of Object.entries(byteScopes)) {
        const inside = name === "all" || (win.ok && (
          (name === "common" && row.origin_end_ms >= win.commonStart && row.origin_end_ms <= win.commonEnd) ||
          (name === "union" && row.origin_end_ms >= win.unionStart && row.origin_end_ms <= win.unionEnd) ||
          (name === "before_common" && row.origin_end_ms < win.commonStart)
        ));
        if (inside) addScope(scope, row.origin_end_ms, owner, bytes, responseKey.identity, true);
      }
      const miss = missRows.find((item) => item.request_id === row.request_id && item.origin_bytes === 0 && item.method === cell.method);
      if (miss) {
        miss.origin_bytes = bytes;
        classes[miss.miss_class].n += 1;
        classes[miss.miss_class].bytes += bytes;
        if (miss.miss_class === "POST_INFLIGHT_REUSE_AFTER_EVICTION") {
          const eviction = [...evictionRows].reverse().find((item) => item.victim_key === miss.lookup_key && !item.refetch_assigned);
          if (eviction) {
            eviction.retrospective_refetch_bytes += bytes;
            eviction.refetch_assigned = true;
          }
        }
      }
    }

    if (row.type === "cache_eviction") {
      const victim = splitKey(row.cache_key);
      const state = nsState(user);
      const info = state.resident.get(row.cache_key);
      let singleUserBytes = 0;
      for (const [key, resident] of state.resident) {
        if (key !== row.cache_key && resident.users.size < 2) singleUserBytes += resident.bytes;
      }
      const usersBefore = info ? info.users.size : 0;
      const opportunity = Boolean(info && info.users.size >= 2 && singleUserBytes > 0);
      reasons[row.reason || "NONE"] = (reasons[row.reason || "NONE"] || 0) + 1;
      const record = {
        method: cell.method,
        request_id: row.request_id,
        victim_key: row.cache_key,
        identity: victim.identity,
        victim_bytes: Number(row.bytes) || (info ? info.bytes : 0),
        users_before: usersBefore,
        hits_before: info ? info.hits : 0,
        resident_single_user_bytes: singleUserBytes,
        opportunity_online: opportunity,
        logged_reason: row.reason || "",
        retrospective_refetch_bytes: 0,
        residence_ms: info ? row.timestamp - info.at : "",
        refetch_assigned: false,
      };
      if (info && Number.isFinite(record.residence_ms)) residence.push(record.residence_ms);
      evictionRows.push(record);
      state.resident.delete(row.cache_key);
      state.evicted.add(row.cache_key);
    }

    if (row.type === "cache_hit" && parsed) {
      const state = nsState(user);
      const info = state.resident.get(row.cache_key);
      if (info) {
        info.hits += 1;
        info.users.add(user);
      }
    }

    if (row.type === "version_observation") version.seen = commitVersion(version, row.etag).seen, Object.assign(version, commitVersion({ ...version, seen: version.seen }, row.etag));

    if (row.type === "origin_error") {
      originErrors.push({ request_id: row.request_id, cache_key: row.cache_key, message: row.message, timestamp: row.timestamp });
      if (parsed) completed.set(`${parsed.identity}#error`, { errors: 1 });
    }
  }

  // version_observation commit above double-applies. Recompute is safer; leave counts from responses.
  for (const state of nsMaps.values()) {
    for (const info of state.resident.values()) censored.push(Date.now() - info.at);
  }
  const servedOrigin = cell.served.reduce((sum, row) => sum + (Number(row.bytes_from_origin) || 0), 0);
  const decisionOrigin = byteScopes.all.total;
  let repeatBytes = 0;
  let crossRepeat = 0;
  for (const done of completed.values()) {
    if (!done.repeatBytes) continue;
    repeatBytes += done.repeatBytes;
    if (done.users && done.users.size >= 2) crossRepeat += done.repeatBytes;
  }
  const classBytes = {};
  for (const [name, value] of Object.entries(classes)) classBytes[name] = value;
  const opportunityBytes = evictionRows.filter((row) => row.opportunity_online).reduce((sum, row) => sum + row.retrospective_refetch_bytes, 0);
  const capacityBytes = (classes.POST_INFLIGHT_REUSE_AFTER_EVICTION || { bytes: 0 }).bytes;
  const crossCapacity = missRows.filter((row) => row.miss_class === "POST_INFLIGHT_REUSE_AFTER_EVICTION" && row.reuse_scope === "CROSS_USER").reduce((sum, row) => sum + row.origin_bytes, 0);
  const sameCapacity = missRows.filter((row) => row.miss_class === "POST_INFLIGHT_REUSE_AFTER_EVICTION" && row.reuse_scope === "SAME_USER").reduce((sum, row) => sum + row.origin_bytes, 0);
  return {
    cell, win, missRows, evictionRows, lags, residence, censored, reasons, requestsByUser,
    byteScopes, servedOrigin, decisionOrigin, repeatBytes, crossRepeat, classBytes,
    opportunityBytes, capacityBytes, crossCapacity, sameCapacity, originErrors,
  };
}

// The version commit in the loop above is wrong if it double-applies. Rebuild version only
// from version_observation by rewriting analyze() cleanly below.

function analyzeClean(cell) {
  const completedByNs = new Map();
  const usersByIdentity = new Map();
  const errorIdentity = new Set();
  const nsMaps = new Map();
  function nsState(user) {
    const key = cell.independent ? ownerOf(user) : "SHARED";
    if (!nsMaps.has(key)) nsMaps.set(key, { resident: new Map(), admitted: new Set(), evicted: new Set() });
    return nsMaps.get(key);
  }
  const version = { seen: 0, token: null, conflict: false, proven: false };
  const missRows = [];
  const pendingMiss = new Map();
  const evictionRows = [];
  const lags = [];
  const firstRequest = new Map();
  const residence = [];
  const requestsByUser = { C3: 0, C4: 0, UNATTRIBUTABLE: 0 };
  const uniqueByUser = { C3: new Set(), C4: new Set(), UNATTRIBUTABLE: new Set() };
  const reasons = {};
  const originErrors = [];
  const win = windows(cell);
  const scopes = { all: blank(), common: blank(), union: blank(), before_common: blank(), union_not_common: blank() };
  function blank() { return { c3: 0, c4: 0, unattributable: 0, total: 0, responses: 0, requests: 0, identities: new Set() }; }
  function scopeNames(ms) {
    const names = ["all"];
    if (!win.ok) return names;
    if (ms >= win.commonStart && ms <= win.commonEnd) names.push("common");
    if (ms >= win.unionStart && ms <= win.unionEnd) names.push("union");
    if (ms < win.commonStart) names.push("before_common");
    if (ms >= win.unionStart && ms <= win.unionEnd && !(ms >= win.commonStart && ms <= win.commonEnd)) names.push("union_not_common");
    return names;
  }

  for (const row of cell.decisions) {
    const user = ownerOf(row.user_id);
    const parsed = row.cache_key ? splitKey(row.cache_key) : null;
    if (row.type === "request") {
      requestsByUser[user] += 1;
      const ms = Number(row.request_start_ms || row.timestamp);
      if (parsed) {
        uniqueByUser[user].add(parsed.identity);
        for (const name of scopeNames(ms)) scopes[name].requests += 1;
        const first = firstRequest.get(parsed.identity);
        if (!first) firstRequest.set(parsed.identity, { user, ms, users: new Set([user]) });
        else if (!first.users.has(user)) {
          lags.push(ms - first.ms);
          first.users.add(user);
        }
      }
    }
    if (row.type === "cache_miss" && parsed) {
      const state = nsState(row.user_id);
      const nsKey = cell.independent ? user : "SHARED";
      const prior = (completedByNs.get(nsKey) || new Map()).get(parsed.identity);
      const seenUsers = usersByIdentity.get(parsed.identity) || new Set();
      let missClass;
      if (!prior && !errorIdentity.has(`${nsKey}|${parsed.identity}`)) missClass = "FIRST_USE";
      else if (!prior && errorIdentity.has(`${nsKey}|${parsed.identity}`)) missClass = "REPEATED_MISS_WITHOUT_CAPACITY_CAUSE";
      else if (state.admitted.has(row.cache_key) && state.evicted.has(row.cache_key) && !state.resident.has(row.cache_key)) missClass = "POST_INFLIGHT_REUSE_AFTER_EVICTION";
      else if (prior && prior.storeKeys && !prior.storeKeys.has(row.cache_key)) missClass = "VERSION_UNPROVEN";
      else missClass = "REPEATED_MISS_WITHOUT_CAPACITY_CAUSE";
      const others = [...seenUsers].filter((item) => item !== user);
      const reuseScope = !seenUsers.size || (seenUsers.size === 1 && seenUsers.has(user)) ? (seenUsers.size ? "SAME_USER" : "NONE") : (cell.independent ? "CROSS_USER_NO_SHARED_CACHE" : "CROSS_USER");
      const record = {
        method: cell.method, request_id: row.request_id, user, identity: parsed.identity,
        lookup_key: row.cache_key, miss_class: missClass, reuse_scope: reuseScope, origin_bytes: 0,
        prior_completion: Boolean(prior), evicted_before_miss: state.evicted.has(row.cache_key),
        version_proven_at_miss: version.proven,
      };
      missRows.push(record);
      pendingMiss.set(row.request_id, record);
    }
    if (row.type === "origin_response" && parsed) {
      const bytes = Number(row.bytes) || 0;
      const next = previewVersion(version, row.etag);
      const storeVersion = next.proven && next.token ? next.token : "UNVERSIONED";
      const storeKey = `${storeVersion}|${parsed.url}|${parsed.range}`;
      const state = nsState(row.user_id);
      const info = state.resident.get(storeKey) || { bytes, at: Number(row.origin_end_ms || row.timestamp), users: new Set(), hits: 0 };
      info.bytes = bytes;
      info.at = Number(row.origin_end_ms || row.timestamp);
      info.users.add(user);
      state.resident.set(storeKey, info);
      state.admitted.add(storeKey);
      state.evicted.delete(storeKey);
      const nsKey = cell.independent ? user : "SHARED";
      if (!completedByNs.has(nsKey)) completedByNs.set(nsKey, new Map());
      const nsCompleted = completedByNs.get(nsKey);
      const done = nsCompleted.get(parsed.identity) || { users: new Set(), storeKeys: new Set(), repeatBytes: 0, count: 0 };
      if (done.count > 0) done.repeatBytes += bytes;
      done.count += 1;
      done.users.add(user);
      done.storeKeys.add(storeKey);
      nsCompleted.set(parsed.identity, done);
      const seenUsers = usersByIdentity.get(parsed.identity) || new Set();
      seenUsers.add(user);
      usersByIdentity.set(parsed.identity, seenUsers);
      const miss = pendingMiss.get(row.request_id);
      if (miss) miss.origin_bytes = bytes;
      for (const name of scopeNames(Number(row.origin_end_ms))) {
        const scope = scopes[name];
        scope.total += bytes;
        scope.responses += 1;
        scope.identities.add(parsed.identity);
        if (user === "C3") scope.c3 += bytes;
        else if (user === "C4") scope.c4 += bytes;
        else scope.unattributable += bytes;
      }
      if (miss && miss.miss_class === "POST_INFLIGHT_REUSE_AFTER_EVICTION") {
        const eviction = [...evictionRows].reverse().find((item) => item.victim_key === miss.lookup_key);
        if (eviction) eviction.retrospective_refetch_bytes += bytes;
      }
    }
    if (row.type === "cache_eviction") {
      const state = nsState(row.user_id);
      const info = state.resident.get(row.cache_key);
      let singleUserBytes = 0;
      for (const [key, resident] of state.resident) {
        if (key !== row.cache_key && resident.users.size < 2) singleUserBytes += Number(resident.bytes) || 0;
      }
      reasons[row.reason || "NONE"] = (reasons[row.reason || "NONE"] || 0) + 1;
      const residenceMs = info ? Number(row.timestamp) - info.at : "";
      if (info && Number.isFinite(residenceMs) && residenceMs >= 0) residence.push(residenceMs);
      evictionRows.push({
        method: cell.method, request_id: row.request_id, victim_key: row.cache_key,
        identity: parsed ? parsed.identity : "", victim_bytes: Number(row.bytes) || 0,
        users_before: info ? info.users.size : 0, hits_before: info ? info.hits : 0,
        resident_single_user_bytes: singleUserBytes,
        opportunity_online: Boolean(info && info.users.size >= 2 && singleUserBytes > 0),
        logged_reason: row.reason || "", retrospective_refetch_bytes: 0, residence_ms: residenceMs,
      });
      state.resident.delete(row.cache_key);
      state.evicted.add(row.cache_key);
    }
    if (row.type === "cache_hit" && parsed) {
      const info = nsState(row.user_id).resident.get(row.cache_key);
      if (info) { info.hits += 1; info.users.add(user); }
    }
    if (row.type === "version_observation") Object.assign(version, commitVersion(version, row.etag));
    if (row.type === "origin_error") {
      originErrors.push({ request_id: row.request_id, message: row.message, cache_key: row.cache_key });
      if (parsed) errorIdentity.add(`${cell.independent ? user : "SHARED"}|${parsed.identity}`);
    }
  }
  const servedOrigin = cell.served.reduce((sum, row) => sum + (Number(row.bytes_from_origin) || 0), 0);
  let repeatBytes = 0;
  for (const nsCompleted of completedByNs.values()) {
    for (const done of nsCompleted.values()) repeatBytes += done.repeatBytes || 0;
  }
  return { cell, win, missRows, evictionRows, lags, residence, reasons, requestsByUser, uniqueByUser, scopes, servedOrigin, repeatBytes, originErrors };
}

const results = [];
const missOut = [];
const evictOut = [];
const lagOut = [];
const originOut = [];
for (const [attempt, method, independent] of BLOCK) {
  const cell = loadCell(attempt, method, independent);
  const result = analyzeClean(cell);
  results.push(result);
  missOut.push(...result.missRows);
  evictOut.push(...result.evictionRows.map((row) => ({
    method: row.method, request_id: row.request_id, victim_key: row.victim_key, identity: row.identity,
    victim_bytes: row.victim_bytes, users_before: row.users_before, hits_before: row.hits_before,
    resident_single_user_bytes: row.resident_single_user_bytes, opportunity_online: row.opportunity_online,
    logged_reason: row.logged_reason, retrospective_refetch_bytes: row.retrospective_refetch_bytes,
    residence_ms: row.residence_ms,
  })));
  const lagBin = bins(result.lags);
  const resBin = bins(result.residence);
  lagOut.push(distRow(method, "cross_user_first_lag_ms", result.lags, lagBin));
  lagOut.push(distRow(method, "evicted_residence_ms", result.residence, resBin));
  for (const [name, scope] of Object.entries(result.scopes)) {
    originOut.push({
      method, scope: name, c3_bytes: scope.c3, c4_bytes: scope.c4, unattributable_bytes: scope.unattributable,
      total_bytes: scope.total, origin_responses: scope.responses, requests: scope.requests,
      unique_identities: scope.identities.size, served_origin_bytes: name === "all" ? result.servedOrigin : "",
      origin_match: name === "all" ? scope.total === result.servedOrigin : "",
      c3_requests: name === "all" ? result.requestsByUser.C3 : "",
      c4_requests: name === "all" ? result.requestsByUser.C4 : "",
      c3_unique: name === "all" ? result.uniqueByUser.C3.size : "",
      c4_unique: name === "all" ? result.uniqueByUser.C4.size : "",
      c3_skew_ms: result.win.ok ? result.win.skew.C3 : "",
      c4_skew_ms: result.win.ok ? result.win.skew.C4 : "",
      common_width_ms: result.win.ok ? result.win.commonEnd - result.win.commonStart : "",
      union_width_ms: result.win.ok ? result.win.unionEnd - result.win.unionStart : "",
    });
  }
}

function distRow(method, quantity, values, bin) {
  return {
    method, quantity, n: values.length, p50: percentile(values, 50), p90: percentile(values, 90),
    p99: percentile(values, 99), mean: mean(values), bin_lt_200ms: bin.lt_200,
    bin_200ms_1s: bin.b200_1000, bin_1s_5s: bin.b1_5s, bin_gt_5s: bin.gt_5s,
  };
}

function classSummary(result) {
  const out = {};
  for (const row of result.missRows) {
    const item = out[row.miss_class] || { n: 0, bytes: 0 };
    item.n += 1;
    item.bytes += row.origin_bytes;
    out[row.miss_class] = item;
  }
  return out;
}

const lru = results.find((item) => item.cell.method === "LRU");
const lruCommon = lru.scopes.common.total;
const summaries = results.map((result) => {
  const classes = classSummary(result);
  const crossCapacity = result.missRows.filter((row) => row.miss_class === "POST_INFLIGHT_REUSE_AFTER_EVICTION" && row.reuse_scope === "CROSS_USER").reduce((sum, row) => sum + row.origin_bytes, 0);
  const sameCapacity = result.missRows.filter((row) => row.miss_class === "POST_INFLIGHT_REUSE_AFTER_EVICTION" && row.reuse_scope === "SAME_USER").reduce((sum, row) => sum + row.origin_bytes, 0);
  const onlineBound = result.evictionRows.filter((row) => row.opportunity_online).reduce((sum, row) => sum + row.retrospective_refetch_bytes, 0);
  return { method: result.cell.method, classes, crossCapacity, sameCapacity, onlineBound, repeatBytes: result.repeatBytes, reasons: result.reasons, originErrors: result.originErrors, requestsByUser: result.requestsByUser };
});
const lruSummary = summaries.find((item) => item.method === "LRU");
const prereg = lruSummary.crossCapacity >= PREREG_BYTES_FRACTION * lruCommon && lruSummary.onlineBound >= PREREG_ONLINE_COVER * lruSummary.crossCapacity;

const proxyNow = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, "live_runtime/proxy.js"))).digest("hex");
const fifo = results.find((item) => item.cell.method === "FIFO");
const provenance = [
  { source: "SPADE_REUSE_AND_EXECUTE_20261019 BQ1-BQ5", method: "LRU|FIFO|SIEVE|S3-FIFO|IND", reuse_class: "PROSPECTIVE_THIS_BLOCK", independent_proof: "YES_FOR_THIS_BLOCK_ONLY", reason: "same seed 27190001 N=2 stop_go synchronized coit 50MiB/100; not a confirmation set for a later SPADE candidate" },
  { source: "D:/Program/P5_3DGS_ICASSP_CLEAN/research_archive/icassp_campaign_v1/ETHERNET_DEVELOPMENT_MASTER.csv", method: "SPADE/LRU development", reuse_class: "DEVELOPMENT_NOT_INDEPENDENT", independent_proof: "NO", reason: "151 development rows; earlier epoch and seeds; cannot confirm a candidate preregistered today" },
  { source: "D:/Program/P5_3DGS_ICASSP_CLEAN/research_archive/icassp_campaign_v1/WIFI_DEVELOPMENT_MASTER.csv", method: "IND/FIFO/LRU/SIEVE/SPADE", reuse_class: "DIFFERENT_MEDIUM", independent_proof: "NO", reason: "112 WiFi rows; not pooled with this Ethernet block" },
  { source: "SPADE_FINAL_SINGLEPASS_20261019 b1", method: "LRU/SPADE_F", reuse_class: "PRIOR_EPOCH_NOT_MATCHED", independent_proof: "NO", reason: "different seed; SPADE-F pair invalid on residual 6199.5ms" },
  { source: "BQ2 FIFO eviction label", method: "FIFO", reuse_class: "LABEL_AUDIT", independent_proof: "NO", reason: `runtime method FIFO sha ${fifo.cell.contract.scheduler_source_sha256}; current proxy.js sha ${proxyNow}; logged reasons ${JSON.stringify(fifo.reasons)}; matched_cache Fifo.admit sets FIFO_OLDEST; proxy uses item.reason||LRU_HEAD` },
  { source: "BQ2 origin_error", method: "FIFO", reuse_class: "PAIR_NOT_COMPARABLE", independent_proof: "NO", reason: fifo.originErrors.map((item) => `${item.request_id} ${item.message}`).join(";") || "none" },
];

writeCsv(path.join(ROOT, "REUSE_MISS_CLASSIFICATION.csv"), ["method", "request_id", "user", "identity", "lookup_key", "miss_class", "reuse_scope", "origin_bytes", "prior_completion", "evicted_before_miss", "version_proven_at_miss"], missOut);
writeCsv(path.join(ROOT, "ACTIONABLE_EVICTION_OPPORTUNITIES.csv"), ["method", "request_id", "victim_key", "identity", "victim_bytes", "users_before", "hits_before", "resident_single_user_bytes", "opportunity_online", "logged_reason", "retrospective_refetch_bytes", "residence_ms"], evictOut);
writeCsv(path.join(ROOT, "LAG_RESIDENCE_DISTRIBUTION.csv"), ["method", "quantity", "n", "p50", "p90", "p99", "mean", "bin_lt_200ms", "bin_200ms_1s", "bin_1s_5s", "bin_gt_5s"], lagOut);
writeCsv(path.join(ROOT, "ORIGIN_ACCOUNTING_AUDIT.csv"), ["method", "scope", "c3_bytes", "c4_bytes", "unattributable_bytes", "total_bytes", "origin_responses", "requests", "unique_identities", "served_origin_bytes", "origin_match", "c3_requests", "c4_requests", "c3_unique", "c4_unique", "c3_skew_ms", "c4_skew_ms", "common_width_ms", "union_width_ms"], originOut);
writeCsv(path.join(ROOT, "BASELINE_PROVENANCE_AUDIT.csv"), ["source", "method", "reuse_class", "independent_proof", "reason"], provenance);
fs.writeFileSync(path.join(ROOT, "BQ_MECHANISM_SUMMARY.json"), JSON.stringify({ prereg, lruCommon, summaries, bar: { fraction: PREREG_BYTES_FRACTION, cover: PREREG_ONLINE_COVER } }, null, 2));
console.log(JSON.stringify({ prereg, lruCommon, summaries: summaries.map((item) => ({ method: item.method, classes: item.classes, crossCapacity: item.crossCapacity, sameCapacity: item.sameCapacity, onlineBound: item.onlineBound, repeatBytes: item.repeatBytes, reasons: item.reasons, errors: item.originErrors.length, requests: item.requestsByUser })) }, null, 2));
