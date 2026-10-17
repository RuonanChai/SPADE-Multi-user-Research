import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { Client } from "ssh2";

function parseArgs(argv) {
  const out = {
    server: "http://10.120.17.176:8082",
    users: 10,
    repeats: 5,
    duration: 120000,
    scene: "/examples/assets/splats/butterfly.spz",
    sceneVersion: "v2-remote",
    outDir: "results",
    remoteMetricsPath: "/home/ddddd/download/Spark2.0/spark-main/bench-data/metrics.jsonl",
    sshHost: "10.120.17.176",
    sshUser: "ddddd",
    sshPass: "ddddd",
    /** 单机多进程/多机时，第二台用 userOffset=2 避免与第一台 user0/user1 重名 */
    userOffset: 0,
    /** 仅起浏览器，不调用 /bench/start|stop，由总控先 start、两台都跑完后再 stop */
    orchestrated: false,
    runId: "",
    quality: "high",
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "server") out.server = v || out.server;
    else if (k === "users") out.users = Number.parseInt(v || "10", 10);
    else if (k === "repeats") out.repeats = Number.parseInt(v || "5", 10);
    else if (k === "duration") out.duration = Number.parseInt(v || "120000", 10);
    else if (k === "scene") out.scene = v || out.scene;
    else if (k === "scene_version") out.sceneVersion = v || out.sceneVersion;
    else if (k === "out") out.outDir = v || out.outDir;
    else if (k === "remoteMetricsPath") out.remoteMetricsPath = v || out.remoteMetricsPath;
    else if (k === "sshHost") out.sshHost = v || out.sshHost;
    else if (k === "sshUser") out.sshUser = v || out.sshUser;
    else if (k === "sshPass") out.sshPass = v || out.sshPass;
    else if (k === "userOffset") out.userOffset = Number.parseInt(v || "0", 10);
    else if (k === "orchestrated") out.orchestrated = v === "1" || v === "true";
    else if (k === "runId") out.runId = v || out.runId;
    else if (k === "quality") out.quality = v || out.quality;
  }
  return out;
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function stats(values) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return {
    count: nums.length,
    median: pct(nums, 50),
    p95: pct(nums, 95),
    min: nums[0] ?? null,
    max: nums[nums.length - 1] ?? null,
  };
}

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const v of arr) {
    const k = keyFn(v);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(v);
  }
  return m;
}

async function runOneRun({
  browser,
  server,
  runId,
  users,
  duration,
  scene,
  sceneVersion,
  quality,
  userOffset = 0,
  /** orchestrated 模式：不调用 /bench/start 与 /bench/stop，由总控负责 */
  skipStartStop = false,
}) {
  if (!skipStartStop) {
    await fetch(`${server}/bench/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: runId }),
    });
  }

  const contexts = [];
  try {
    await Promise.all(
      Array.from({ length: users }, async (_, i) => {
        const context = await browser.newContext({
          viewport: quality === "low" ? { width: 960, height: 540 } : { width: 1280, height: 720 },
        });
        contexts.push(context);
        const page = await context.newPage();
        const u = new URL(`${server}/bench`);
        u.searchParams.set("run_id", runId);
        u.searchParams.set("user_id", `user${i + userOffset}`);
        u.searchParams.set("scene", scene);
        u.searchParams.set("quality", quality);
        u.searchParams.set("duration", String(duration));
        u.searchParams.set("scene_version", sceneVersion);
        await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 120000 });
      }),
    );

    await new Promise((r) => setTimeout(r, duration + 8000));
  } finally {
    await Promise.all(contexts.map((c) => c.close().catch(() => {})));
    if (!skipStartStop) {
      await fetch(`${server}/bench/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_id: runId }),
      }).catch(() => {});
    }
  }
}

function sshExec({ host, username, password, command }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            reject(err);
            return;
          }
          let out = "";
          let errOut = "";
          stream.on("data", (d) => {
            out += d.toString();
          });
          stream.stderr.on("data", (d) => {
            errOut += d.toString();
          });
          stream.on("close", (code) => {
            conn.end();
            if (code === 0) resolve(out);
            else reject(new Error(errOut || out || `ssh exit ${code}`));
          });
        });
      })
      .on("error", reject)
      .connect({ host, username, password, readyTimeout: 20000 });
  });
}

