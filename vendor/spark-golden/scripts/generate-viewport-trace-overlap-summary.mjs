/**
 * 根据 scripts/traces/generated/<workload>/user*.json 估计「视口桶」重叠度，写入 summary/viewport_trace_overlap.json。
 * 用于 B/C/D viewport 套件；与 replay-worker 中 TracePlayer.start(offset_ms) 语义对齐（正 offset → 同一 wall-clock 下沿时间轴前移）。
 *
 *   node scripts/generate-viewport-trace-overlap-summary.mjs \
 *     --workload=B-viewport-lockstep \
 *     --traceRoot=scripts/traces/generated \
 *     --out=run/summary/viewport_trace_overlap.json
 *
 * C-viewport-nearcohort：读取 SPARK_VIEWPORT_NEAR_COHORT_STEP_MS（默认 300）或 SPARK_VIEWPORT_COHORT_OFFSETS=user0:0,user1:300,...
 */
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

const USERS = ["user0", "user1", "user2", "user3"];

function parseArgs(argv) {
  const o = { workload: "", traceRoot: "", out: "", cohortStepMs: "" };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    const k = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const v = eq === -1 ? "" : arg.slice(eq + 1);
    if (k === "workload") o.workload = v;
    else if (k === "traceRoot") o.traceRoot = v;
    else if (k === "out") o.out = v;
    else if (k === "cohortStepMs") o.cohortStepMs = v;
  }
  return o;
}

function cohortOffsetsMs(defaultStepMs) {
  const raw = process.env.SPARK_VIEWPORT_COHORT_OFFSETS && String(process.env.SPARK_VIEWPORT_COHORT_OFFSETS).trim();
  if (raw) {
    const m = {};
    for (const part of raw.split(",")) {
      const [uid, ms] = part.split(":").map((s) => s.trim());
      if (uid && ms != null) m[uid] = Number.parseInt(ms, 10);
    }
    if (Object.keys(m).length) return m;
  }
  const step = Number.parseInt(process.env.SPARK_VIEWPORT_NEAR_COHORT_STEP_MS || String(defaultStepMs), 10);
  const s = Number.isFinite(step) && step >= 0 ? step : 300;
  const out = {};
  USERS.forEach((u, i) => {
    out[u] = i * s;
  });
  return out;
}

function sampleTraceAt(trace, elapsedMs) {
  const samples = trace.samples || [];
  if (!samples.length) return { position: [0, 0, 0], quaternion: [0, 0, 0, 1] };
  const e = Number(elapsedMs);
  const tMin = samples[0].t_ms;
  const tMax = samples[samples.length - 1].t_ms;
  const clamped = Math.max(tMin, Math.min(tMax, e));
  let i = 0;
  while (i < samples.length - 1 && samples[i + 1].t_ms <= clamped) i += 1;
  const a = samples[i];
  const b = samples[Math.min(i + 1, samples.length - 1)];
  if (a === b || b.t_ms === a.t_ms) {
    return { position: [...a.position], quaternion: [...a.quaternion] };
  }
  const alpha = Math.max(0, Math.min(1, (clamped - a.t_ms) / (b.t_ms - a.t_ms)));
  const position = [
    a.position[0] + (b.position[0] - a.position[0]) * alpha,
    a.position[1] + (b.position[1] - a.position[1]) * alpha,
    a.position[2] + (b.position[2] - a.position[2]) * alpha,
  ];
  const quaternion = [
    a.quaternion[0] + (b.quaternion[0] - a.quaternion[0]) * alpha,
    a.quaternion[1] + (b.quaternion[1] - a.quaternion[1]) * alpha,
    a.quaternion[2] + (b.quaternion[2] - a.quaternion[2]) * alpha,
    a.quaternion[3] + (b.quaternion[3] - a.quaternion[3]) * alpha,
  ];
  return { position, quaternion };
}

function bucketFromPose(position, quaternion) {
  const rx = Math.round(position[0] * 40) / 40;
  const ry = Math.round(position[1] * 40) / 40;
  const rz = Math.round(position[2] * 40) / 40;
  const q = quaternion;
  const yaw = Math.atan2(2 * (q[3] * q[1] + q[0] * q[2]), 1 - 2 * (q[1] * q[1] + q[2] * q[2]));
  const yawBin = Math.round(yaw * 20) / 20;
  return `pos:${rx},${ry},${rz}|y:${yawBin}`;
}

