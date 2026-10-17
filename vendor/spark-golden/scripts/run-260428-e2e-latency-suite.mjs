/**
 * 分布式 A/B/C/D 端到端延迟套件：依次调用 run-distributed-replay.mjs，产出汇总至 260428/。
 * 依赖：scripts/distributed-replay.config.json 或 SPARK_DIST_CONFIG 指向有效 JSON（含 ssh_* / upstream 等）。
 *
 * 环境变量：
 *   SPARK_DIST_CONFIG — 配置文件路径（默认 260428/distributed-replay.config.json）。若本地尚无该文件，套件优先从 **260425_repeat10/distributed-replay.config.json** 复制（与 success 的 repeat10 共用）；若无 repeat10 副本再用 **260425/distributed-replay.config.json** 模板。
 *   SUITE_DISTRIBUTED — `0`/`false`：混合模式 — **A** 为单机四用户（`A-baseline-4local` + `--distributed=0`），**B/C/D** 仍为分布式（`--distributed=1`）。其它或未设置：全套分布式，**A** 为 `A-baseline`（分布式编排下单用户对照）。
 *   SUITE_DURATION_MS — 每场景时长（默认 60000）
 *   SUITE_TRACE_BASE — 传给 --traceBase（默认 scripts/traces/generated，**不改 3DGS 轨迹**）
 *   SPARK_FIXED_PROXY_PORT — 若未设置，套件设为 1（与 repeat10 一致，避免动态端口与远端缓存冲突）
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const OUT = path.join(projectRoot, "260428");
/** repeat10 目录内通常为历史上跑通的 SSH/upstream/client_server_url（bench:260425:repeat10 首轮会从 260425 拷贝到此） */
const REPEAT10_CFG = path.join(projectRoot, "260425_repeat10", "distributed-replay.config.json");
const FALLBACK_TEMPLATE_CFG = path.join(projectRoot, "260425", "distributed-replay.config.json");
const DEFAULT_CFG = path.join(OUT, "distributed-replay.config.json");

function mixedLocalAEnabled() {
  const v = process.env.SUITE_DISTRIBUTED;
  return v === "0" || v === "false";
}

/** @returns {{ arg: string, key: string, distributed: boolean }[]} */
function buildScenarioList(mixedA) {
  return [
    {
      arg: mixedA ? "A-baseline-4local" : "A-baseline",
      key: "A",
      distributed: !mixedA,
    },
    { arg: "B-lockstep", key: "B", distributed: true },
    { arg: "C-nearcohort", key: "C", distributed: true },
    { arg: "D-divergent", key: "D", distributed: true },
  ];
}

function runNode(script, args, cwd, env = process.env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...args], { cwd, stdio: "inherit", env });
    p.on("error", () => resolve(1));
    p.on("exit", (c) => resolve(c ?? 1));
  });
}

