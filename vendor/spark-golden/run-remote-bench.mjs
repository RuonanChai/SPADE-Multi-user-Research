import { Client } from "ssh2";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node:child_process";

function parseArgs(argv) {
  const out = {
    host: "10.120.171.176",
    user: "ddddd",
    pass: "ddddd",
    remotePort: 8080,
    remotePath: "/home/ddddd/download/Spark2.0/spark-main",
    users: 10,
    duration: 120,
    repeats: 5,
    page: "/examples/hello-world/",
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "host") out.host = v;
    else if (k === "user") out.user = v;
    else if (k === "pass") out.pass = v;
    else if (k === "port") out.remotePort = Number.parseInt(v || "8080", 10);
    else if (k === "remotePath") out.remotePath = v;
    else if (k === "users") out.users = Number.parseInt(v || "10", 10);
    else if (k === "duration") out.duration = Number.parseInt(v || "120", 10);
    else if (k === "repeats") out.repeats = Number.parseInt(v || "5", 10);
    else if (k === "page") out.page = v;
  }
  return out;
}

function sshExec(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      stream.on("close", (code) => resolve({ code, stdout, stderr }));
      stream.on("data", (d) => {
        stdout += d.toString();
      });
      stream.stderr.on("data", (d) => {
        stderr += d.toString();
      });
    });
  });
}

async function waitHttpOk(url, ms = 45000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    try {
      const r = await fetch(url, { method: "GET" });
      if (r.ok || r.status === 404) return true;
    } catch (_err) {
      // retry
    }
    await sleep(1000);
  }
  return false;
}

function runNode(command, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { stdio: "inherit", shell: false });
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Process exited with code ${code}`));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = `http://${args.host}:${args.remotePort}`;
  const conn = new Client();

  await new Promise((resolve, reject) => {
    conn
      .on("ready", resolve)
      .on("error", reject)
      .connect({
        host: args.host,
        port: 22,
        username: args.user,
        password: args.pass,
        readyTimeout: 20000,
      });
  });

  try {
    console.log(`[remote] connected: ${args.user}@${args.host}`);
    const startCmd = [
      "set -e",
      "export NVM_DIR=\"$HOME/.nvm\"",
      "[ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\"",
      "nvm use 20 >/dev/null 2>&1 || nvm use 18 >/dev/null 2>&1 || true",
      `BASE="${args.remotePath}"`,
      "if [ ! -d \"$BASE\" ]; then BASE=\"$HOME\"; fi",
      "cd \"$BASE\"",
      `nohup npx vite --host 0.0.0.0 --port ${args.remotePort} >/tmp/vite-bench.log 2>&1 & echo $! >/tmp/vite-bench.pid`,
      "echo \"BASE=$BASE\"",
      "echo \"NODE=$(node -v || true)\"",
      "echo \"PID=$(cat /tmp/vite-bench.pid)\"",
    ].join("; ");
    const startRes = await sshExec(conn, startCmd);
    if (startRes.code !== 0) {
      throw new Error(`remote start failed: ${startRes.stderr || startRes.stdout}`);
    }
    console.log(startRes.stdout.trim());

    const healthy = await waitHttpOk(`${baseUrl}/`, 60000);
    if (!healthy) throw new Error("remote service is not reachable on HTTP");
    console.log(`[remote] service ready: ${baseUrl}`);

    let runId = null;
    try {
      const r = await fetch(`${baseUrl}/bench/start`, { method: "POST" });
      if (r.ok) {
        const data = await r.json().catch(() => ({}));
        runId = data.run_id ?? data.runId ?? null;
      }
    } catch (_err) {
      // optional endpoint
    }
    if (runId) console.log(`[bench] run_id=${runId}`);
    else console.log("[bench] /bench/start unavailable, continue with direct page bench");

    const benchArgs = [
      "bench-10clients.js",
      `--server=${baseUrl}`,
      `--page=${args.page}`,
      `--users=${args.users}`,
      `--duration=${args.duration}`,
      `--repeats=${args.repeats}`,
    ];
    await runNode("node", benchArgs);

    try {
      await fetch(`${baseUrl}/bench/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(runId ? { run_id: runId } : {}),
      });
    } catch (_err) {
      // optional endpoint
    }
  } finally {
    try {
      await sshExec(
        conn,
        "if [ -f /tmp/vite-bench.pid ]; then kill $(cat /tmp/vite-bench.pid) >/dev/null 2>&1 || true; fi",
      );
    } catch (_err) {
      // ignore cleanup error
    }
    conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