function analyze(records) {
  const byRunUser = groupBy(records, (r) => `${r.run_id}::${r.user_id}`);
  const userRows = [];
  for (const [key, list] of byRunUser.entries()) {
    const [runId, userId] = key.split("::");
    const row = { run_id: runId, user_id: userId };
    for (const rec of list) {
      if (rec.phase === "render_stats" && rec.value && typeof rec.value === "object") {
        row.longtask_total_ms = Number(rec.value.longtask_total_ms);
        row.longtask_count = Number(rec.value.longtask_count);
        row.raf_jank_frames = Number(rec.value.raf_jank_frames);
      } else if (typeof rec.value === "number") {
        row[rec.phase] = rec.value;
      }
      if (rec.phase === "first_byte_gap" && rec.net_info?.server_timing) {
        row.server_timing = String(rec.net_info.server_timing);
      }
    }
    userRows.push(row);
  }

  const byGroup = groupBy(userRows, (r) => r.run_id.split("-")[1]); // A/B/C
  const summary = {};
  for (const [group, rows] of byGroup.entries()) {
    summary[group] = {
      wall_ms: stats(rows.map((r) => r.wall_ms)),
      first_byte_gap: stats(rows.map((r) => r.first_byte_gap)),
      first_frame_gap: stats(rows.map((r) => r.first_frame_gap)),
      worker_init: stats(rows.map((r) => r.worker_init)),
      longtask_total_ms: stats(rows.map((r) => r.longtask_total_ms)),
      longtask_count: stats(rows.map((r) => r.longtask_count)),
      raf_jank_frames: stats(rows.map((r) => r.raf_jank_frames)),
    };
  }

  const A = summary.A;
  const B = summary.B;
  const C = summary.C;
  const wallRise = A && B ? (B.wall_ms.median - A.wall_ms.median) / (A.wall_ms.median || 1) : null;
  const wallRecover = B && C ? (B.wall_ms.median - C.wall_ms.median) / (B.wall_ms.median || 1) : null;
  const byteRise = A && B
    ? (B.first_byte_gap.median - A.first_byte_gap.median) / (A.first_byte_gap.median || 1)
    : null;
  const jankRise = A && B
    ? (B.raf_jank_frames.median - A.raf_jank_frames.median) / ((A.raf_jank_frames.median || 0) + 1)
    : null;
  const longRise = A && B
    ? (B.longtask_total_ms.median - A.longtask_total_ms.median) / ((A.longtask_total_ms.median || 0) + 1)
    : null;

  let verdict = "mixed_or_uncertain";
  const networkStrong = (byteRise ?? 0) > 0.2;
  const renderStrong = (longRise ?? 0) > 0.3 || (jankRise ?? 0) > 0.3 || (wallRecover ?? 0) > 0.1;
  if (networkStrong && !renderStrong) verdict = "network_bottleneck_likely";
  else if (renderStrong && !networkStrong) verdict = "web_render_bottleneck_likely";
  else if (networkStrong && renderStrong) verdict = "mixed_bottleneck";

  return { userRows, summary, verdict, signals: { wallRise, wallRecover, byteRise, jankRise, longRise } };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.orchestrated) {
    if (!args.runId) {
      throw new Error("orchestrated=1 时需要 --runId=run-B-r1-xxxx（与总控 curl /bench/start 里一致）");
    }
    const browser = await chromium.launch({ headless: true });
    try {
      console.log(
        `[orchestrated] runId=${args.runId} users=${args.users} userOffset=${args.userOffset} quality=${args.quality}`,
      );
      await runOneRun({
        browser,
        server: args.server,
        runId: args.runId,
        users: args.users,
        duration: args.duration,
        scene: args.scene,
        sceneVersion: args.sceneVersion,
        quality: args.quality,
        userOffset: args.userOffset,
        skipStartStop: true,
      });
    } finally {
      await browser.close();
    }
    console.log("orchestrated worker done (no start/stop, no ssh)");
    return;
  }

  const baseStamp = Date.now();
  const runs = [];
  const groups = [
    { id: "A", users: 1, quality: "high" },
    { id: "B", users: args.users, quality: "high" },
    { id: "C", users: args.users, quality: "low" },
  ];

  const browser = await chromium.launch({ headless: true });
  try {
    for (const g of groups) {
      for (let i = 1; i <= args.repeats; i += 1) {
        const runId = `run-${g.id}-r${i}-${baseStamp}`;
        console.log(`[run] ${runId} users=${g.users} quality=${g.quality}`);
        await runOneRun({
          browser,
          server: args.server,
          runId,
          users: g.users,
          duration: args.duration,
          scene: args.scene,
          sceneVersion: args.sceneVersion,
          quality: g.quality,
          userOffset: args.userOffset,
        });
        runs.push(runId);
      }
    }
  } finally {
    await browser.close();
  }

  const rawJsonl = await sshExec({
    host: args.sshHost,
    username: args.sshUser,
    password: args.sshPass,
    command: `cat "${args.remoteMetricsPath}"`,
  });
  const lines = rawJsonl.split("\n").filter(Boolean);
  const records = lines.map((l) => JSON.parse(l)).filter((r) => runs.includes(r.run_id));
  const analysis = analyze(records);

  await fs.mkdir(args.outDir, { recursive: true });
  await fs.writeFile(path.join(args.outDir, "remote-metrics-filtered.json"), JSON.stringify(records, null, 2), "utf8");
  await fs.writeFile(path.join(args.outDir, "remote-analysis.json"), JSON.stringify(analysis, null, 2), "utf8");

  const summaryRows = ["group,metric,median,p95,count"];
  for (const [g, m] of Object.entries(analysis.summary)) {
    for (const [k, v] of Object.entries(m)) {
      summaryRows.push([g, k, v.median, v.p95, v.count].join(","));
    }
  }
  await fs.writeFile(path.join(args.outDir, "remote-summary.csv"), `${summaryRows.join("\n")}\n`, "utf8");

  const report = `# Remote Bench Result

- server: ${args.server}
- runs: ${runs.length}
- duration_ms: ${args.duration}
- verdict: ${analysis.verdict}

## Signals
- wallRise(A->B): ${analysis.signals.wallRise}
- wallRecover(B->C): ${analysis.signals.wallRecover}
- firstByteRise(A->B): ${analysis.signals.byteRise}
- jankRise(A->B): ${analysis.signals.jankRise}
- longTaskRise(A->B): ${analysis.signals.longRise}
`;
  await fs.writeFile(path.join(args.outDir, "remote-report.md"), report, "utf8");

  console.log(`done verdict=${analysis.verdict}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
