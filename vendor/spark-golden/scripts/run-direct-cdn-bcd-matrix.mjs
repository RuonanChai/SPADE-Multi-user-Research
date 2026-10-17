/**
 * Direct CDN 分布式矩阵：B-lockstep / C-nearcohort / D-divergent 各 repeats 次。
 * 依赖 distributed-replay.config.json；建议 r2_public_origin 或 SPARK_CDN_BASE_URL 指向可托管
 * `/examples/hello-world/index.html` 的源（如 https://sparkjs.dev）。
 *
 *   node scripts/run-direct-cdn-bcd-matrix.mjs [--repeats=3] [--durationMs=120000] [--parentOut=...] [--outParent=...]
 *   结束写出 matrix-manifest.json、DIRECT_CDN_MATRIX_SUMMARY.md、matrix-compact-summary.json、DIRECT_CDN_MATRIX_COMPACT.md
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const o = { repeats: 3, durationMs: 120_000, parentOut: "" };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "repeats") o.repeats = Math.max(1, Number.parseInt(v || "3", 10));
    else if (k === "durationMs") o.durationMs = Number.parseInt(v || "120000", 10);
    else if (k === "parentOut" || k === "outParent") o.parentOut = v || "";
  }
  return o;
}

function mean(xs) {
  const a = xs.filter((x) => Number.isFinite(x));
  if (!a.length) return null;
  return a.reduce((s, x) => s + x, 0) / a.length;
}

function round4(x) {
  if (x == null || !Number.isFinite(x)) return null;
  return Math.round(x * 10000) / 10000;
}

/**
 * 按场景聚合各次有效 run 的 validate + direct_cdn_delivery，生成紧凑表（不写 CF 命中/代理/GPU 结论）。
 */
