import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const out = {
    master: "scripts/traces/master-trace.json",
    outDir: "scripts/traces/generated",
    users: 4,
    seed: 20260423,
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "master") out.master = v || out.master;
    else if (k === "out") out.outDir = v || out.outDir;
    else if (k === "users") out.users = Number.parseInt(v || "4", 10);
    else if (k === "seed") out.seed = Number.parseInt(v || "20260423", 10);
  }
  return out;
}

function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function mutateSample(sample, options) {
  const yaw = options.yawOffsetRad ?? 0;
  const gain = options.pathGain ?? 1;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const [x, y, z] = sample.position;
  const nx = (x * cos - z * sin) * gain;
  const nz = (x * sin + z * cos) * gain;
  return {
    ...sample,
    t_ms: sample.t_ms + (options.startOffsetMs ?? 0),
    position: [nx, y, nz],
  };
}

function injectDeterministicBranch(samples, branchId) {
  if (samples.length < 12) return samples;
  const start = branchId === 0 ? Math.floor(samples.length * 0.3) : Math.floor(samples.length * 0.7);
  const end = Math.min(samples.length - 1, start + 6);
  for (let i = start; i <= end; i += 1) {
    const sample = samples[i];
    sample.position = [sample.position[0] + (branchId === 0 ? 0.15 : -0.15), sample.position[1], sample.position[2]];
  }
  return samples;
}

function buildTrace(master, userId, workload, options = {}) {
  const samples = master.samples.map((s) => mutateSample(s, options));
  if (workload === "near-cohort") {
    injectDeterministicBranch(samples, 0);
    injectDeterministicBranch(samples, 1);
  }
  return {
    trace_id: `${master.trace_id}-${workload}-${userId}`,
    user_id: userId,
    workload,
    created_at: new Date().toISOString(),
    sample_interval_ms: master.sample_interval_ms,
    start_offset_ms: options.startOffsetMs ?? 0,
    samples,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = await fs.readFile(args.master, "utf8");
  const master = JSON.parse(raw);
  const rng = createRng(args.seed);
  await fs.mkdir(args.outDir, { recursive: true });

  const workloads = ["lockstep", "near-cohort", "divergent"];
  for (const workload of workloads) {
    const workloadDir = path.join(args.outDir, workload);
    await fs.mkdir(workloadDir, { recursive: true });
    for (let i = 0; i < args.users; i += 1) {
      const userId = `user${i}`;
      let trace;
      if (workload === "lockstep") {
        trace = buildTrace(master, userId, workload, { startOffsetMs: 0, yawOffsetRad: 0, pathGain: 1 });
      } else if (workload === "near-cohort") {
        trace = buildTrace(master, userId, workload, {
          startOffsetMs: Math.round((rng() - 0.5) * 300),
          yawOffsetRad: (rng() - 0.5) * 0.12,
          pathGain: 0.97 + rng() * 0.06,
        });
      } else {
        trace = buildTrace(master, userId, workload, {
          startOffsetMs: Math.round(rng() * 1000),
          yawOffsetRad: -0.8 + rng() * 1.6,
          pathGain: 0.8 + rng() * 0.4,
        });
      }
      const outFile = path.join(workloadDir, `${userId}.json`);
      await fs.writeFile(outFile, JSON.stringify(trace, null, 2), "utf8");
    }
  }

  console.log(`Generated traces in ${args.outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
