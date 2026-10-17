/**
 * VRC Scheduler
 * Implements all method strategies by intercepting fetch() calls.
 * Must be injected BEFORE the Spark module loads.
 *
 * VRC-guided hybrid CDN: when window.__vrcDeliveryProfile is
 * origin_only | vrc_guided_hybrid, asset fetches (.rad/.spz/.splat + Range)
 * are rewritten per sync chunk_delivery (see sync_server.mjs).
 * Legacy: empty or "legacy" profile — same behavior as pre-hybrid scheduler.
 */
(function () {
  "use strict";

  const __vrcNativeFetch = window.fetch.bind(window);
  const method = window.__vrcMethod ?? "Spark-MU";
  const cfg = window.__vrcConfig;
  const delivery = (window.__vrcDeliveryProfile ?? "").trim();
  const useHybrid = delivery === "origin_only" || delivery === "vrc_guided_hybrid";
  const trialIdx = (window.__vrcTrialIndex != null && Number.isFinite(Number(window.__vrcTrialIndex)))
    ? Number(window.__vrcTrialIndex)
    : null;

  function joinBase(base, rel) {
    const b = String(base || "").replace(/\/+$/, "");
    const r = String(rel || "").replace(/^\/+/, "");
    if (!b) return r;
    return `${b}/${r}`;
  }

  function chunkIdFromUrl(urlStr, chunkKey) {
    const m = /lod-(\d+)/.exec(String(urlStr));
    if (m) return m[1];
    const ck = String(chunkKey || "");
    const m2 = /lod-(\d+)/.exec(ck);
    if (m2) return m2[1];
    return ck.split("_")[0] || ck;
  }

  /** Tag bytes as shared vs personalized using latest VRC decision. */
  function deliveryReasonForChunk(urlStr, chunkKey, planReason) {
    const decision = window.__vrcLatestDecision || window.__vrcDecision;
    if (!decision) return planReason;
    const id = chunkIdFromUrl(urlStr, chunkKey);
    if (id && Array.isArray(decision.shared_chunks) && decision.shared_chunks.includes(id)) return "shared_hot";
    const uid = window.__vrcUserId ?? "u0";
    const pers = decision.personalized_chunks?.[uid];
    if (id && Array.isArray(pers) && pers.includes(id)) return "personalized";
    return planReason;
  }

  function emitSparkChunkTiming(chunkKey, tReq, tDone, bytes) {
    if (typeof window.__sparkExpEvent !== "function") return;
    try {
      window.__sparkExpEvent({ type: "fetch_enqueue", pathName: chunkKey, bytes, _t: tReq });
      window.__sparkExpEvent({ type: "fetch_response", pathName: chunkKey, bytes, _t_req: tReq, _t: tDone });
    } catch (_) { /* non-fatal */ }
  }

  /** When CDN2 uses a different object layout (e.g. GCS nested keys), map flat R2-style rel paths. */
  function remapCdn2Rel(rel) {
    const coitMap = (window.__vrcCdn2ObjectPath || "").trim().replace(/^\/+/, "");
    const hobMap = (window.__vrcCdn2ObjectPathHobbiton || "").trim().replace(/^\/+/, "");
    const r = String(rel || "");
    const flatCoit = "streaming-lod/coit-40m-sh1-lod.rad";
    const flatHob = "streaming-lod/tijerin_w6_hobbiton-lod.rad";
    if (coitMap && (r === flatCoit || r.startsWith(flatCoit + "?") || r.startsWith(flatCoit + "#"))) {
      return coitMap + r.slice(flatCoit.length);
    }
    if (hobMap && (r === flatHob || r.startsWith(flatHob + "?") || r.startsWith(flatHob + "#"))) {
      return hobMap + r.slice(flatHob.length);
    }
    return r;
  }

  function assetRelativeKey(urlStr) {
    const rb = window.__vrcRadBaseStr || "";
    const s = String(urlStr);
    if (rb && s.startsWith(rb)) return s.slice(rb.length).replace(/^\/+/, "");
    try {
      const u = new URL(s, location.href);
      return u.pathname.replace(/^\//, "") + u.search;
    } catch {
      return s;
    }
  }

  function pickChunkEntry(urlStr, chunk_delivery) {
    if (!chunk_delivery) return null;
    const keys = Object.keys(chunk_delivery);
    const s = String(urlStr);
    for (const k of keys) {
      if (s.includes(k)) return chunk_delivery[k];
    }
    const m = /lod-([^/?#]+)/i.exec(s);
    if (m) {
      const id = m[1];
      return chunk_delivery[id] || chunk_delivery[`lod-${id}`] || chunk_delivery[String(id)];
    }
    return null;
  }

  function hybridRewrite(urlStr, opts) {
    const rel = assetRelativeKey(urlStr);
    const d = window.__vrcLatestDecision || window.__vrcDecision;
    const cd = d && d.chunk_delivery;
    const prof = delivery;
    let source_selected = "hpc_server";
    let source_reason = "unknown_default_origin";
    let source_base = window.__vrcHpcBase || "";

    if (prof === "origin_only") {
      source_selected = "hpc_server";
      source_reason = "origin_only";
      source_base = window.__vrcHpcBase || "";
      return { finalUrl: joinBase(source_base, rel), source_selected, source_reason, source_base, rel };
    }
    if (prof === "static_cdn") {
      console.warn("[vrc] static_cdn deprecated — use vrc_guided_hybrid; routing via HPC");
      source_selected = "hpc_server";
      source_reason = "deprecated_static_cdn";
      source_base = window.__vrcHpcBase || "";
      return { finalUrl: joinBase(source_base, rel), source_selected, source_reason, source_base, rel };
    }
    const entry = pickChunkEntry(urlStr, cd);
    if (entry) {
      source_selected = entry.source_selected || "hpc_server";
      source_reason = entry.source_reason || "plan";
      source_base = entry.source_base || window.__vrcHpcBase || "";
      const outRel = source_selected === "cdn2" ? remapCdn2Rel(rel) : rel;
      return { finalUrl: joinBase(source_base, outRel), source_selected, source_reason, source_base, rel };
    }
    source_selected = "hpc_server";
    source_reason = "unknown_default_origin";
    source_base = window.__vrcHpcBase || "";
    return { finalUrl: joinBase(source_base, rel), source_selected, source_reason, source_base, rel };
  }

  function logSourceEvent(row) {
    window.__vrcSourceEvents = window.__vrcSourceEvents || [];
    window.__vrcSourceEvents.push(row);
  }

  function isAssetRangeFetch(urlStr, opts) {
    const s = String(urlStr);
    if (!/\.(rad|spz|splat)(\?|#|$)/i.test(s)) return false;
    if (!opts?.headers) return false;
    const h = opts.headers;
    const hasRange = typeof h.get === "function" ? h.get("range") : (h["Range"] || h["range"]);
    return !!hasRange;
  }

  function runFetchWithHybridLog(url, opts, passthroughChunkKeyFn) {
    const urlStr = String(url);
    const rw = useHybrid ? hybridRewrite(urlStr, opts) : { finalUrl: urlStr, source_selected: "legacy", source_reason: "legacy", source_base: "", rel: assetRelativeKey(urlStr) };
    const h = opts?.headers;
    const rangeKey = typeof h?.get === "function" ? h.get("range") : (h?.["Range"] || h?.["range"] || "");
    const planVer = (window.__vrcLatestDecision || window.__vrcDecision)?.fetch_plan_version ?? 0;
    const t0 = performance.now();
    let chunkKey = "";
    if (typeof passthroughChunkKeyFn === "function") chunkKey = passthroughChunkKeyFn(urlStr, rangeKey);
    const attempt = (finalU, sel, reason, fb) => {
      return __vrcNativeFetch(finalU, opts).then((resp) => {
        if (!resp.ok && useHybrid && window.__vrcCdnFallback !== false && sel !== "hpc_server" && window.__vrcHpcBase) {
          const hpcU = joinBase(window.__vrcHpcBase, rw.rel);
          return __vrcNativeFetch(hpcU, opts).then((r2) => {
            const t1 = performance.now();
            const cl = r2.headers?.get?.("content-length");
            const fbReason = deliveryReasonForChunk(urlStr, chunkKey, "fallback_from_cdn");
            emitSparkChunkTiming(chunkKey, t0, t1, cl ? Number(cl) : 0);
            logSourceEvent({
              user_id: window.__vrcUserId,
              cdn_label: window.__vrcCdnLabel || "",
              delivery_profile: delivery || "legacy",
              method: window.__vrcMethod,
              scenario_id: window.__vrcScenarioId,
              session_id: window.__vrcSessionId,
              trial: trialIdx,
              chunk_key: chunkKey,
              object_key: null,
              range_key: rangeKey,
              original_url: urlStr,
              final_url: hpcU,
              source_selected: "hpc_server",
              source_base: window.__vrcHpcBase,
              source_reason: fbReason,
              fallback_used: true,
              fetch_plan_version: planVer,
              request_start: t0,
              response_start: t1,
              complete: Date.now(),
              bytes: cl ? Number(cl) : 0,
              object_or_range_completion_ms: t1 - t0,
            });
            return r2;
          });
        }
        const t1 = performance.now();
        const cl = resp.headers?.get?.("content-length");
        const taggedReason = fb ? "fallback_from_cdn" : deliveryReasonForChunk(urlStr, chunkKey, reason);
        emitSparkChunkTiming(chunkKey, t0, t1, cl ? Number(cl) : 0);
        logSourceEvent({
          user_id: window.__vrcUserId,
          cdn_label: window.__vrcCdnLabel || "",
          delivery_profile: delivery || "legacy",
          method: window.__vrcMethod,
          scenario_id: window.__vrcScenarioId,
          session_id: window.__vrcSessionId,
          trial: trialIdx,
          chunk_key: chunkKey,
          object_key: null,
          range_key: rangeKey,
          original_url: urlStr,
          final_url: finalU,
          source_selected: sel,
          source_base: rw.source_base,
          source_reason: taggedReason,
          fallback_used: !!fb,
          fetch_plan_version: planVer,
          request_start: t0,
          response_start: t1,
          complete: Date.now(),
          bytes: cl ? Number(cl) : 0,
          object_or_range_completion_ms: t1 - t0,
        });
        return resp;
      });
    };
    return attempt(rw.finalUrl, rw.source_selected, rw.source_reason, false);
  }

  // ── Legacy (no hybrid profile) — preserve original behavior ───────────────────
  if (!useHybrid) {
    if (method === "Spark-MU" || method === "Full") {
      console.log(`[vrc] scheduler: passthrough (method=${method}) — fetch timing via __sparkExpEvent stub`);
      const origFetchPassthrough = __vrcNativeFetch;
      window.fetch = function (url, opts) {
        const urlStr = String(url);
        if (opts?.headers) {
          const h = opts.headers;
          const hasRange = typeof h.get === "function" ? h.get("range") : (h["Range"] || h["range"]);
          if (hasRange) {
            const chunkKey = urlStr.split("?")[0].split("/").pop() + "_" + (hasRange || "").replace(/bytes=/, "");
            const bytes = (() => {
              const rv = typeof h.get === "function" ? h.get("range") : (h["Range"] || h["range"] || "");
              const m = /bytes=(\d+)-(\d+)/.exec(rv);
              return m ? Number(m[2]) - Number(m[1]) + 1 : 0;
            })();
            if (typeof window.__sparkExpEvent === "function") {
              window.__sparkExpEvent({ type: "fetch_enqueue", object_id: chunkKey, bytes, _t: performance.now() });
            }
            const t0 = performance.now();
            return origFetchPassthrough(url, opts).then((resp) => {
              if (typeof window.__sparkExpEvent === "function") {
                window.__sparkExpEvent({ type: "fetch_response", object_id: chunkKey, bytes, _t: performance.now(), _t_req: t0 });
              }
              return resp;
            }).catch((err) => {
              if (typeof window.__sparkExpEvent === "function") {
                window.__sparkExpEvent({ type: "chunk_error", object_id: chunkKey, _t: performance.now() });
              }
              throw err;
            });
          }
        }
        return origFetchPassthrough(url, opts);
      };
      return;
    }

    const origFetch = __vrcNativeFetch;
    let inflightBytes = 0;
    let inflightCount = 0;
    const recentCompletions = [];

    function isRangeRequest(url, opts) {
      const h = opts?.headers;
      if (!h) return false;
      if (typeof h.get === "function") return !!h.get("range");
      if (typeof h === "object") {
        const keys = Object.keys(h).map((k) => k.toLowerCase());
        return keys.includes("range");
      }
      return false;
    }

    function estimateBytes(opts) {
      const h = opts?.headers;
      if (!h) return 0;
      const rangeVal = typeof h.get === "function" ? h.get("range") : h["Range"] ?? h["range"] ?? "";
      if (!rangeVal) return 0;
      const m = /bytes=(\d+)-(\d+)/.exec(rangeVal);
      if (!m) return 0;
      return Number(m[2]) - Number(m[1]) + 1;
    }

    function shouldPace() {
      if (method === "VP-S" || method === "VRC-V") return false;
      if (method === "NET-S" || method === "VRC" || method === "VRC-N") return true;
      return false;
    }

    function isNetworkSafe() {
      if (!shouldPace()) return true;
      return inflightBytes < cfg.max_inflight_bytes;
    }

    const queue = [];
    let queueRunning = false;

    function drainQueue() {
      if (queueRunning || !queue.length) return;
      if (!isNetworkSafe()) {
        setTimeout(drainQueue, 10);
        return;
      }
      queueRunning = true;
      const { resolve, url, opts, estimatedBytes } = queue.shift();
      queueRunning = false;

      inflightBytes += estimatedBytes;
      inflightCount++;
      window.__vrcRawMetrics && (window.__vrcRawMetrics.inflight_bytes = inflightBytes);

      const t0 = performance.now();
      origFetch(url, opts)
        .then((resp) => {
          const dt = performance.now() - t0;
          inflightBytes = Math.max(0, inflightBytes - estimatedBytes);
          inflightCount = Math.max(0, inflightCount - 1);
          recentCompletions.push(dt);
          if (recentCompletions.length > 10) recentCompletions.shift();
          setTimeout(drainQueue, 0);
          resolve(resp);
        })
        .catch((err) => {
          inflightBytes = Math.max(0, inflightBytes - estimatedBytes);
          inflightCount = Math.max(0, inflightCount - 1);
          setTimeout(drainQueue, 0);
          resolve(Promise.reject(err));
        });

      setTimeout(drainQueue, 0);
    }

    function getPriority(url) {
      if (method === "NET-S" || method === "VRC-N") return 0;
      const decision = window.__vrcLatestDecision || window.__vrcDecision;
      if (!decision) return 0;
      const urlStr = String(url);
      const chunkMatch = /lod-(\d+)/.exec(urlStr);
      if (!chunkMatch) return 0;
      const chunkId = chunkMatch[1];
      if (decision.shared_chunks?.includes(chunkId)) return 2;
      const uid = window.__vrcUserId ?? "u0";
      if (decision.personalized_chunks?.[uid]?.includes(chunkId)) return 1;
      return 0;
    }

    window.fetch = function (url, opts) {
      if (!isRangeRequest(url, opts)) {
        return origFetch(url, opts);
      }
      const estimatedBytes = estimateBytes(opts);
      const priority = getPriority(url);

      return new Promise((resolve) => {
        const entry = { resolve, url, opts, estimatedBytes, priority };
        if (priority > 0) {
          let idx = 0;
          while (idx < queue.length && queue[idx].priority >= priority) idx++;
          queue.splice(idx, 0, entry);
        } else {
          queue.push(entry);
        }
        setTimeout(drainQueue, 0);
      });
    };

    console.log(`[vrc] scheduler active: method=${method} pace=${shouldPace()}`);
    return;
  }

  // ── Hybrid delivery profiles (same pacing branches, URL rewrite at fetch) ────
  console.log(`[vrc] scheduler: hybrid delivery_profile=${delivery}`);

  if (method === "Spark-MU" || method === "Full") {
    window.fetch = function (url, opts) {
      const urlStr = String(url);
      if (opts?.headers && isAssetRangeFetch(urlStr, opts)) {
        const h = opts.headers;
        const hasRange = typeof h.get === "function" ? h.get("range") : (h["Range"] || h["range"]);
        const chunkKey = urlStr.split("?")[0].split("/").pop() + "_" + (hasRange || "").replace(/bytes=/, "");
        const bytes = (() => {
          const rv = typeof h.get === "function" ? h.get("range") : (h["Range"] || h["range"] || "");
          const m = /bytes=(\d+)-(\d+)/.exec(rv);
          return m ? Number(m[2]) - Number(m[1]) + 1 : 0;
        })();
        if (typeof window.__sparkExpEvent === "function") {
          window.__sparkExpEvent({ type: "fetch_enqueue", object_id: chunkKey, bytes, _t: performance.now() });
        }
        return runFetchWithHybridLog(url, opts, () => chunkKey).then((resp) => {
          if (typeof window.__sparkExpEvent === "function") {
            window.__sparkExpEvent({ type: "fetch_response", object_id: chunkKey, bytes, _t: performance.now() });
          }
          return resp;
        }).catch((err) => {
          if (typeof window.__sparkExpEvent === "function") {
            window.__sparkExpEvent({ type: "chunk_error", object_id: chunkKey, _t: performance.now() });
          }
          throw err;
        });
      }
      return __vrcNativeFetch(url, opts);
    };
    return;
  }

  const origFetch = __vrcNativeFetch;
  let inflightBytes = 0;
  let inflightCount = 0;
  const recentCompletions = [];

  function estimateBytes(opts) {
    const h = opts?.headers;
    if (!h) return 0;
    const rangeVal = typeof h.get === "function" ? h.get("range") : h["Range"] ?? h["range"] ?? "";
    if (!rangeVal) return 0;
    const m = /bytes=(\d+)-(\d+)/.exec(rangeVal);
    if (!m) return 0;
    return Number(m[2]) - Number(m[1]) + 1;
  }

  function shouldPace() {
    if (method === "VP-S" || method === "VRC-V") return false;
    if (method === "NET-S" || method === "VRC" || method === "VRC-N") return true;
    return false;
  }

  function isNetworkSafe() {
    if (!shouldPace()) return true;
    return inflightBytes < cfg.max_inflight_bytes;
  }

  const queue = [];
  let queueRunning = false;

  function drainQueue() {
    if (queueRunning || !queue.length) return;
    if (!isNetworkSafe()) {
      setTimeout(drainQueue, 10);
      return;
    }
    queueRunning = true;
    const { resolve, url, opts, estimatedBytes } = queue.shift();
    queueRunning = false;

    inflightBytes += estimatedBytes;
    inflightCount++;
    window.__vrcRawMetrics && (window.__vrcRawMetrics.inflight_bytes = inflightBytes);

    const urlStr = String(url);
    const rw = hybridRewrite(urlStr, opts);
    const h = opts?.headers;
    const rangeKey = typeof h?.get === "function" ? h.get("range") : (h?.["Range"] || h?.["range"] || "");
    const chunkMatch = /lod-(\d+)/.exec(urlStr);
    const chunkKey = chunkMatch ? chunkMatch[1] : urlStr.split("?")[0].split("/").pop();
    const planVer = (window.__vrcLatestDecision || window.__vrcDecision)?.fetch_plan_version ?? 0;
    const t0 = performance.now();

    const doOne = (finalU, sel, reason, isFb) => {
      return origFetch(finalU, opts).then((resp) => {
        if (!resp.ok && window.__vrcCdnFallback !== false && sel !== "hpc_server" && window.__vrcHpcBase) {
          const hpcU = joinBase(window.__vrcHpcBase, rw.rel);
          return origFetch(hpcU, opts).then((r2) => {
            const t1 = performance.now();
            const cl = r2.headers?.get?.("content-length");
            const fbReason3 = deliveryReasonForChunk(urlStr, chunkKey, "fallback_from_cdn");
            emitSparkChunkTiming(chunkKey, t0, t1, cl ? Number(cl) : 0);
            logSourceEvent({
              user_id: window.__vrcUserId,
              cdn_label: window.__vrcCdnLabel || "",
              delivery_profile: delivery,
              method: window.__vrcMethod,
              scenario_id: window.__vrcScenarioId,
              session_id: window.__vrcSessionId,
              trial: trialIdx,
              chunk_key: chunkKey,
              range_key: rangeKey,
              original_url: urlStr,
              final_url: hpcU,
              source_selected: "hpc_server",
              source_base: window.__vrcHpcBase,
              source_reason: fbReason3,
              fallback_used: true,
              fetch_plan_version: planVer,
              request_start: t0,
              response_start: t1,
              complete: Date.now(),
              bytes: cl ? Number(cl) : 0,
              object_or_range_completion_ms: t1 - t0,
            });
            inflightBytes = Math.max(0, inflightBytes - estimatedBytes);
            inflightCount = Math.max(0, inflightCount - 1);
            recentCompletions.push(performance.now() - t0);
            if (recentCompletions.length > 10) recentCompletions.shift();
            setTimeout(drainQueue, 0);
            resolve(r2);
          });
        }
        const t1 = performance.now();
        const cl = resp.headers?.get?.("content-length");
        const taggedReason2 = isFb ? "fallback_from_cdn" : deliveryReasonForChunk(urlStr, chunkKey, reason);
        emitSparkChunkTiming(chunkKey, t0, t1, cl ? Number(cl) : 0);
        logSourceEvent({
          user_id: window.__vrcUserId,
          cdn_label: window.__vrcCdnLabel || "",
          delivery_profile: delivery,
          method: window.__vrcMethod,
          scenario_id: window.__vrcScenarioId,
          session_id: window.__vrcSessionId,
          trial: trialIdx,
          chunk_key: chunkKey,
          range_key: rangeKey,
          original_url: urlStr,
          final_url: finalU,
          source_selected: sel,
          source_base: rw.source_base,
          source_reason: taggedReason2,
          fallback_used: !!isFb,
          fetch_plan_version: planVer,
          request_start: t0,
          response_start: t1,
          complete: Date.now(),
          bytes: cl ? Number(cl) : 0,
          object_or_range_completion_ms: t1 - t0,
        });
        inflightBytes = Math.max(0, inflightBytes - estimatedBytes);
        inflightCount = Math.max(0, inflightCount - 1);
        recentCompletions.push(performance.now() - t0);
        if (recentCompletions.length > 10) recentCompletions.shift();
        setTimeout(drainQueue, 0);
        resolve(resp);
      }).catch((err) => {
        inflightBytes = Math.max(0, inflightBytes - estimatedBytes);
        inflightCount = Math.max(0, inflightCount - 1);
        setTimeout(drainQueue, 0);
        resolve(Promise.reject(err));
      });
    };

    doOne(rw.finalUrl, rw.source_selected, rw.source_reason, false);
    setTimeout(drainQueue, 0);
  }

  function isRangeRequest(url, opts) {
    const h = opts?.headers;
    if (!h) return false;
    if (typeof h.get === "function") return !!h.get("range");
    if (typeof h === "object") {
      const keys = Object.keys(h).map((k) => k.toLowerCase());
      return keys.includes("range");
    }
    return false;
  }

  function getPriority(url) {
    if (method === "NET-S" || method === "VRC-N") return 0;
    const decision = window.__vrcLatestDecision || window.__vrcDecision;
    if (!decision) return 0;
    const urlStr = String(url);
    const chunkMatch = /lod-(\d+)/.exec(urlStr);
    if (!chunkMatch) return 0;
    const chunkId = chunkMatch[1];
    if (decision.shared_chunks?.includes(chunkId)) return 2;
    const uid = window.__vrcUserId ?? "u0";
    if (decision.personalized_chunks?.[uid]?.includes(chunkId)) return 1;
    return 0;
  }

  window.fetch = function (url, opts) {
    if (!isRangeRequest(url, opts)) {
      return origFetch(url, opts);
    }
    const estimatedBytes = estimateBytes(opts);
    const priority = getPriority(url);

    return new Promise((resolve) => {
      const entry = { resolve, url, opts, estimatedBytes, priority };
      if (priority > 0) {
        let idx = 0;
        while (idx < queue.length && queue[idx].priority >= priority) idx++;
        queue.splice(idx, 0, entry);
      } else {
        queue.push(entry);
      }
      setTimeout(drainQueue, 0);
    });
  };

  console.log(`[vrc] scheduler active (hybrid): method=${method} pace=${shouldPace()}`);
})();
