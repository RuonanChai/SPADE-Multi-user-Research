/**
 * Worker2 Playwright shard needs only Node-side runner files.
 * Browser pages load from Worker1 Vite (client_instrument, traces, Spark scene).
 * Do NOT scp -r the whole vrc-paper/ tree.
 */
import fs from "node:fs";
import path from "node:path";

/** Required on Worker2 to run: node vrc-paper/experiments/run_experiment.mjs */
export const WORKER2_PUSH_PATHS = [
  "vrc-paper/experiments/run_experiment.mjs",
  "vrc-paper/experiments/visual_validator.mjs",
  "vrc-paper/experiments/distributed_lab.json",
];

/** Repo-root manifests (only if present). Worker2 needs node_modules + Playwright installed once locally. */
export const WORKER2_PUSH_ROOT_MANIFESTS = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

/**
 * @param {string} repoRoot spark-main root
 * @returns {{ rel: string, local: string }[]}
 */
export function collectWorker2PushFiles(repoRoot) {
  const out = [];
  for (const rel of WORKER2_PUSH_PATHS) {
    const local = path.join(repoRoot, ...rel.split("/"));
    if (!fs.existsSync(local)) {
      throw new Error(`worker2 push manifest missing file: ${rel}`);
    }
    out.push({ rel: rel.replace(/\\/g, "/"), local });
  }
  for (const rel of WORKER2_PUSH_ROOT_MANIFESTS) {
    const local = path.join(repoRoot, rel);
    if (fs.existsSync(local)) out.push({ rel, local });
  }
  return out;
}
