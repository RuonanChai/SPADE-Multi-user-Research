/**
 * Phase 2: PerformanceResourceTiming for .rad/.spz/.splat (page-side).
 */
(function () {
  "use strict";
  const CHUNK_RE = /\.(rad|spz|splat)(\?|#|$)/i;
  window.__vrcResourceTimingAudit = window.__vrcResourceTimingAudit || [];
  const seen = new Set();

  function pushEntry(e, flags) {
    const key = `${e.name}\t${e.startTime}\t${e.transferSize}`;
    if (seen.has(key)) return;
    seen.add(key);
    window.__vrcResourceTimingAudit.push({
      name: e.name,
      initiatorType: e.initiatorType || "",
      duration: e.duration,
      startTime: e.startTime,
      fetchStart: e.fetchStart,
      requestStart: e.requestStart,
      responseStart: e.responseStart,
      responseEnd: e.responseEnd,
      transferSize: e.transferSize,
      encodedBodySize: e.encodedBodySize,
      decodedBodySize: e.decodedBodySize,
      deliveryType: e.deliveryType || "",
      flags: flags || "",
      t: Date.now(),
    });
  }

  function scan() {
    try {
      const entries = performance.getEntriesByType("resource");
      for (const e of entries) {
        if (!CHUNK_RE.test(e.name)) continue;
        let flags = "";
        if (e.transferSize === 0 && e.encodedBodySize === 0 && e.duration > 0) {
          flags = "RESOURCE_TIMING_TAO_BLOCKED";
        } else if (e.transferSize === 0 && e.duration === 0) {
          flags = "RESOURCE_TIMING_ZERO";
        }
        pushEntry(e, flags);
      }
    } catch (err) {
      window.__vrcResourceTimingAudit.push({
        name: "__scan_error__",
        flags: `ERROR:${err?.message || err}`,
        t: Date.now(),
      });
    }
  }

  if (typeof PerformanceObserver !== "undefined") {
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (!CHUNK_RE.test(e.name)) continue;
          let flags = "";
          if (e.transferSize === 0 && e.encodedBodySize === 0 && e.duration > 0) {
            flags = "RESOURCE_TIMING_TAO_BLOCKED";
          }
          pushEntry(e, flags);
        }
      });
      po.observe({ type: "resource", buffered: true });
    } catch {
      scan();
    }
  }
  scan();
  window.__vrcFlushResourceTimingAudit = scan;
})();
