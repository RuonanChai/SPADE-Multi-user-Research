/**
 * Side-effect bootstrap: must be the first import of run_experiment_distributed.mjs so
 * run_experiment.mjs (pulled in via vrc_distributed_merge) sees worker1 identity when
 * VRC_DISTRIBUTED=true is inherited from the parent PowerShell session.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function labPath() {
  if (process.env.VRC_DISTRIBUTED_CONFIG) {
    return path.resolve(process.env.VRC_DISTRIBUTED_CONFIG);
  }
  return path.join(ROOT, "experiments", "distributed_lab.json");
}

export function applyDistributedOrchestratorEnv() {
  if (process.env.VRC_DISTRIBUTED !== "true") return;
  if ((process.env.VRC_WORKER_ID ?? "").trim() && (process.env.VRC_HOST_IP ?? "").trim()) {
    return;
  }
  const cfgFile = labPath();
  if (!fs.existsSync(cfgFile)) return;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  } catch {
    return;
  }
  const controllerHost = String(cfg.controller_host ?? process.env.VRC_CONTROLLER_HOST ?? "").trim();
  const vitePort = String(cfg.vite_port ?? process.env.VITE_PORT ?? 9200);
  const syncPort = String(cfg.sync_port ?? process.env.VRC_SYNC_PORT ?? 9201);
  if (!controllerHost) return;

  process.env.VRC_WORKER_ID = "worker1";
  process.env.VRC_HOST_IP = controllerHost;
  process.env.VRC_CONTROLLER_HOST = controllerHost;
  process.env.VRC_USER_INDICES = process.env.VRC_USER_INDICES?.trim() || "0,1";
  process.env.VITE_PORT = vitePort;
  process.env.VRC_SYNC_PORT = syncPort;
  process.env.VRC_SYNC_HTTP_HOST = process.env.VRC_SYNC_HTTP_HOST?.trim() || controllerHost;
}

applyDistributedOrchestratorEnv();
