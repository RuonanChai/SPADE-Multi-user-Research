/**
 * Analysis pipeline orchestrator — runs all analysis steps in sequence.
 * Usage: node vrc-paper/analysis/run_analysis.mjs [--results-root <path>]
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RESULTS_ROOT = process.env.VRC_RESULTS_ROOT || path.join(ROOT, "results");

const steps = [
  { name: "aggregate", cmd: `node "${path.join(__dirname, "aggregate.mjs")}"` },
  { name: "source_breakdown", cmd: `node "${path.join(__dirname, "source_breakdown_aggregator.mjs")}"` },
  { name: "validate_canary", cmd: `node "${path.join(__dirname, "validate_canary.mjs")}"`, allowFail: true },
  { name: "generate_figures", cmd: `node "${path.join(__dirname, "generate_figures.mjs")}"` },
  { name: "generate_report", cmd: `node "${path.join(__dirname, "generate_report.mjs")}"` },
];

let failures = 0;
for (const step of steps) {
  console.log(`\n=== [${step.name}] ===`);
  try {
    execSync(step.cmd, {
      cwd: ROOT,
      env: { ...process.env, VRC_RESULTS_ROOT: RESULTS_ROOT },
      stdio: "inherit",
    });
  } catch (e) {
    if (step.allowFail) {
      console.log(`  [${step.name}] non-fatal exit (canary may have failures)`);
    } else {
      console.error(`  [${step.name}] FAILED: ${e.message}`);
      failures++;
    }
  }
}

console.log(`\n=== Analysis complete: ${failures} failures ===`);
process.exit(failures > 0 ? 1 : 0);
