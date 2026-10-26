"use strict";

const fs = require("fs");
const path = require("path");

const OLD = "D:\\Program\\SPADE_F_PROSPECTIVE_DIAG_20261018\\";
const NEW = "D:\\Program\\SPADE_REUSE_AND_EXECUTE_20261019\\";
const c1 = "D:\\Program\\SPADE_POST_A4_PROSPECTIVE_20261019\\c1_n2_lru_staggered_seed26101911\\evidence\\run\\C3";
const b1 = "D:\\Program\\SPADE_REUSE_AND_EXECUTE_20261019\\cell\\evidence\\run\\C3";

function allows(root, dir) {
  return path.resolve(dir).toLowerCase().startsWith(path.resolve(root).toLowerCase());
}

if (allows(OLD, c1)) throw new Error("C1_PATH_SHOULD_HAVE_FAILED_OLD_ALLOWLIST");
if (allows(NEW, c1)) throw new Error("C1_PATH_MUST_STAY_OUTSIDE_NEW_EPOCH");
if (!allows(NEW, b1)) throw new Error("B1_PATH_SHOULD_PASS");

const worker = fs.readFileSync(path.join(__dirname, "remote_worker_bundle.js"), "utf8");
if (!worker.includes("const REMOTE_ALLOW = 'D:\\\\Program\\\\SPADE_REUSE_AND_EXECUTE_20261019';")) {
  throw new Error("WORKER_ALLOWLIST_NOT_REPAIRED");
}
if (worker.includes("SPADE_F_PROSPECTIVE_DIAG_20261018")) throw new Error("OLD_ALLOWLIST_STILL_PRESENT");
if (!/Math\.abs\(measurementStartSkewMs\) > 3000/.test(worker)) throw new Error("RESIDUAL_LIMIT_CHANGED");
console.log("ISOLATION_COUNTERFACTUAL_PASS");
