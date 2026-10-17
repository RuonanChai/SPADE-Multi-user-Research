import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const PAGE_256 = 256 * 1024;

function parseArgs(argv) {
  const out = {
    runRoot: "results/distributed",
    proxyLog: "",
    out: "analysis/distributed-summary.json",
    pageSizes: "262144",
    expectedUsers: 0,
    runId: "",
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "runRoot") out.runRoot = v;
    else if (k === "proxyLog") out.proxyLog = v;
    else if (k === "out") out.out = v;
    else if (k === "pageSizes") out.pageSizes = v;
    else if (k === "expectedUsers") out.expectedUsers = Number.parseInt(v || "0", 10);
    else if (k === "runId") out.runId = v;
  }
  if (!out.runId) out.runId = process.env.SPARK_RUN_ID || "";
  return out;
}

function pct(values, p) {
  const sorted = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function normalizePages(url, rawRange, pageSize) {
  if (!rawRange) {
    return [`${url}#full-0`];
  }
  const m = /^bytes=(\d+)-(\d+)?$/i.exec(String(rawRange).trim());
  if (!m) return [];
  const start = Number.parseInt(m[1], 10);
  const end = m[2] ? Number.parseInt(m[2], 10) : start;
  const s = Math.floor(start / pageSize);
  const e = Math.floor(end / pageSize);
  const o = [];
  for (let i = s; i <= e; i += 1) o.push(`${url}#${i}`);
  return o;
}

function extractRunIdFromUrl(u) {
  try {
    return new URL(u, "http://local").searchParams.get("run_id") || "";
  } catch {
    return "";
  }
}

async function readMeta(runRoot) {
  try {
    return JSON.parse(await fs.readFile(path.join(runRoot, "metadata.json"), "utf8"));
  } catch {
    return null;
  }
}

async function readProxyJsonl(file) {
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function isCdpLine(r) {
  return r && (!r.source || r.source === "cdp_network");
}

function isDebugProbeUrl(u) {
  return typeof u === "string" && /\/debug-scene-probe\.rad(\?|$)/i.test(u);
}

async function walkClientLines(runRoot) {
  const lines = [];
  async function walk(dir) {
    const ent = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of ent) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.startsWith("client-") && e.name.endsWith(".jsonl")) {
        const raw = await fs.readFile(p, "utf8");
        for (const row of raw.split("\n").map((x) => x.trim()).filter(Boolean)) {
          try {
            lines.push(JSON.parse(row));
          } catch {
            /* */
          }
        }
      } else if (e.isFile() && e.name.startsWith("client-") && e.name.endsWith(".json") && !e.name.includes("summary")) {
        const data = JSON.parse(await fs.readFile(p, "utf8"));
        for (const block of (Array.isArray(data) ? data : [data])) {
          for (const fl of block.fetch_logs || []) {
            if (isCdpLine(fl)) lines.push(fl);
          }
        }
      }
    }
  }
  await walk(runRoot);
  return lines;
}

function groupUsers(lines) {
  const m = new Map();
  for (const r of lines) {
    if (!isCdpLine(r)) continue;
    const u = r.user_id || "unknown";
    if (!m.has(u)) m.set(u, []);
    m.get(u).push(r);
  }
  return m;
}

function jain(arr) {
  const xs = arr.filter((x) => Number.isFinite(x) && x >= 0);
  if (!xs.length) return null;
  const s = xs.reduce((a, b) => a + b, 0);
  const q = xs.reduce((a, b) => a + b * b, 0);
  if (q === 0) return null;
  return (s * s) / (xs.length * q);
}

/** 从 run_id 或元数据得到 P3 场景名，供 significance 与报表匹配 */
function scenarioLabel(runId, meta) {
  const r = String(runId);
  if (meta?.scenario === "A-baseline-4local") return "A-baseline-4local";
  if (r.includes("A-baseline-4local")) return "A-baseline-4local";
  if (r.includes("A-baseline")) return "A-baseline";
  if (r.includes("B-lockstep")) return "B-lockstep";
  if (r.includes("C-nearcohort") || r.includes("C-near-cohort")) return "C-nearcohort";
  if (meta?.scenario) return String(meta.scenario);
  return r.split("-").length >= 2 ? r.split("-").slice(0, 2).join("-") : r;
}

