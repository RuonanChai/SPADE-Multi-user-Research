import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const out = {
    output: "experiments/scenarios",
    durationMs: 90000,
    intervalMs: 100,
    clients: 8,
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "output") out.output = v || out.output;
    else if (k === "duration-ms") out.durationMs = Number.parseInt(v || "90000", 10);
    else if (k === "interval-ms") out.intervalMs = Number.parseInt(v || "100", 10);
    else if (k === "clients") out.clients = Number.parseInt(v || "8", 10);
  }
  return out;
}

function poseAt(tMs, seed = 0) {
  const t = tMs / 1000;
  const x = Math.sin(t * 0.15 + seed) * 1.2;
  const y = 0.2 + Math.sin(t * 0.05 + seed * 0.7) * 0.1;
  const z = 2.8 + Math.cos(t * 0.12 + seed) * 1.0;
  const yaw = Math.sin(t * 0.1 + seed) * 22;
  const pitch = Math.cos(t * 0.07 + seed) * 8;
  return { x, y, z, yaw, pitch, roll: 0 };
}

function buildClientPoses({
  durationMs,
  intervalMs,
  clientId,
  offsetMs = 0,
  yawOffset = 0,
  posOffset = [0, 0, 0],
  seed = 0,
}) {
  const poses = [];
  let i = 0;
  for (let t = 0; t <= durationMs; t += intervalMs) {
    const p = poseAt(Math.max(0, t + offsetMs), seed);
    poses.push({
      pose_id: `pose_${String(i).padStart(5, "0")}`,
      timestamp_ms: t,
      position: [p.x + posOffset[0], p.y + posOffset[1], p.z + posOffset[2]],
      yaw: p.yaw + yawOffset,
      pitch: p.pitch,
      roll: p.roll,
    });
    i += 1;
  }
  return { client_id: clientId, sample_interval_ms: intervalMs, poses };
}

function buildScenarios({ durationMs, intervalMs, clients }) {
  const allClients = Array.from({ length: clients }, (_, i) => `c${String(i + 1).padStart(2, "0")}`);
  const shared = allClients.map((clientId) =>
    buildClientPoses({ durationMs, intervalMs, clientId }),
  );
  const near = allClients.map((clientId, i) =>
    buildClientPoses({
      durationMs,
      intervalMs,
      clientId,
      offsetMs: i * 300,
      yawOffset: (i % 2 === 0 ? 1 : -1) * (4 + i),
      posOffset: [i % 3 === 0 ? 0.2 : -0.1, 0, i % 2 === 0 ? 0.15 : -0.12],
      seed: 0.1 * i,
    }),
  );
  const divergent = allClients.map((clientId, i) =>
    buildClientPoses({
      durationMs,
      intervalMs,
      clientId,
      offsetMs: i * 500,
      yawOffset: i * 25,
      posOffset: [i * 0.8, 0, -i * 0.7],
      seed: i * 1.7,
    }),
  );
  const split = allClients.map((clientId, i) => {
    const base = buildClientPoses({ durationMs, intervalMs, clientId, seed: i * 0.2 });
    const cohort = i % 3;
    for (const pose of base.poses) {
      if (pose.timestamp_ms > durationMs * 0.33 && pose.timestamp_ms < durationMs * 0.75) {
        pose.position[0] += cohort * 1.5 - 1.5;
        pose.yaw += cohort * 8 - 8;
      }
    }
    return base;
  });
  return [
    {
      scenario_id: "A_single_user",
      expected_overlap: "single-user",
      clients: [shared[0]],
    },
    {
      scenario_id: "B_lockstep_high_overlap",
      expected_overlap: "high",
      clients: shared,
    },
    {
      scenario_id: "C_nearcohort_partial_overlap",
      expected_overlap: "medium-high-partial",
      clients: near,
    },
    {
      scenario_id: "D_divergent_low_overlap",
      expected_overlap: "low",
      clients: divergent,
    },
    {
      scenario_id: "E_split_cohort_dynamic",
      expected_overlap: "time-varying",
      clients: split,
    },
  ];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.output);
  await fs.mkdir(outDir, { recursive: true });
  const scenarios = buildScenarios(args);
  for (const scenario of scenarios) {
    const outPath = path.join(outDir, `${scenario.scenario_id}.json`);
    await fs.writeFile(outPath, `${JSON.stringify(scenario, null, 2)}\n`, "utf8");
    console.log(`wrote ${outPath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
