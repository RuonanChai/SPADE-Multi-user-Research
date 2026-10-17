import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const out = { input: "", out: "" };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "input") out.input = v;
    else if (k === "out") out.out = v;
  }
  return out;
}

function maxOfWindows(run, key) {
  const xs = (run.windows || []).map((w) => Number(w[key])).filter((x) => Number.isFinite(x));
  return xs.length ? Math.max(...xs) : null;
}

function pickWorst(runs, key) {
  let best = null;
  for (const r of runs) {
    const v = Number(r.latency_breakdown?.[key]);
    if (!Number.isFinite(v)) continue;
    if (!best || v > best.value) best = { run_id: r.run_id, value: v };
  }
  return best;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.out) throw new Error("need --input --out");
  const input = JSON.parse(await fs.readFile(path.resolve(args.input), "utf8"));
  const bcd = (input.runs || []).filter((r) => /B-lockstep|C-nearcohort|D-divergent/i.test(String(r.scenario || r.run_id || "")));
  if (bcd.length < 3) throw new Error("need B/C/D runs in input");

  const tRef = bcd[0].totals || {};
  const same_total_unique_pages = bcd.every((r) => Number(r.totals?.B_unique) === Number(tRef.B_unique));
  const same_total_upstream_bytes = bcd.every((r) => Number(r.totals?.B_upstream) === Number(tRef.B_upstream));
  const same_total_client_bytes = bcd.every((r) => Number(r.totals?.B_client_agg) === Number(tRef.B_client_agg));

  const peaks = {};
  for (const r of bcd) {
    peaks[r.run_id] = {
      scenario: r.scenario,
      peak_upstream_inflight: maxOfWindows(r, "upstream_inflight_peak"),
      peak_upstream_requests_started: maxOfWindows(r, "upstream_requests_started"),
      peak_client_requests: maxOfWindows(r, "client_requests"),
      peak_upstream_p95_latency: maxOfWindows(r, "upstream_p95_latency"),
      peak_client_p95_latency: maxOfWindows(r, "client_p95_latency"),
    };
  }

  const worst_by_queue_p95 = pickWorst(bcd, "queue_p95");
  const worst_by_service_p95 = pickWorst(bcd, "service_p95");
  const worst_by_upstream_p99 = pickWorst(bcd, "total_proxy_delay_p99");
  const worst_by_client_p99 = pickWorst(bcd, "client_total_delay_p99");

  const queues = bcd.map((r) => Number(r.latency_breakdown?.queue_p95)).filter((x) => Number.isFinite(x));
  const services = bcd.map((r) => Number(r.latency_breakdown?.service_p95)).filter((x) => Number.isFinite(x));
  const qSpread = queues.length ? Math.max(...queues) - Math.min(...queues) : 0;
  const sSpread = services.length ? Math.max(...services) - Math.min(...services) : 0;
  const inflights = Object.values(peaks).map((p) => Number(p.peak_upstream_inflight)).filter((x) => Number.isFinite(x));
  const inflightSpread = inflights.length ? Math.max(...inflights) - Math.min(...inflights) : 0;

  const likely_burst_driven = same_total_unique_pages && same_total_upstream_bytes && inflightSpread > 0;
  const likely_queueing_dominated = qSpread > sSpread * 1.1;
  const likely_service_time_dominated = sSpread > qSpread * 1.1;

  const result = {
    generated_at: new Date().toISOString(),
    compared_run_ids: bcd.map((r) => r.run_id),
    totals_consistency: {
      same_total_unique_pages,
      same_total_upstream_bytes,
      same_total_client_bytes,
    },
    peaks,
    worst: {
      worst_by_queue_p95,
      worst_by_service_p95,
      worst_by_upstream_p99,
      worst_by_client_p99,
    },
    interpretation: {
      likely_burst_driven,
      likely_queueing_dominated,
      likely_service_time_dominated,
      logic: {
        likely_burst_driven:
          "total unique/upstream totals are equal but peak inflight/latency shape differs across B/C/D",
        likely_queueing_dominated:
          "queue_p95 spread > service_p95 spread by threshold",
        likely_service_time_dominated:
          "service_p95 spread > queue_p95 spread by threshold",
      },
      spreads: {
        queue_p95_spread: qSpread,
        service_p95_spread: sSpread,
        peak_inflight_spread: inflightSpread,
      },
    },
  };

  const outPath = path.resolve(args.out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(result, null, 2), "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