function proxyRequestRows(p) {
  return p.filter((x) => !x.event || x.event === "request_complete");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runRoot = path.resolve(args.runRoot);
  const pageSizes = args.pageSizes
    .split(",")
    .map((x) => Number.parseInt(x, 10))
    .filter((x) => Number.isFinite(x) && x > 0);
  const meta = await readMeta(runRoot);
  const expect = args.expectedUsers > 0 ? args.expectedUsers : (meta?.expected_users ?? 0);
  const plog = args.proxyLog
    ? path.isAbsolute(args.proxyLog)
      ? args.proxyLog
      : path.join(runRoot, args.proxyLog)
    : path.join(runRoot, "proxy", "proxy.jsonl");

  if (!existsSync(plog)) {
    console.error(`[fatal] 找不到 proxy: ${plog}`);
    process.exitCode = 1;
    return;
  }

  const allP = await readProxyJsonl(plog);
  const pRows = proxyRequestRows(allP).filter((p) => !isDebugProbeUrl(String(p.url || "")));
  const clientLines = await walkClientLines(runRoot);
  const cdp = clientLines.filter((r) => isCdpLine(r) && !r.debug_only && !isDebugProbeUrl(String(r.url || "")));
  if (!cdp.length) {
    console.error("[fatal] 无 cdp_network 客户端日志，或 jsonl 为空。");
    process.exitCode = 1;
    return;
  }

  const byRun = new Map();
  for (const r of cdp) {
    const id = r.run_id || "unknown";
    if (!byRun.has(id)) byRun.set(id, []);
    byRun.get(id).push(r);
  }

  let idList = [...byRun.keys()];
  if (args.runId) {
    const f = idList.filter((id) => String(id) === String(args.runId));
    if (!f.length) {
      console.error(`[fatal] 未找到 run_id=${args.runId}`);
      process.exitCode = 1;
      return;
    }
    idList = f;
  }

  const summaries = [];
  for (const runId of idList) {
    const rows = byRun.get(runId);
    const userMap = groupUsers(rows);
    const proxyForRun = pRows.filter(
      (p) => String(p.run_id || "") === String(runId) || extractRunIdFromUrl(String(p.url || "")) === String(runId),
    );
    const latencies = rows.map((f) => Number(f.duration_ms || 0)).filter((x) => Number.isFinite(x));
    const upLat = proxyForRun
      .map((x) => {
        const t0 = Number(x.upstream_start_ts || x.phase_timestamps?.upstream_fetch_started || 0);
        return Number(x.upstream_end_ts || 0) - t0;
      })
      .filter((x) => Number.isFinite(x) && x >= 0);
    const sensitivity = [];
    for (const pageSize of pageSizes) {
      const clientPages = rows.flatMap((f) => normalizePages(f.url, f.raw_range, pageSize));
      const uniqueC = new Set(clientPages);
      const proxyPages = proxyForRun.flatMap((p) => normalizePages(p.url || "", p.raw_range, pageSize));
      const uniqueU = new Set(proxyPages);
      const B_client_agg = clientPages.length * pageSize;
      const B_unique = uniqueC.size * pageSize;
      const B_up = uniqueU.size * pageSize;
      sensitivity.push({
        page_size: pageSize,
        B_client_agg,
        B_unique,
        B_upstream: B_up,
        delta_client_unique: B_client_agg - B_unique,
        delta_upstream_unique: B_up - B_unique,
      });
    }
    const mid = sensitivity.find((s) => s.page_size === PAGE_256) || sensitivity[0] || { B_client_agg: 0, B_unique: 0, B_upstream: 0 };
    const upstreamBytesSum = proxyForRun.reduce((a, p) => a + (Number(p.upstream_bytes) || 0), 0);
    const perUser = [...userMap.entries()].map(([user_id, fl]) => ({
      user_id,
      completion: fl.filter((x) => x.ok).length,
      stall: fl.filter((x) => Number(x.duration_ms || 0) > 500).length,
    }));
    const activeUsers = perUser.filter((p) => p.completion > 0).length;
    const allValidUsers =
      expect > 0 ? perUser.length >= expect && perUser.filter((p) => p.completion > 0).length === expect : true;
    const fairnessValid = allValidUsers && perUser.length > 0;
    let runInvalid = false;
    if (mid.B_upstream === 0) {
      runInvalid = true;
      console.error(`[error] run ${runId}: total_B_upstream(逻辑) 为 0。`);
    }
    if (upstreamBytesSum === 0) {
      runInvalid = true;
      console.error(`[error] run ${runId}: upstream_bytes 为 0。`);
    }
    if (expect > 0 && activeUsers !== expect) {
      runInvalid = true;
      console.error(`[error] run ${runId}: 期望 ${expect} 用户有效 completion，实际 ${activeUsers}。`);
    }
    const sc = scenarioLabel(runId, meta);
    summaries.push({
      run_id: runId,
      scenario: sc,
      users: perUser.length,
      totals: {
        total_B_client_agg: mid.B_client_agg,
        total_B_unique: mid.B_unique,
        total_B_upstream: mid.B_upstream,
        upstream_bytes_total_proxy: upstreamBytesSum,
      },
      validity: {
        run_invalid: runInvalid,
        instrument_ok: !runInvalid,
        expected_users: expect,
        active_users: activeUsers,
        fairness_valid: fairnessValid && allValidUsers,
      },
      sensitivity,
      windowed: [],
      latency: {
        client_p95: pct(latencies, 95),
        client_p99: pct(latencies, 99),
        upstream_p95: pct(upLat, 95),
        upstream_p99: pct(upLat, 99),
      },
      per_user: perUser,
      fairness: fairnessValid && allValidUsers ? jain(perUser.map((p) => p.completion)) : null,
    });
  }

  const anyInvalid = summaries.some((s) => s.validity.run_invalid) || summaries.some((s) => s.validity.fairness_valid === false);
  const significance = {
    client_agg_minus_unique_significant: false,
    upstream_minus_unique_significant: false,
    p95_p99_amplified: false,
    per_user_divergence_severe: false,
  };
  if (!anyInvalid) {
    const A = summaries.find(
      (s) =>
        s.scenario === "A-baseline" ||
        (String(s.run_id).includes("A-baseline") && !String(s.run_id).includes("A-baseline-4local")),
    );
    const B = summaries.find((s) => s.scenario === "B-lockstep" || String(s.run_id).includes("B-lockstep"));
    const C = summaries.find((s) => s.scenario === "C-nearcohort" || String(s.run_id).includes("C-nearcohort") || String(s.run_id).includes("C-near-cohort"));
    if (B) {
      const m = B.sensitivity.find((x) => x.page_size === PAGE_256) || B.sensitivity[0];
      if (m) {
        significance.client_agg_minus_unique_significant = m.delta_client_unique / Math.max(1, m.B_unique) > 0.1;
        significance.upstream_minus_unique_significant = m.delta_upstream_unique / Math.max(1, m.B_unique) > 0.1;
      }
    }
    if (A && B) {
      const ap = A.latency.client_p95 ?? 0;
      const bp = B.latency.client_p95 ?? 0;
      significance.p95_p99_amplified = bp > ap * 1.2 || (B.latency.client_p99 ?? 0) > (A.latency.client_p99 ?? 0) * 1.2;
    }
    if (C && C.per_user.length >= 2) {
      const comps = C.per_user.map((u) => u.completion);
      const max = Math.max(...comps, 0);
      const min = Math.min(...comps, max);
      significance.per_user_divergence_severe = max > 0 && (max - min) / max > 0.25;
    }
  } else {
    Object.assign(significance, { invalid: true, reason: "invalid due to instrumentation/orchestration" });
  }

  const outPath = path.isAbsolute(args.out) ? args.out : path.join(runRoot, "summary", path.basename(args.out) || "distributed-summary.json");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const output = {
    generated_at: new Date().toISOString(),
    runs: summaries,
    significance: anyInvalid ? { ...significance, all_valid_for_significance: false } : significance,
  };
  if (anyInvalid) output.instrumentation_incomplete = true;
  await fs.writeFile(outPath, JSON.stringify(output, null, 2), "utf8");
  /** 默认 exit 0，便于套件继续；严格 CI 可设 SPARK_ANALYZE_FAIL_ON_INVALID=1 */
  if (anyInvalid && process.env.SPARK_ANALYZE_FAIL_ON_INVALID === "1") process.exitCode = 2;
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
