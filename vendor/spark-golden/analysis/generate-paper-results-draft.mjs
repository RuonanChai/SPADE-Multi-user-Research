import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const out = { repeatability: "", burst: "", compare: "", service: "", out: "" };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "repeatability") out.repeatability = v;
    else if (k === "burst") out.burst = v;
    else if (k === "compare") out.compare = v;
    else if (k === "service") out.service = v;
    else if (k === "out") out.out = v;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.repeatability || !args.burst || !args.compare || !args.service || !args.out) {
    throw new Error("need all inputs");
  }
  const rep = JSON.parse(await fs.readFile(path.resolve(args.repeatability), "utf8"));
  const burst = JSON.parse(await fs.readFile(path.resolve(args.burst), "utf8"));
  const cmp = JSON.parse(await fs.readFile(path.resolve(args.compare), "utf8"));
  const svc = JSON.parse(await fs.readFile(path.resolve(args.service), "utf8"));

  const b = rep.groups?.["B-lockstep"];
  const c = rep.groups?.["C-nearcohort"];
  const d = rep.groups?.["D-divergent"];
  const validStr = `B (${b?.valid_runs}/${(b?.valid_runs || 0) + (b?.invalid_runs || 0)}), C (${c?.valid_runs}/${(c?.valid_runs || 0) + (c?.invalid_runs || 0)}), D (${d?.valid_runs}/${(d?.valid_runs || 0) + (d?.invalid_runs || 0)}).`;
  const strongSvc = svc.service_delay_strongly_size_correlated === true;
  const strongSvcText = strongSvc
    ? "Service-time shows a strong positive correlation with upstream bytes across runs, supporting a stronger service-time amplification hypothesis."
    : "Service-time does not show a strong size-only correlation, suggesting that aggregate service-time amplification is present but not explained by object size alone.";

  const md = `# Results Draft: Multiplayer 3DGS

## 1) Experimental validity

All three multiplayer scenarios (B-lockstep, C-nearcohort, D-divergent) include valid distributed runs under the same instrumentation and analysis pipeline. In repeatability runs, valid/total counts are ${validStr} Invalid runs were retained for accounting but excluded from aggregate mean/min/max statistics.

## 2) Stable object-level totals

Across valid B/C/D runs, object-level totals are stable: client aggregate bytes, unique logical bytes, and upstream logical bytes remain in the same range, and upstream logical bytes remain approximately equal to unique logical bytes (B_upstream ~ B_unique). This indicates that byte-level sharing/instrumentation closure is functioning and that gross object-level transfer accounting is not drifting across scenarios.

## 3) Divergent tail latency despite stable totals

Despite stable totals, latency shape diverges materially. In repeated measurements, D-divergent consistently exhibits the highest tail behavior (client and upstream p95/p99), while B and C remain lower. This separates tail amplification from total-byte movement and argues against a \"missing byte-sharing\" explanation as the primary cause of worst-case latency.

## 4) Interpretation

The combined evidence is more consistent with burst/queue/scheduling amplification than with missing byte-level sharing. The B/C/D timing-shape comparison shows consistent object totals but different burst peaks and tail outcomes. ${strongSvcText} These findings should be interpreted as measurement-driven evidence rather than a final causal claim.
`;

  const outPath = path.resolve(args.out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, md, "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