async function readJson(p) {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function collectRunRow(runRoot) {
  const meta = await readJson(path.join(runRoot, "metadata.json"));
  const sumPath = path.join(runRoot, "summary", "distributed-summary.json");
  const sum = await readJson(sumPath);
  const rid = meta?.run_id;
  const runs = sum?.runs || [];
  const row =
    runs.find((r) => String(r.run_id) === String(rid)) || runs[0] || null;
  const coverage = await readJson(path.join(runRoot, "validate-run-coverage.json"));
  return {
    run_root: path.relative(projectRoot, runRoot),
    run_id: rid ?? null,
    scenario_from_meta: meta?.scenario ?? null,
    distributed: meta?.distributed ?? null,
    replay_exit_ok: Boolean(row && !row.validity?.run_invalid),
    validate_coverage_ok: coverage?.coverage_ok ?? null,
    latency: row?.latency ?? null,
    totals: row?.totals ?? null,
    sensitivity: row?.sensitivity ?? null,
    validity: row?.validity ?? null,
    fairness: row?.fairness ?? null,
    summary_path: path.relative(projectRoot, sumPath),
  };
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const outCfg = DEFAULT_CFG;
  if (!existsSync(outCfg)) {
    const src = existsSync(REPEAT10_CFG) ? REPEAT10_CFG : FALLBACK_TEMPLATE_CFG;
    if (existsSync(src)) {
      copyFileSync(src, outCfg);
      console.log(`[260428-e2e] copied ${path.relative(projectRoot, src)} -> ${path.relative(projectRoot, outCfg)}`);
    } else {
      console.error(
        "[260428-e2e] ERROR: 缺少 260428/distributed-replay.config.json，且 260425_repeat10 与 260425 模板均不存在。请手动放入 SPARK_DIST_CONFIG。",
      );
      process.exitCode = 1;
      return;
    }
  }

  const logPath = path.join(OUT, "suite-run.log");
  const log = async (line) => {
    const s = `[${new Date().toISOString()}] ${line}\n`;
    await fs.appendFile(logPath, s, "utf8");
    process.stdout.write(s);
  };

  const durationMs = Number.parseInt(process.env.SUITE_DURATION_MS || "60000", 10);
  const traceBase = process.env.SUITE_TRACE_BASE || "scripts/traces/generated";
  const suiteStarted = new Date().toISOString();
  const mixedLocalA = mixedLocalAEnabled();
  const scenarioList = buildScenarioList(mixedLocalA);
  const suiteProfile = mixedLocalA ? "mixed-local-A" : "full-distributed";
  await log(
    `=== 260428 E2E latency suite start profile=${suiteProfile} durationMs=${durationMs} traceBase=${traceBase} ===`,
  );

  const baseEnv = {
    ...process.env,
    SPARK_DIST_CONFIG: process.env.SPARK_DIST_CONFIG || outCfg,
    SPARK_BROWSER_FRAME_DIAG: process.env.SPARK_BROWSER_FRAME_DIAG || "1",
  };
  if (process.env.SPARK_FIXED_PROXY_PORT == null) {
    baseEnv.SPARK_FIXED_PROXY_PORT = "1";
  }

  const replayScript = path.join(projectRoot, "scripts", "run-distributed-replay.mjs");
  const manifest = {
    suite: "260428-e2e-latency",
    suite_profile: suiteProfile,
    mixed_local_A: mixedLocalA,
    suite_started_at: suiteStarted,
    duration_ms_per_scenario: durationMs,
    trace_base: traceBase,
    dist_config: path.relative(projectRoot, baseEnv.SPARK_DIST_CONFIG),
    scenarios: [],
  };

  let worstExit = 0;

  for (const sc of scenarioList) {
    const ts = Date.now();
    const runRoot = path.join(OUT, `${sc.arg}-${ts}`);
    const distArg = sc.distributed ? "1" : "0";
    const args = [
      `--scenario=${sc.arg}`,
      `--distributed=${distArg}`,
      `--durationMs=${durationMs}`,
      `--outRoot=${runRoot}`,
      `--traceBase=${traceBase}`,
    ];
    await log(
      `--- scenario ${sc.key} (${sc.arg}) distributed=${distArg} -> ${path.relative(projectRoot, runRoot)} ---`,
    );
    const c = await runNode(replayScript, args, projectRoot, baseEnv);
    worstExit = Math.max(worstExit, c);
    await log(`run-distributed-replay exit=${c}`);

    let collected = null;
    try {
      collected = await collectRunRow(runRoot);
    } catch (e) {
      await log(`WARN collect summary: ${e?.message || e}`);
    }

    manifest.scenarios.push({
      key: sc.key,
      scenario: sc.arg,
      distributed: sc.distributed,
      exit_code: c,
      ...(collected || { run_root: path.relative(projectRoot, runRoot), error: "collect_failed" }),
    });
  }

  manifest.suite_finished_at = new Date().toISOString();
  manifest.suite_max_exit_code = worstExit;

  const manifestPath = path.join(OUT, "suite-manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  await log(`wrote ${path.relative(projectRoot, manifestPath)}`);

  /** 扁平表：便于论文/表格（对齐 abc_d_total_table.json 风格） */
  const rows = manifest.scenarios.map((s) => {
    const lat = s.latency || {};
    const tot = s.totals || {};
    const sens = Array.isArray(s?.sensitivity) ? s.sensitivity : [];
    const mid = sens.find((x) => x.page_size === 256 * 1024) || sens[0] || {};
    return {
      label: s.key,
      run_id: s.run_id,
      scenario: s.scenario,
      distributed_run: s.distributed,
      exit_code: s.exit_code,
      B_client_agg: mid.B_client_agg ?? tot.total_B_client_agg,
      B_unique: mid.B_unique ?? tot.total_B_unique,
      B_upstream: mid.B_upstream ?? tot.total_B_upstream,
      client_p95: lat.client_p95 ?? null,
      client_p99: lat.client_p99 ?? null,
      upstream_p95: lat.upstream_p95 ?? null,
      upstream_p99: lat.upstream_p99 ?? null,
      coverage_ok: s.validate_coverage_ok,
      expected_users: s.validity?.expected_users ?? null,
      active_users: s.validity?.active_users ?? null,
      fairness_valid: s.validity?.fairness_valid ?? null,
      instrument_ok: s.validity?.instrument_ok ?? null,
    };
  });

  const summaryOut = {
    generated_at: manifest.suite_finished_at,
    suite: "260428-e2e-latency",
    suite_profile: suiteProfile,
    metric_doc: "260428/README_metrics.md",
    rows,
  };
  const summaryPath = path.join(OUT, "e2e_summary.json");
  await fs.writeFile(summaryPath, JSON.stringify(summaryOut, null, 2), "utf8");
  await log(`wrote ${path.relative(projectRoot, summaryPath)}`);

  /** 简短 Markdown 表（非 Canvas：便于 git diff） */
  const mdLines = [
    `# 260428 E2E 延迟汇总`,
    ``,
    `- 生成时间: ${summaryOut.generated_at}`,
    `- 指标含义见 README_metrics.md`,
    ``,
    `| 场景 | client_p95 | client_p99 | upstream_p95 | upstream_p99 | coverage_ok |`,
    `|------|------------|------------|--------------|--------------|-------------|`,
  ];
  for (const r of rows) {
    mdLines.push(
      `| ${r.label} | ${r.client_p95 ?? "—"} | ${r.client_p99 ?? "—"} | ${r.upstream_p95 ?? "—"} | ${r.upstream_p99 ?? "—"} | ${r.coverage_ok ?? "—"} |`,
    );
  }
  await fs.writeFile(path.join(OUT, "e2e_summary.md"), mdLines.join("\n") + "\n", "utf8");

  const breakdownJson = path.join(OUT, "e2e_latency_breakdown.json");
  const breakdownMd = path.join(OUT, "e2e_bottleneck_analysis.md");
  const cBreak = await runNode(
    path.join(projectRoot, "analysis", "analyze-e2e-latency-breakdown.mjs"),
    [`--manifest=${manifestPath}`, `--out=${breakdownJson}`, `--outMd=${breakdownMd}`],
    projectRoot,
    baseEnv,
  );
  await log(`analyze-e2e-latency-breakdown exit=${cBreak}`);
  worstExit = Math.max(worstExit, cBreak);

  if (worstExit !== 0) {
    process.exitCode = worstExit >= 2 ? worstExit : 1;
  }
  await log(`=== done max_exit=${worstExit} ===`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
