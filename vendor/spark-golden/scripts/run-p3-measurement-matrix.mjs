/**
 * P3 最小测量矩阵：顺序跑 A / B / C，每组后 validate + analyze + export，最后写 p3-summary.json。
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const o = {
    server: "",
    traceDir: "scripts/traces/generated",
    outRoot: "",
    durationMs: 60_000,
    pageSize: 262_144,
    coldCache: "true",
    worker2Host: "",
    worker2User: "",
    worker2Key: "",
    remoteRepo: process.env.SPARK_REMOTE_REPO || "",
    dryRun: "",
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "server") o.server = v;
    else if (k === "traceDir") o.traceDir = v || o.traceDir;
    else if (k === "outRoot") o.outRoot = v;
    else if (k === "durationMs") o.durationMs = Number.parseInt(v || "60000", 10);
    else if (k === "pageSize") o.pageSize = Number.parseInt(v || "262144", 10);
    else if (k === "coldCache") o.coldCache = v || "true";
    else if (k === "worker2Host") o.worker2Host = v;
    else if (k === "worker2User") o.worker2User = v;
    else if (k === "worker2Key") o.worker2Key = v;
    else if (k === "remoteRepo") o.remoteRepo = v;
    else if (k === "dryRun") o.dryRun = v;
  }
  return o;
}

function traceDirToBase(traceDir) {
  const abs = path.isAbsolute(traceDir) ? path.normalize(traceDir) : path.join(projectRoot, traceDir);
  const rel = path.relative(projectRoot, abs);
  if (rel.startsWith("..") || !rel) return "/scripts/traces/generated";
  return `/${rel.split(path.sep).join("/")}`;
}

function runNode(args, cwd) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd, stdio: "inherit" });
    p.on("error", (e) => {
      console.error(e);
      resolve(1);
    });
    p.on("exit", (c) => resolve(c == null ? 1 : c));
  });
}

function pickRun(summaryJson, runId) {
  const runs = Array.isArray(summaryJson.runs) ? summaryJson.runs : [];
  return runs.find((r) => String(r.run_id) === String(runId)) || null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const isDry = args.dryRun === "1" || args.dryRun === "true" || args.dryRun === "yes";
  if (!args.outRoot) {
    console.error("需要 --outRoot=");
    process.exitCode = 1;
    return;
  }
  if (!isDry && !args.server) {
    console.error("需要 --server= 或使用 --dryRun=1 做编排预检。");
    process.exitCode = 1;
    return;
  }
  const outRoot = path.isAbsolute(args.outRoot) ? path.normalize(args.outRoot) : path.join(projectRoot, args.outRoot);
  await fs.mkdir(outRoot, { recursive: true });
  const traceBase = traceDirToBase(args.traceDir);
  const exportParent = path.join(outRoot, "p3-exports");
  await fs.mkdir(exportParent, { recursive: true });

  if (isDry) {
    const t0 = Date.now();
    const planDef = [
      { scenario: "A-baseline", label: "A-baseline" },
      { scenario: "B-lockstep", label: "B-lockstep" },
      { scenario: "C-nearcohort", label: "C-nearcohort" },
    ];
    const dry = {
      dry_run: true,
      out_root: outRoot,
      export_parent: exportParent,
      trace_base: traceBase,
      matrix_complete: false,
      planned: planDef.map((p, i) => ({
        run_id: `p3-${p.label}-${t0 + i}`,
        scenario: p.scenario,
        run_root: path.join(outRoot, `p3-${p.label}-${t0 + i}`),
      })),
    };
    await fs.writeFile(path.join(outRoot, "p3-summary.json"), JSON.stringify(dry, null, 2), "utf8");
    console.log(`[dry-run] wrote ${path.join(outRoot, "p3-summary.json")}`);
    return;
  }

  const distConfigPath = path.join(outRoot, "p3-distributed-replay.config.json");
  const distFallback = path.join(projectRoot, "scripts", "distributed-replay.config.json");
  if (args.worker2Host && args.worker2User && args.worker2Key) {
    if (/[^\x00-\x7F]/.test(String(args.worker2User))) {
      console.warn("[warn] worker2User 非 ASCII，跳过写入 p3-distributed-replay.config.json，B/C 将尝试 distFallback 或标为 skip。");
    } else {
    const base = {
      ssh_user: args.worker2User,
      ssh_host: args.worker2Host,
      ssh_port: 22,
      ssh_key_path: args.worker2Key,
      remote_repo_path: args.remoteRepo || "",
      client_server_url: String(args.server).replace(/\/$/, ""),
      upstream_origin: "http://127.0.0.1:8080",
      proxy_port: (() => {
        try {
          return Number.parseInt(new URL(args.server).port || "80", 10) || 8092;
        } catch {
          return 8092;
        }
      })(),
    };
    if (!base.remote_repo_path) {
      console.warn("[warn] --remoteRepo 未设置，分布式 B/C 需 remote_repo_path；可设 env SPARK_REMOTE_REPO。");
    }
    await fs.writeFile(distConfigPath, JSON.stringify(base, null, 2), "utf8");
    }
  }

  const plan = [
    { scenario: "A-baseline", distributed: "0", expect: 1, label: "A-baseline" },
    { scenario: "B-lockstep", distributed: "1", expect: 4, label: "B-lockstep" },
    { scenario: "C-nearcohort", distributed: "1", expect: 4, label: "C-nearcohort" },
  ];

  const runRecords = [];

  for (const p of plan) {
    if (p.distributed === "1" && !existsSync(distConfigPath) && !existsSync(distFallback)) {
      console.error(
        `[error] 跳过 ${p.scenario}：缺少 distributed-replay 配置。请设 --worker2Host= --worker2User= --worker2Key=（会写入 ${distConfigPath}）或预置 ${distFallback}。`,
      );
      runRecords.push({
        run_id: null,
        scenario: p.label,
        valid: false,
        error: "no_distributed_config",
        expected_users: p.expect,
      });
      continue;
    }

    const ts = Date.now();
    const runId = `p3-${p.label}-${ts}`;
    const runRoot = path.join(outRoot, runId);
    const proxyLog = path.join(runRoot, "proxy", "proxy.jsonl");
    const summaryPath = path.join(runRoot, "summary", "distributed-summary.json");

    const drArgs = [
      path.join(projectRoot, "scripts", "run-distributed-replay.mjs"),
      `--scenario=${p.scenario}`,
      `--durationMs=${args.durationMs}`,
      `--distributed=${p.distributed}`,
      `--outRoot=${runRoot}`,
      `--runId=${runId}`,
      `--traceBase=${traceBase}`,
      `--server=${args.server}`,
    ];
    const env = { ...process.env };
    if (existsSync(distConfigPath) || existsSync(distFallback)) {
      env.SPARK_DIST_CONFIG = existsSync(distConfigPath) ? distConfigPath : distFallback;
    }
    const code = await new Promise((resolve) => {
      const sp = spawn(process.execPath, drArgs, { cwd: projectRoot, stdio: "inherit", env });
      sp.on("error", (e) => {
        console.error(e);
        resolve(1);
      });
      sp.on("exit", (c) => resolve(c == null ? 1 : c));
    });
    if (code !== 0) {
      console.error(`[error] run-distributed-replay 退出码 ${code} for ${runId}`);
    }

    const valArgs = [
      path.join(projectRoot, "scripts", "validate-run-coverage.mjs"),
      `--runDir=${runRoot}`,
      `--expectedUsers=${p.expect}`,
      `--proxyLog=${proxyLog}`,
      `--runId=${runId}`,
    ];
    const valCode = await runNode(valArgs, projectRoot);
    const coveragePath = path.join(runRoot, "validate-run-coverage.json");
    let valJson = null;
    try {
      valJson = JSON.parse(await fs.readFile(coveragePath, "utf8"));
    } catch {
      valJson = null;
    }
    const coverageOk = valJson && valJson.coverage_ok === true;

    const anArgs = [
      path.join(projectRoot, "analysis", "analyze-abc-distributed.mjs"),
      `--runRoot=${runRoot}`,
      `--proxyLog=${proxyLog}`,
      `--out=${summaryPath}`,
      `--expectedUsers=${p.expect}`,
      `--pageSizes=${args.pageSize}`,
      `--runId=${runId}`,
    ];
    await runNode(anArgs, projectRoot);

    let anJson = null;
    let row = null;
    try {
      anJson = JSON.parse(await fs.readFile(summaryPath, "utf8"));
      row = pickRun(anJson, runId);
    } catch {
      /* */
    }

    const exArgs = [
      path.join(projectRoot, "scripts", "export-run-artifacts.mjs"),
      `--root=${outRoot}`,
      `--runId=${runId}`,
      `--out=${exportParent}`,
    ];
    await runNode(exArgs, projectRoot);

    const runInvalid = Boolean(row?.validity?.run_invalid);
    const valid = Boolean(coverageOk && row && !runInvalid);

    runRecords.push({
      run_id: runId,
      scenario: p.label,
      valid,
      active_users: row?.validity?.active_users ?? valJson?.users_with_nonzero_completion ?? null,
      expected_users: p.expect,
      has_scene_request: valJson?.has_scene_request ?? null,
      has_range_request: valJson?.has_range_request ?? null,
      total_B_client_agg: row?.totals?.total_B_client_agg ?? null,
      total_B_unique: row?.totals?.total_B_unique ?? null,
      total_B_upstream: row?.totals?.total_B_upstream ?? null,
      client_p95: row?.latency?.client_p95 ?? null,
      client_p99: row?.latency?.client_p99 ?? null,
      upstream_p95: row?.latency?.upstream_p95 ?? null,
      upstream_p99: row?.latency?.upstream_p99 ?? null,
      fairness_valid: row?.validity?.fairness_valid ?? null,
      validate_exit_code: valCode,
      coverage_ok: coverageOk,
    });
  }

  const matrix_complete = runRecords.length === 3 && runRecords.every((r) => r.valid === true);
  const p3 = {
    generated_at: new Date().toISOString(),
    out_root: outRoot,
    trace_dir: args.traceDir,
    trace_base: traceBase,
    cold_cache: args.coldCache,
    page_size: args.pageSize,
    runs: runRecords,
    matrix_complete,
  };
  const p3Path = path.join(outRoot, "p3-summary.json");
  await fs.writeFile(p3Path, JSON.stringify(p3, null, 2), "utf8");
  console.log(`Wrote ${p3Path}`);

  if (!matrix_complete) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
