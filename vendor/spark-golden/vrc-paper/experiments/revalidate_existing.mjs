// Revalidate all screenshots in existing results/raw/* runs with the new
// pixel-level validator. Rewrites visual_check.json and marks status.json
// as FAIL_VISUAL_BLACK_SCREEN if any screenshot fails.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildVisualCheck } from "./visual_validator.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW  = path.join(ROOT, "results", "raw");
const SS   = path.join(ROOT, "results", "screenshots");
const NUM_USERS = 4;

const dirs = fs.readdirSync(RAW).filter(d => {
  try { return fs.statSync(path.join(RAW, d)).isDirectory(); } catch { return false; }
});

let nRun = 0, nVisualFail = 0;
for (const d of dirs) {
  const runDir = path.join(RAW, d);
  const sessionId = d;
  const visual = buildVisualCheck(sessionId, SS, NUM_USERS);
  fs.writeFileSync(path.join(runDir, "visual_check.json"), JSON.stringify(visual, null, 2));

  // If visual FAIL, patch status.json to reflect FAIL_VISUAL_BLACK_SCREEN.
  const statusFile = path.join(runDir, "status.json");
  let st = {};
  try { st = JSON.parse(fs.readFileSync(statusFile, "utf8")); } catch {}
  st.visual_status = visual.summary.overall_status;
  st.visual_failures = visual.summary.failures;
  if (!visual.summary.all_valid) {
    st.status = "FAIL_VISUAL_BLACK_SCREEN";
    nVisualFail++;
  }
  fs.writeFileSync(statusFile, JSON.stringify(st, null, 2));
  nRun++;
  console.log(`[revalidate] ${sessionId} -> ${visual.summary.overall_status} (${visual.summary.users_valid}/${NUM_USERS})`);
}
console.log(`\nTotal runs revalidated: ${nRun}, visual FAIL: ${nVisualFail}`);