async function writeCompactMatrixSummary(projectRoot, parent, manifest) {
  const byScenario = new Map();
  for (const r of manifest.runs) {
    if (!r.ok) continue;
    if (!byScenario.has(r.scenario)) byScenario.set(r.scenario, []);
    byScenario.get(r.scenario).push(r.out_root);
  }

  const rows = [];
  for (const [scenario, roots] of [...byScenario.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const valid_runs = roots.length;
    const totals = [];
    const uniques = [];
    const repeats = [];
    const d50 = [];
    const d95 = [];
    const d99 = [];
    const ttfb95 = [];
    const dl95 = [];
    const warnCounts = [];
    const perUserOk = new Map();
    const perUserP95 = new Map();
    const perUserP99 = new Map();

    for (const root of roots) {
      const valPath = path.join(root, "validate-direct-cdn-run.json");
      const delPath = path.join(root, "summary", "direct_cdn_delivery.json");
      const val = JSON.parse(await fs.readFile(valPath, "utf8").catch(() => "{}"));
      const del = JSON.parse(await fs.readFile(delPath, "utf8").catch(() => "{}"));
      const ps = del.per_scenario?.[scenario] || Object.values(del.per_scenario || {})[0] || {};
      totals.push(ps.total_object_requests);
      uniques.push(ps.unique_object_count);
      repeats.push(ps.repeated_object_request_ratio);
      d50.push(ps.client_duration_ms?.p50);
      d95.push(ps.client_duration_ms?.p95);
      d99.push(ps.client_duration_ms?.p99);
      ttfb95.push(ps.ttfb_ms?.p95);
      dl95.push(ps.download_ms?.p95);
      const w = Array.isArray(val.warnings) ? val.warnings : [];
      warnCounts.push(w.length);
      for (const [uid, u] of Object.entries(del.per_user || {})) {
        if (!perUserOk.has(uid)) perUserOk.set(uid, []);
        perUserOk.get(uid).push(u.completion_count_ok);
        if (!perUserP95.has(uid)) perUserP95.set(uid, []);
        if (!perUserP99.has(uid)) perUserP99.set(uid, []);
        perUserP95.get(uid).push(u.duration_ms?.p95);
        perUserP99.get(uid).push(u.duration_ms?.p99);
      }
    }

    const perUserCompact = {};
    for (const uid of [...perUserOk.keys()].sort()) {
      perUserCompact[uid] = {
        ok_mean: round4(mean(perUserOk.get(uid) || [])),
        p95_mean_ms: round4(mean(perUserP95.get(uid) || [])),
        p99_mean_ms: round4(mean(perUserP99.get(uid) || [])),
      };
    }

    rows.push({
      scenario,
      valid_runs,
      total_object_requests_mean: round4(mean(totals.map(Number))),
      unique_object_count_mean: round4(mean(uniques.map(Number))),
      repeated_object_request_ratio_mean: round4(mean(repeats.filter(Number.isFinite))),
      duration_p50_mean_ms: round4(mean(d50)),
      duration_p95_mean_ms: round4(mean(d95)),
      duration_p99_mean_ms: round4(mean(d99)),
      ttfb_p95_mean_ms: round4(mean(ttfb95)),
      download_p95_mean_ms: round4(mean(dl95)),
      per_user: perUserCompact,
      warnings_count_sum_across_runs: warnCounts.reduce((a, b) => a + b, 0),
    });
  }

  const jsonPath = path.join(parent, "matrix-compact-summary.json");
  await fs.writeFile(jsonPath, `${JSON.stringify({ generated_at: new Date().toISOString(), parent, rows }, null, 2)}\n`, "utf8");

  const md = [
    "# Direct CDN 矩阵紧凑汇总",
    "",
    `父目录：\`${path.relative(projectRoot, parent)}\``,
    `生成：${new Date().toISOString()}`,
    "",
    "## 表述边界",
    "",
    "- **仅**报告：直连 CDN 请求级时延、TTFB/下载段时间、对象重复需求、按用户公平性、场景相关的请求重叠/重复模式。",
    "- **不**声称：代理共享增益；GPU/渲染提升；在缺少 **CF-Cache-Status** 的边缘（如 GitHub Pages）上推断 Cloudflare 缓存命中/未命中。",
    "",
    "下表各指标为**该场景下有效 run** 的算术平均（`warnings_count` 为三场 `validate-direct-cdn-run.json` 中 `warnings` 条数之和）。",
    "",
    "| scenario | valid_runs | total_req_μ | unique_μ | repeat_ratio_μ | dur_p50_μ | dur_p95_μ | dur_p99_μ | ttfb_p95_μ | dl_p95_μ | per_user (ok_mean / p95_μ / p99_μ) | warn_sum |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|",
    ...rows.map((r) => {
      const pu = Object.entries(r.per_user)
        .map(([k, v]) => `${k} ok=${v.ok_mean} p95=${v.p95_mean_ms} p99=${v.p99_mean_ms}`)
        .join(" · ");
      return `| ${r.scenario} | ${r.valid_runs} | ${r.total_object_requests_mean ?? "—"} | ${r.unique_object_count_mean ?? "—"} | ${r.repeated_object_request_ratio_mean ?? "—"} | ${r.duration_p50_mean_ms ?? "—"} | ${r.duration_p95_mean_ms ?? "—"} | ${r.duration_p99_mean_ms ?? "—"} | ${r.ttfb_p95_mean_ms ?? "—"} | ${r.download_p95_mean_ms ?? "—"} | ${pu} | ${r.warnings_count_sum_across_runs} |`;
    }),
    "",
  ].join("\n");
  await fs.writeFile(path.join(parent, "DIRECT_CDN_MATRIX_COMPACT.md"), md, "utf8");
  console.log(`[matrix] compact: ${jsonPath}`);
  console.log(`[matrix] compact: ${path.join(parent, "DIRECT_CDN_MATRIX_COMPACT.md")}`);
}

function runDistributedReplay(args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(projectRoot, "scripts", "run-distributed-replay.mjs"), ...args], {
      cwd: projectRoot,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    p.on("error", reject);
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`run-distributed-replay exit ${c}`))));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const ts = Date.now();
  const parent =
    opts.parentOut ||
    path.join(projectRoot, "results", "distributed", `direct-cdn-bcd-matrix-${ts}`);
  await fs.mkdir(parent, { recursive: true });

  const scenarios = [
    { scenario: "B-lockstep", label: "B-lockstep" },
    { scenario: "C-nearcohort", label: "C-nearcohort" },
    { scenario: "D-divergent", label: "D-divergent" },
  ];

  const manifest = {
    generated_at: new Date().toISOString(),
    parent_out: parent,
    repeats: opts.repeats,
    duration_ms: opts.durationMs,
    runs: /** @type {object[]} */ ([]),
  };

  for (const { scenario, label } of scenarios) {
    for (let i = 1; i <= opts.repeats; i++) {
      const outRoot = path.join(parent, `${label}-rep${i}-${Date.now()}`);
      const row = { scenario, repeat: i, out_root: outRoot, ok: false, error: null };
      manifest.runs.push(row);
      await fs.writeFile(path.join(parent, "matrix-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      console.log(`\n>>> Matrix: ${scenario} repeat ${i}/${opts.repeats} -> ${outRoot}\n`);
      try {
        await runDistributedReplay(
          [
            `--scenario=${scenario}`,
            "--distributed=1",
            "--directCdn=1",
            `--durationMs=${opts.durationMs}`,
            `--outRoot=${outRoot}`,
          ],
          { SPARK_DIRECT_CDN: "1" },
        );
        row.ok = true;
      } catch (e) {
        row.ok = false;
        row.error = String(e?.message || e);
        console.error(e);
        process.exitCode = 2;
      }
      await fs.writeFile(path.join(parent, "matrix-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }
  }

  const lines = [
    "# Direct CDN B/C/D 矩阵汇总",
    "",
    `生成：${manifest.generated_at}`,
    "",
    `每轮时长：${opts.duration_ms} ms（分布式 + directCdn）。`,
    "",
    "## 论文级汇总应只写",
    "",
    "- **直连 CDN** 请求级时延（如 duration 分位数）",
    "- **TTFB**（`responseStart − requestStart` / `ttfb_ms`）与 **下载段**（`responseEnd − responseStart` / `download_ms`）",
    "- 请求重叠/重复需求（随场景变化）；不在无 **CF-Cache-Status** 时推断 Cloudflare 缓存行为。",
    "- **对象级重复需求**（repeated_object_request_ratio 等）",
    "- **按用户公平性**（每用户 completion、duration 尾部）",
    "- **不写**：代理共享增益、GPU 或渲染帧率结论",
    "",
    "## 环境与复现注意",
    "",
    "- `r2_public_origin` 若仅托管资产、**不**托管 `/examples/hello-world/index.html`，direct CDN 需改用能 200 返回该页的源（如 `https://sparkjs.dev`）或设 `SPARK_CDN_BASE_URL`。",
    "- **worker2** 的 `scripts/replay-worker.mjs` 须与编排机**同版本**，否则远端可能仍带 `formal_probe`/`ts` 或旧版 `goto` 查询串，校验会告警「资产 URL 含瞬时查询参数」。",
    "",
    "口径：仅 **直连 CDN** 请求级时延、TTFB/下载、对象重复需求、按用户公平性；**不含** 代理共享增益、**不含** GPU/渲染结论；无 CF-Cache-Status 时不作 CF 缓存推断。",
    "",
    "| 场景 | 重复 | out_root | ok |",
    "|---|---:|---|---|",
    ...manifest.runs.map((r) => `| ${r.scenario} | ${r.repeat} | \`${path.relative(projectRoot, r.out_root)}\` | ${r.ok ? "yes" : "no"} |`),
    "",
    "各次 run 内见：`validate-direct-cdn-run.json`、`summary/direct_cdn_delivery.{json,md}`。",
    "",
  ];
  await fs.writeFile(path.join(parent, "DIRECT_CDN_MATRIX_SUMMARY.md"), lines.join("\n"), "utf8");
  await writeCompactMatrixSummary(projectRoot, parent, manifest);
  console.log(`\n[matrix] manifest: ${path.join(parent, "matrix-manifest.json")}`);
  console.log(`[matrix] summary: ${path.join(parent, "DIRECT_CDN_MATRIX_SUMMARY.md")}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
