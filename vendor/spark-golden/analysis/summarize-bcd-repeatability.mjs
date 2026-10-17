import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const out = { root: "", patterns: "", out: "" };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "root") out.root = v;
    else if (k === "patterns") out.patterns = v;
    else if (k === "out") out.out = v;
  }
  return out;
}

function pct(values, p) {
  const xs = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const i = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
  return xs[i];
}

function stat(xs) {
  const ys = xs.filter((x) => Number.isFinite(x));
  if (!ys.length) return { mean: null, min: null, max: null };
  const s = ys.reduce((a, b) => a + b, 0);
  return { mean: s / ys.length, min: Math.min(...ys), max: Math.max(...ys) };
}

async function readJson(p) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

async function readJsonl(p) {
  const raw = await fs.readFile(p, "utf8").catch(() => "");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function mapGroup(name) {
  if (name.includes("B-lockstep")) return "B-lockstep";
  if (name.includes("C-nearcohort")) return "C-nearcohort";
  if (name.includes("D-divergent")) return "D-divergent";
  return null;
}

async function collectRun(root, runId) {
  const runDir = path.join(root, runId);
  const sum = await readJson(path.join(runDir, "summary", "distributed-summary.json"));
  const val = await readJson(path.join(runDir, "validate-run-coverage.json"));
  const br = await readJson(path.join(runDir, "summary", "burst_queue.json"));
  const run = (sum?.runs || []).find((r) => String(r.run_id) === runId) || null;
  let queueP95 = null;
  let serviceP95 = null;
  let totalProxyP95 = null;
  if (br?.runs?.length) {
    queueP95 = br.runs[0]?.latency_breakdown?.queue_p95 ?? null;
    serviceP95 = br.runs[0]?.latency_breakdown?.service_p95 ?? null;
    totalProxyP95 = br.runs[0]?.latency_breakdown?.total_proxy_delay_p95 ?? null;
  } else {
    const proxyRows = (await readJsonl(path.join(runDir, "proxy", "proxy.jsonl"))).filter(
      (p) => (!p.event || p.event === "request_complete") && String(p.run_id || "") === String(runId),
    );
    const q = [];
    const s = [];
    const t = [];
    for (const p of proxyRows) {
      const recv = Number(p.recv_ts || 0);
      const st = Number(p.upstream_start_ts || p.phase_timestamps?.upstream_fetch_started || 0);
      const end = Number(p.upstream_end_ts || 0);
      const dend = Number(p.downstream_end_ts || p.phase_timestamps?.downstream_finished || 0);
      if (recv > 0 && st > 0) q.push(st - recv);
      if (st > 0 && end > 0) s.push(end - st);
      if (recv > 0 && dend > 0) t.push(dend - recv);
    }
    queueP95 = pct(q, 95);
    serviceP95 = pct(s, 95);
    totalProxyP95 = pct(t, 95);
  }
  const valid = Boolean(val?.coverage_ok === true && run && !run?.validity?.run_invalid);
  return {
    run_id: runId,
    scenario: run?.scenario || mapGroup(runId),
    valid,
    invalid_reason: valid ? null : "coverage_or_summary_invalid",
    totals: {
      B_client_agg: run?.totals?.total_B_client_agg ?? null,
      B_unique: run?.totals?.total_B_unique ?? null,
      B_upstream: run?.totals?.total_B_upstream ?? null,
    },
    latency: {
      client_p95: run?.latency?.client_p95 ?? null,
      client_p99: run?.latency?.client_p99 ?? null,
      upstream_p95: run?.latency?.upstream_p95 ?? null,
      upstream_p99: run?.latency?.upstream_p99 ?? null,
      queue_p95: queueP95,
      service_p95: serviceP95,
      total_proxy_p95: totalProxyP95,
    },
    fairness_valid: run?.validity?.fairness_valid ?? null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root || !args.patterns || !args.out) throw new Error("need --root --patterns --out");
  const root = path.resolve(args.root);
  const patterns = args.patterns.split(",").map((x) => x.trim()).filter(Boolean);
  const ents = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const runIds = ents
    .filter((e) => e.isDirectory() && patterns.some((p) => e.name.startsWith(p)))
    .map((e) => e.name);

  const runs = [];
  for (const id of runIds) runs.push(await collectRun(root, id));
  const groups = {};
  for (const g of ["B-lockstep", "C-nearcohort", "D-divergent"]) {
    const rs = runs.filter((r) => mapGroup(String(r.scenario || r.run_id || "")) === g);
    const vr = rs.filter((r) => r.valid);
    groups[g] = {
      runs: rs.map((r) => r.run_id),
      valid_runs: vr.length,
      invalid_runs: rs.length - vr.length,
      totals: {
        B_client_agg: stat(vr.map((r) => Number(r.totals.B_client_agg))),
        B_unique: stat(vr.map((r) => Number(r.totals.B_unique))),
        B_upstream: stat(vr.map((r) => Number(r.totals.B_upstream))),
      },
      latency: {
        client_p95: stat(vr.map((r) => Number(r.latency.client_p95))),
        client_p99: stat(vr.map((r) => Number(r.latency.client_p99))),
        upstream_p95: stat(vr.map((r) => Number(r.latency.upstream_p95))),
        upstream_p99: stat(vr.map((r) => Number(r.latency.upstream_p99))),
        queue_p95: stat(vr.map((r) => Number(r.latency.queue_p95))),
        service_p95: stat(vr.map((r) => Number(r.latency.service_p95))),
      },
      fairness_valid_all: vr.every((r) => r.fairness_valid === true),
      invalid_details: rs.filter((r) => !r.valid).map((r) => ({ run_id: r.run_id, reason: r.invalid_reason })),
    };
  }
  const B = groups["B-lockstep"];
  const C = groups["C-nearcohort"];
  const D = groups["D-divergent"];
  const consistency_checks = {
    B_vs_C_object_totals_consistently_equal:
      B.totals.B_unique.mean != null &&
      C.totals.B_unique.mean != null &&
      B.totals.B_upstream.mean === C.totals.B_upstream.mean &&
      B.totals.B_unique.mean === C.totals.B_unique.mean,
    D_tail_consistently_worst:
      D.latency.client_p99.mean != null &&
      D.latency.client_p99.mean >= Math.max(B.latency.client_p99.mean ?? -Infinity, C.latency.client_p99.mean ?? -Infinity),
    upstream_equals_unique_consistently:
      [B, C, D].every((g) => g.totals.B_upstream.mean != null && g.totals.B_unique.mean != null && g.totals.B_upstream.mean === g.totals.B_unique.mean),
  };
  const final_interpretation =
    consistency_checks.B_vs_C_object_totals_consistently_equal && consistency_checks.D_tail_consistently_worst
      ? "stable_object_totals_but_divergent_tail"
      : "mixed_or_inconclusive";

  const out = {
    generated_at: new Date().toISOString(),
    run_count: runs.length,
    groups,
    consistency_checks,
    final_interpretation,
  };
  const outPath = path.resolve(args.out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

