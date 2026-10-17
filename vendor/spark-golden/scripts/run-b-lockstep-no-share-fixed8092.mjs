/**
 * 单次 B-lockstep、instrumented 代理、固定 8092、不跑 shared_object_proxy。
 * 需：本机 8092 可 bind；worker2 可 SSH；config.client_server_url 主机对 worker2 可达（如 http://10.4.158.143:8092）。
 *
 *   node scripts/run-b-lockstep-no-share-fixed8092.mjs [--outRoot=results/fixed8092-b-lockstep-<ts>]
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function parseOutRoot(argv) {
  for (const arg of argv) {
    if (arg.startsWith("--outRoot=")) return arg.slice("--outRoot=".length);
  }
  return path.join("results", `fixed8092-b-lockstep-${Date.now()}`);
}

const outRoot = parseOutRoot(process.argv.slice(2));
const env = {
  ...process.env,
  SPARK_SHARED_OBJECT_PROXY: "0",
  SPARK_FIXED_PROXY_PORT: "1",
};

const args = [
  path.join(projectRoot, "scripts", "run-distributed-replay.mjs"),
  "--scenario=B-lockstep",
  "--distributed=1",
  "--durationMs=120000",
  "--skipShared=true",
  "--proxyPort=8092",
  `--outRoot=${outRoot}`,
];

const p = spawn(process.execPath, args, { cwd: projectRoot, stdio: "inherit", env });
p.on("exit", (c) => {
  process.exitCode = c ?? 1;
});
