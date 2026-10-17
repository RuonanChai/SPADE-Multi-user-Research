/**
 * Deterministic camera trace generator for VRC experiments.
 * Produces JSON trace files for 3 scenarios × 4 users.
 * Each trace: { scenario_id, user_id, duration_ms, samples: [{t_ms, position, quaternion, fov}] }
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_INTERVAL_MS = 100;
const DURATION_MS = 30000;
const NUM_SAMPLES = Math.floor(DURATION_MS / SAMPLE_INTERVAL_MS) + 1;
const FOV = 75;

function eulerToQuat(pitchDeg, yawDeg, rollDeg) {
  const p = (pitchDeg * Math.PI) / 180 / 2;
  const y = (yawDeg * Math.PI) / 180 / 2;
  const r = (rollDeg * Math.PI) / 180 / 2;
  const cp = Math.cos(p), sp = Math.sin(p);
  const cy = Math.cos(y), sy = Math.sin(y);
  const cr = Math.cos(r), sr = Math.sin(r);
  return [
    sr * cp * cy - cr * sp * sy,
    cr * sp * cy + sr * cp * sy,
    cr * cp * sy - sr * sp * cy,
    cr * cp * cy + sr * sp * sy,
  ];
}

function lerp(a, b, t) { return a + (b - a) * t; }
function lerpArr(a, b, t) { return a.map((v, i) => lerp(v, b[i], t)); }

function slerp(q1, q2, t) {
  let dot = q1[0]*q2[0] + q1[1]*q2[1] + q1[2]*q2[2] + q1[3]*q2[3];
  const q2c = dot < 0 ? q2.map(v => -v) : [...q2];
  dot = Math.abs(dot);
  if (dot > 0.9995) return lerpArr(q1, q2c, t).map((v, i, a) => {
    const len = Math.sqrt(a.reduce((s, x) => s + x*x, 0));
    return v / len;
  });
  const theta = Math.acos(Math.min(1, dot));
  const sinT = Math.sin(theta);
  const w1 = Math.sin((1 - t) * theta) / sinT;
  const w2 = Math.sin(t * theta) / sinT;
  const out = q1.map((v, i) => v * w1 + q2c[i] * w2);
  const len = Math.sqrt(out.reduce((s, x) => s + x*x, 0));
  return out.map(v => v / len);
}

function smoothstep(t) { return t * t * (3 - 2 * t); }

function generateNearby(userIdx) {
  const starts = [
    { pos: [-0.858, 2.203, -1.128], yaw: -66 },
    { pos: [-0.558, 2.203, -1.128], yaw: -56 },
    { pos: [-1.158, 2.203, -0.828], yaw: -71 },
    { pos: [-0.658, 2.203, -0.928], yaw: -61 },
  ];
  const panSpeeds = [0.8, -0.6, 0.0, 0.5]; // deg/s yaw rate
  const driftX = [0.02, -0.015, 0.0, 0.01]; // m/s lateral drift

  const s = starts[userIdx];
  const samples = [];
  for (let i = 0; i < NUM_SAMPLES; i++) {
    const t_ms = i * SAMPLE_INTERVAL_MS;
    const t_s = t_ms / 1000;
    const yaw = s.yaw + panSpeeds[userIdx] * t_s;
    const pos = [
      s.pos[0] + driftX[userIdx] * t_s,
      s.pos[1],
      s.pos[2],
    ];
    samples.push({ t_ms, position: pos.map(v => +v.toFixed(4)), quaternion: eulerToQuat(-5, yaw, 0).map(v => +v.toFixed(5)), fov: FOV });
  }
  return samples;
}

function generateBurstTurn(userIdx) {
  const configs = [
    { pos: [-2.0, 1.6, 0.0], startYaw: 90, turnTime: 5000 },
    { pos: [2.0, 1.6, 0.0], startYaw: -90, turnTime: 5500 },
    { pos: [0.0, 1.6, -2.0], startYaw: 180, turnTime: 6000 },
    { pos: [0.0, 1.6, 4.0], startYaw: 0, turnTime: 0 },
  ];
  const targetYaw = 0;
  const targetPitch = -5;
  const turnDuration = 2000; // ms to complete turn

  const c = configs[userIdx];
  const samples = [];
  for (let i = 0; i < NUM_SAMPLES; i++) {
    const t_ms = i * SAMPLE_INTERVAL_MS;
    let yaw = c.startYaw;
    let pitch = 0;

    if (c.turnTime === 0) {
      yaw = targetYaw;
      pitch = targetPitch;
    } else if (t_ms >= c.turnTime) {
      const progress = Math.min(1, (t_ms - c.turnTime) / turnDuration);
      const s = smoothstep(progress);
      yaw = lerp(c.startYaw, targetYaw, s);
      pitch = lerp(0, targetPitch, s);
    }

    // After turn, slight drift to simulate natural head movement
    const postTurnT = Math.max(0, t_ms - (c.turnTime + turnDuration)) / 1000;
    const drift = Math.sin(postTurnT * 0.5 + userIdx) * 2;

    samples.push({
      t_ms,
      position: c.pos.map(v => +v.toFixed(4)),
      quaternion: eulerToQuat(pitch, yaw + drift, 0).map(v => +v.toFixed(5)),
      fov: FOV,
    });
  }
  return samples;
}

function generateDivergent(userIdx) {
  const configs = [
    { pos: [-3.0, 1.6, 0.0], yaw: 180, panRate: -3.0, pitch: 0 },
    { pos: [3.0, 1.6, 0.0], yaw: 0, panRate: 3.0, pitch: 0 },
    { pos: [0.0, 4.0, 0.0], yaw: 0, panRate: 1.5, pitch: -60 },
    { pos: [0.0, 0.2, -3.0], yaw: 180, panRate: 0.0, pitch: 10 },
  ];
  const moveSpeed = [0.03, -0.03, 0.0, 0.0]; // lateral m/s

  const c = configs[userIdx];
  const samples = [];
  for (let i = 0; i < NUM_SAMPLES; i++) {
    const t_ms = i * SAMPLE_INTERVAL_MS;
    const t_s = t_ms / 1000;
    const yaw = c.yaw + c.panRate * t_s;
    const pos = [
      c.pos[0] + moveSpeed[userIdx] * t_s,
      c.pos[1],
      c.pos[2],
    ];
    samples.push({
      t_ms,
      position: pos.map(v => +v.toFixed(4)),
      quaternion: eulerToQuat(c.pitch, yaw, 0).map(v => +v.toFixed(5)),
      fov: FOV,
    });
  }
  return samples;
}

const generators = { nearby: generateNearby, burst_turn: generateBurstTurn, divergent: generateDivergent };

for (const [scenario, gen] of Object.entries(generators)) {
  for (let u = 0; u < 4; u++) {
    const trace = {
      scenario_id: scenario,
      user_id: `u${u}`,
      duration_ms: DURATION_MS,
      sample_interval_ms: SAMPLE_INTERVAL_MS,
      samples: gen(u),
    };
    const fname = `${scenario}_u${u}.json`;
    fs.writeFileSync(path.join(__dirname, fname), JSON.stringify(trace, null, 2));
    console.log(`wrote ${fname} (${trace.samples.length} samples)`);
  }
}
console.log("Done: 12 trace files generated.");
