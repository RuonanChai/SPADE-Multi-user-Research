/**
 * Verify Worker2 SSH reachability from distributed_lab.json
 *   node scripts/verify-worker2-connectivity.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lab = JSON.parse(
  fs.readFileSync(path.join(root, "vrc-paper/experiments/distributed_lab.json"), "utf8"),
);

const host = lab.ssh_host;
const user = lab.ssh_user;
const port = lab.ssh_port ?? 22;
const key = (lab.ssh_key_path || "").replace(/\\/g, "/");
const login = `${user}@${host}`;

function run(cmd, args, timeoutMs = 15000) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
    error: r.error?.message,
  };
}

console.log("=== Worker2 connectivity ===");
console.log(`lab: ${login}:${port}`);
console.log(`key: ${key || "(default)"}`);
console.log(`controller: ${lab.controller_host}`);

const ping = run("ping", ["-n", "2", host]);
console.log(`\n[ping] ${ping.ok ? "OK" : "FAIL (ICMP may be blocked — SSH is authoritative)"}`);
if (ping.stdout) console.log(ping.stdout.split("\n").slice(-4).join("\n"));
if (!ping.ok && ping.stderr) console.log(ping.stderr);

const sshArgs = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-p",
  String(port),
];
if (key) sshArgs.push("-i", key);
sshArgs.push(login, "echo SSH_OK && whoami && hostname");

const ssh = run("ssh", sshArgs, 20000);
console.log(`\n[ssh] ${ssh.ok ? "OK" : "FAIL"}`);
if (ssh.stdout) console.log(ssh.stdout);
if (!ssh.ok) console.log(ssh.stderr || ssh.error);

const portTest = run(
  "powershell",
  [
    "-NoProfile",
    "-Command",
    `(Test-NetConnection -ComputerName ${host} -Port ${port} -WarningAction SilentlyContinue).TcpTestSucceeded`,
  ],
  20000,
);
console.log(`\n[tcp:${port}] ${portTest.stdout === "True" ? "OK" : "FAIL"} (${portTest.stdout || portTest.stderr})`);

const ok = ssh.ok;
if (!ping.ok && ssh.ok) {
  console.log("\n[note] ping failed but SSH OK — Worker2 reachable for distributed runs.");
}
console.log(`\n=== ${ok ? "REACHABLE" : "NOT_READY"} ===`);
process.exitCode = ok ? 0 : 1;
