"use strict";

function allowNew(fetchers, numFetchers, policy) {
  if (!policy) return fetchers.length < numFetchers;
  let headersPending = 0;
  let bodyActive = 0;
  for (const fetcher of fetchers) {
    if (fetcher.phase === "body") bodyActive += 1;
    else if (fetcher.phase === "headers") headersPending += 1;
  }
  return headersPending < policy.headers_pending_cap
    && headersPending + bodyActive < policy.headers_pending_cap + policy.body_active_cap;
}

const policy = { headers_pending_cap: 1, body_active_cap: 1 };
if (allowNew([{ phase: "headers" }], 2, policy) !== false) throw new Error("headers block");
if (allowNew([{ phase: "body" }], 2, policy) !== true) throw new Error("body releases header slot");
if (allowNew([{ phase: "body" }, { phase: "headers" }], 2, policy) !== false) throw new Error("total cap");
if (allowNew([{ phase: "fixed" }, { phase: "fixed" }], 2, null) !== false) throw new Error("fixed slots");
if (allowNew([{ phase: "fixed" }], 2, null) !== true) throw new Error("fixed room");
console.log("SPADE_V2_ADMIT_OK");