function visitedBucketsForUser(trace, offsetMs, wallMax, stepMs) {
  const set = new Set();
  for (let w = 0; w <= wallMax; w += stepMs) {
    const elapsed = w + offsetMs;
    const { position, quaternion } = sampleTraceAt(trace, elapsed);
    set.add(bucketFromPose(position, quaternion));
  }
  return set;
}

function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 1;
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const cohortStepCli = argv.cohortStepMs ? Number.parseInt(argv.cohortStepMs, 10) : 300;
  const workload = argv.workload;
  if (!workload || !argv.traceRoot || !argv.out) {
    console.error("need --workload= --traceRoot= --out=");
    process.exitCode = 1;
    return;
  }

  const projectGuess = path.resolve(process.cwd(), argv.traceRoot);
  const traceDir = path.join(projectGuess, workload);

  const tracesByUser = {};
  for (const uid of USERS) {
    const fp = path.join(traceDir, `${uid}.json`);
    if (!existsSync(fp)) {
      console.error(`missing trace ${fp}`);
      process.exitCode = 1;
      return;
    }
    tracesByUser[uid] = JSON.parse(readFileSync(fp, "utf8"));
  }

  let offsets = {};
  if (workload === "C-viewport-nearcohort") {
    offsets = cohortOffsetsMs(Number.isFinite(cohortStepCli) ? cohortStepCli : 300);
  } else {
    USERS.forEach((u) => {
      offsets[u] = 0;
    });
  }

  const lastTsByUser = {};
  for (const u of USERS) {
    const s = tracesByUser[u].samples || [];
    lastTsByUser[u] = s.length ? s[s.length - 1].t_ms : 0;
  }
  const offsetVals = USERS.map((u) => offsets[u] || 0);
  const wallMax = Math.max(...Object.values(lastTsByUser), ...offsetVals) + 150;
  const stepMs = 50;

  const sets = {};
  for (const uid of USERS) {
    sets[uid] = visitedBucketsForUser(tracesByUser[uid], offsets[uid] || 0, wallMax, stepMs);
  }

  const pairwise_jaccard_overlap = {};
  for (let i = 0; i < USERS.length; i += 1) {
    for (let j = i + 1; j < USERS.length; j += 1) {
      const a = USERS[i];
      const b = USERS[j];
      pairwise_jaccard_overlap[`${a}|${b}`] = Number(jaccard(sets[a], sets[b]).toFixed(6));
    }
  }

  const vals = Object.values(pairwise_jaccard_overlap);
  const average_overlap_ratio = vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : 1;

  let union = new Set();
  let sumSizes = 0;
  for (const uid of USERS) {
    sumSizes += sets[uid].size;
    for (const x of sets[uid]) union.add(x);
  }

  /** 启发式：视口桶重叠越高，边缘合并同一静态资源的概率越大（上限裁剪） */
  const expected_shareable_object_ratio = Number(Math.min(1, Math.max(0, average_overlap_ratio * 0.92)).toFixed(6));

  const payload = {
    generated_at: new Date().toISOString(),
    workload,
    users: USERS,
    methodology:
      "Quantized camera pose buckets over simulated wall-clock [0..wallMax]ms with TracePlayer offset semantics (elapsed = wall + offset_ms); not GPU-visible-set truth.",
    wall_simulation_ms: { wall_max: wallMax, step_ms: stepMs },
    trace_timeline_end_ms_by_user: lastTsByUser,
    start_offset_ms_by_user: offsets,
    total_visible_objects: sumSizes,
    unique_visible_objects: union.size,
    pairwise_jaccard_overlap,
    average_overlap_ratio: Number(average_overlap_ratio.toFixed(6)),
    expected_shareable_object_ratio,
  };

  const outAbs = path.isAbsolute(argv.out) ? argv.out : path.resolve(process.cwd(), argv.out);
  await fs.mkdir(path.dirname(outAbs), { recursive: true });
  await fs.writeFile(outAbs, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`[viewport-trace-overlap] wrote ${outAbs}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
