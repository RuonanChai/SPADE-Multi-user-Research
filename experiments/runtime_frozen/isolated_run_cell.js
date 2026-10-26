"use strict";

const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const http2 = require("http2");
const https = require("https");
const path = require("path");
const { buildBarrierRelease } = require("./runtime_actuation_contract");
const { receiveReady } = require("./ready_protocol.js");
const { phaseOffsetMap, regimeForRunId } = require("./phase_regimes.js");
const { scoreCellImages } = require("./score_cell_images");

const ROOT = __dirname;
const NEW_ROOT = "F:\\WWW_N3_MUX\\research_control\\SPADE_BASELINE83_20261019";
const LEDGER = path.join(NEW_ROOT, "PHYSICAL_ATTEMPT_LEDGER.csv");
const SPARK_ROOT = "D:\\Program\\NSDI_SPADE_DIAG_W04\\spark";
const TRACE_NAMES = ["random_walk", "burst_turn", "stop_go", "orbit"];
const SSH = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
const SCP = "C:\\Windows\\System32\\OpenSSH\\scp.exe";
const KEY = "C:\\Users\\IoT\\.ssh\\id_ed25519";
const KNOWN = path.join(ROOT, "ssh", "known_hosts");
const CELL = "singlepass";
const RUN_ID = process.argv[2];
const METHOD = process.argv[3] || "LRU";
function loadAllowlist() {
  const file = path.join(NEW_ROOT, "QUEUE_ALLOWLIST.json");
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(parsed) ? parsed : parsed.rows || [];
}
const ATTEMPT = loadAllowlist().find((row) => row.run_id === RUN_ID);
if (!ATTEMPT || METHOD !== ATTEMPT.method) throw new Error("CELL_ARGV");
if (METHOD === "SPADE_Q") {
  const gatePath = path.join(NEW_ROOT, "SHADOW_GATE.json");
  if (!fs.existsSync(gatePath)) throw new Error("SPADE_Q_SHADOW_GATE_MISSING");
  const gate = JSON.parse(fs.readFileSync(gatePath, "utf8"));
  if (gate.pass !== true || gate.candidate !== "SPADE_Q_QUEUED_UNSENT") throw new Error("SPADE_Q_NOT_QUALIFIED");
}
const SEED = ATTEMPT.seed;
const ATTEMPT_ID = ATTEMPT.attempt;
const TRACE_NAME = TRACE_NAMES.find((name) => String(RUN_ID).includes(`_${name}_`));
if (!TRACE_NAME) throw new Error("TRACE_NOT_IN_RUN_ID");
const TRACE_FILE = path.join(ROOT, "traces", `${TRACE_NAME}.json`);
const REMOTE_ROOT = "D:\\Program\\SPADE_BASELINE83_20261019\\" + ATTEMPT_ID;
const REMOTE_ROOT_FWD = REMOTE_ROOT.replace(/\\/g, "/");
const WAVE = path.join(NEW_ROOT, "cells", ATTEMPT_ID);
const ORIGIN = process.argv[4] || "https://streaming-1438331348.cos.ap-guangzhou.myqcloud.com";
const HOP = process.argv[5] || "vite_h1";
const SLOTS = Number(process.argv[6] || 3);
const N = Number(process.argv[7] || ATTEMPT.n || 2);
const CLIENT_SCHEDULER = process.argv[8] || "LRU";

if (!["vite_h1", "rad_h2", "rad_direct"].includes(HOP)) throw new Error("CELL_HOP");
if (!["LRU", "SPADE", "SPADE_V2"].includes(CLIENT_SCHEDULER)) throw new Error("CELL_SCHEDULER");
if (CLIENT_SCHEDULER === "SPADE" && SLOTS !== 1) throw new Error("SPADE_REQUIRES_SERIAL_SLOT");
if (CLIENT_SCHEDULER === "SPADE_V2" && SLOTS !== 2) throw new Error("SPADE_V2_REQUIRES_TOTAL_CAP_2");
if (![1, 2, 3].includes(SLOTS)) throw new Error("CELL_SLOTS");
if (![1, 2, 3].includes(N)) throw new Error("CELL_N");
if (!String(RUN_ID).includes(`_N${N}_`) && !String(RUN_ID).startsWith(`nsdi_N${N}_`)) {
  throw new Error("CELL_N_MISMATCH");
}

const RAD_BASE = {
  vite_h1: "/_p5rad/",
  rad_h2: "https://192.168.1.200:18443/",
  rad_direct: "http://192.168.1.200:18081/",
}[HOP];
const PHASE_REGIME = regimeForRunId(RUN_ID);
const PHASE_BY_CLIENT = phaseOffsetMap(PHASE_REGIME);
const ALL_CLIENTS = {
  C3: { ip: "192.168.1.197", user: "C3_0", phaseOffset: PHASE_BY_CLIENT.C3 },
  C4: { ip: "192.168.1.196", user: "C4_1", phaseOffset: PHASE_BY_CLIENT.C4 },
  C5: { ip: "192.168.1.195", user: "C5_2", phaseOffset: PHASE_BY_CLIENT.C5 },
};
const ORDER = Array.isArray(ATTEMPT.clients) ? ATTEMPT.clients : ["C3", "C4", "C5"].slice(0, N);
if (ORDER.length !== N || ORDER.some((id) => !ALL_CLIENTS[id])) throw new Error("CLIENT_SET");
const CLIENTS = Object.fromEntries(ORDER.map((id) => [id, ALL_CLIENTS[id]]));
const SELECTED = Object.keys(CLIENTS);
const OFFSETS = SELECTED.map((id) => ALL_CLIENTS[id].phaseOffset);
const STATE_PATH = path.join(WAVE, "runtime", `state_${RUN_ID}.json`);
const NODE = process.execPath;
const HOSTS = ["192.168.1.200", "192.168.1.197", "192.168.1.196", "192.168.1.195"];

fs.mkdirSync(path.join(WAVE, "runtime"), { recursive: true });
fs.mkdirSync(path.join(WAVE, "logs", RUN_ID), { recursive: true });
fs.mkdirSync(path.join(WAVE, "metrics", RUN_ID), { recursive: true });

function sha(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { phase: "NEW", runId: RUN_ID };
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}
function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  fs.writeFileSync(path.join(WAVE, "metrics", RUN_ID, "state.json"), JSON.stringify(state, null, 2));
}
function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(WAVE, "logs", RUN_ID, "run_cell.log"), `${line}\n`);
}
function sshArgs(ip) {
  return ["-i", KEY, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${KNOWN}`, "-o", "ConnectTimeout=15", `p5remote@${ip}`];
}
function ssh(ip, command, timeout = 60000) {
  const result = spawnSync(SSH, [...sshArgs(ip), command], { encoding: "utf8", timeout, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`SSH ${ip} ${result.status} ${result.error ? result.error.message : ""} ${result.stderr || ""} ${result.stdout || ""}`);
  }
  return result.stdout || "";
}
function sshSoft(ip, command, timeout = 30000) {
  const result = spawnSync(SSH, [...sshArgs(ip), command], { encoding: "utf8", timeout, windowsHide: true });
  return `${result.stdout || ""}${result.stderr || ""}`;
}
function scp(local, ip, remote) {
  const staging = local.length > 200 ? shortStage(`${path.basename(local)}.${Date.now()}`) : local;
  if (staging !== local) {
    fs.mkdirSync(path.dirname(staging), { recursive: true });
    fs.copyFileSync(local, staging);
  }
  const args = ["-i", KEY, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${KNOWN}`, staging, `p5remote@${ip}:${remote}`];
  const result = spawnSync(SCP, args, { encoding: "utf8", timeout: 120000, windowsHide: true });
  if (result.status !== 0) throw new Error(`SCP ${ip} ${result.stderr || result.stdout}`);
}
function shortStage(name) {
  const dir = path.join(NEW_ROOT, "inbox", ATTEMPT_ID);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else fs.copyFileSync(src, dst);
  }
}
function scpFrom(ip, remote, local) {
  const staging = local.length > 200 ? shortStage(`${path.basename(local)}.${Date.now()}`) : local;
  fs.mkdirSync(path.dirname(staging), { recursive: true });
  if (staging !== local) { try { fs.unlinkSync(staging); } catch (_) {} }
  const args = ["-i", KEY, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${KNOWN}`, `p5remote@${ip}:${remote}`, staging];
  const result = spawnSync(SCP, args, { encoding: "utf8", timeout: 30000, windowsHide: true });
  if (result.status !== 0) throw new Error(`SCP_FROM ${ip} ${result.stderr || result.stdout}`);
  if (staging !== local) {
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.copyFileSync(staging, local);
  }
}
function scpDir(remoteSpec, dest) {
  const stage = shortStage(`dir_${path.basename(dest)}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const result = spawnSync(SCP, ["-r", "-i", KEY, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${KNOWN}`, remoteSpec, stage], { encoding: "utf8", timeout: 180000, windowsHide: true });
  if (fs.existsSync(stage)) copyTree(stage, dest);
  return result;
}
function listeningPids(port) {
  const out = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true }).stdout || "";
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (line.includes(`:${port} `) && line.includes("LISTENING")) {
      const pid = line.trim().split(/\s+/).pop();
      if (pid && pid !== "0" && pid !== "65108") pids.add(pid);
    }
  }
  return [...pids];
}
function killPids(pids) {
  for (const pid of pids) spawnSync("taskkill.exe", ["/F", "/PID", String(pid)], { windowsHide: true });
}
function leftoverPids() { return []; }
function assertPortsFree() {
  for (const port of [18081, 18443]) {
    const pids = listeningPids(port);
    if (pids.length) throw new Error(`PORT_BUSY ${port} ${pids.join(",")}`);
  }
}
function clockReady() {
  return new Promise((resolve) => {
    const req = http.get("http://127.0.0.1:18080/clock", (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(res.statusCode === 200 && Number.isFinite(JSON.parse(body).date_ms)); }
        catch (_) { resolve(false); }
      });
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}
function prepareConsoleAcl(ip) {
  const grants = [
    `icacls ${REMOTE_ROOT} /grant Users:(OI)(CI)M /T /Q`,
  ];
  for (const command of grants) {
    spawnSync(SSH, [...sshArgs(ip), command], { encoding: "utf8", timeout: 180000, windowsHide: true });
  }
}
const INTERACTIVE_USER = { C3: "Z8", C4: "Z8", C5: "thinkpad t14" };

function launchProvenTask(id, ip) {
  const user = INTERACTIVE_USER[id];
  const taskName = `SPADEF_${ATTEMPT_ID}_${id}`;
  const cmdPath = `${REMOTE_ROOT}\\evidence\\${RUN_ID}\\start_${id}.cmd`;
  const taskXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>G1 N2-launch plus client ${id}</Description>
  </RegistrationInfo>
  <Triggers />
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>/c "${cmdPath}"</Arguments>
      <WorkingDirectory>${REMOTE_ROOT}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
  const localXml = path.join(WAVE, "runtime", "tasks", `${taskName}.xml`);
  fs.mkdirSync(path.dirname(localXml), { recursive: true });
  fs.writeFileSync(localXml, taskXml);
  const remoteXml = `${REMOTE_ROOT}\\evidence\\${RUN_ID}\\${id}_task.xml`;
  scp(localXml, ip, remoteXml.replace(/\\/g, "/"));
  ssh(ip, `PowerShell -Command "schtasks /create /tn '${taskName}' /xml '${remoteXml}' /f"`);
  ssh(ip, `PowerShell -Command "schtasks /run /tn '${taskName}'"`);
  return JSON.stringify({ interactiveUser: user, task: taskName, xml: remoteXml });
}
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("timeout")));
  });
}
function hopGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol === "https:") {
      const client = http2.connect(`${u.protocol}//${u.host}`, { rejectUnauthorized: false });
      const timer = setTimeout(() => {
        client.close();
        reject(new Error("h2 timeout"));
      }, 12000);
      client.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      const req = client.request({
        ":path": u.pathname + u.search,
        range: "bytes=0-1023",
        "x-user-id": "C3_0",
        "x-run-id": RUN_ID,
      });
      let len = 0;
      let status = 0;
      req.on("response", (headers) => { status = headers[":status"]; });
      req.on("data", (chunk) => { len += chunk.length; });
      req.on("end", () => {
        clearTimeout(timer);
        client.close();
        resolve({ status, len });
      });
      req.on("error", (error) => {
        clearTimeout(timer);
        client.close();
        reject(error);
      });
      req.end();
      return;
    }
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: "GET",
      headers: { Range: "bytes=0-1023", "X-User-ID": "C3_0", "X-Run-ID": RUN_ID },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        len: Buffer.concat(chunks).length,
        origin: res.headers["x-p5-origin-url"] || null,
        originTtfbMs: res.headers["x-p5-origin-ttfb-ms"] || null,
      }));
    });
    req.on("error", reject);
    req.setTimeout(12000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitHttp(url, tries = 90) {
  let last = "";
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await httpGet(url);
      if (res.status === 200) return res.body;
      last = String(res.status);
    } catch (error) { last = error.message; }
    await sleep(500);
  }
  throw new Error(`HTTP not ready ${url} ${last}`);
}
function guard() {
  if (!WAVE.startsWith(NEW_ROOT)) throw new Error("WAVE_NOT_ISOLATED");
  if (!REMOTE_ROOT.startsWith("D:\\Program\\SPADE_BASELINE83_20261019\\")) throw new Error("REMOTE_NOT_ISOLATED");
  if (SPARK_ROOT !== "D:\\Program\\NSDI_SPADE_DIAG_W04\\spark") throw new Error("SPARK_READ_ROOT");
}
function cacheSpec(runId) {
  const matched = String(runId).match(/_b(\d+)e(\d+)_/);
  if (!matched) return { entries: 100, mb: 50, bytes: 50 * 1024 * 1024 };
  const mb = Number(matched[1]);
  const entries = Number(matched[2]);
  const key = `${mb}:${entries}`;
  const allowed = new Set(["1024:100", "50:2000", "1024:2000", "256:2000"]);
  if (!allowed.has(key)) throw new Error(`CACHE_NOT_PREREGISTERED ${key}`);
  const staggered = String(runId).includes("_staggered_");
  const syncLarge = String(runId).includes("_sync_b1024e2000_");
  if (key === "1024:2000" && !staggered && !syncLarge) throw new Error("CACHE_REGIME");
  if (key !== "1024:2000" && !staggered) throw new Error("CACHE_REQUIRES_STAGGER");
  return { entries, mb, bytes: mb * 1024 * 1024 };
}
function appendAttemptLedger(outcome) {
  if (process.env.SPADE_F_DRY_RUN === "1") throw new Error("DRY_RUN_MUST_NOT_LEDGER");
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  const header = "attempt_seq,attempt_id,run_id,method,seed,n,regime,started_at,outcome,evidence\n";
  if (!fs.existsSync(LEDGER)) fs.writeFileSync(LEDGER, header);
  const prior = fs.readFileSync(LEDGER, "utf8");
  if (prior.split(/\n/).some((line) => line.split(",")[1] === ATTEMPT_ID)) return;
  const row = [ATTEMPT.seq, ATTEMPT_ID, RUN_ID, METHOD, SEED, N, PHASE_REGIME, new Date().toISOString(), outcome || "LAUNCHED", WAVE].join(",");
  fs.appendFileSync(LEDGER, row + "\n");
  if ((outcome || "LAUNCHED") === "LAUNCHED") {
    fs.writeFileSync(path.join(NEW_ROOT, "EPOCH_LOCK.json"), JSON.stringify({
      state: "HELD", pid: process.pid, run_id: RUN_ID, cell_id: ATTEMPT_ID, started_at: new Date().toISOString(),
    }));
  }
}
function releaseEpochLock(status) {
  fs.writeFileSync(path.join(NEW_ROOT, "EPOCH_LOCK.json"), JSON.stringify({
    state: "RELEASED", pid: null, cell_id: ATTEMPT_ID, status, released_at: new Date().toISOString(),
  }));
}
function summarizeProbe(raw) {
  const parsed = JSON.parse(raw.trim().split(/\n/).filter(Boolean).pop());
  const offsets = parsed.rows.map((row) => row.offset);
  const rtts = parsed.rows.map((row) => row.rtt);
  return {
    host: parsed.host,
    n: parsed.rows.length,
    offset_ms: offsets.slice().sort((a, b) => a - b)[1],
    rtt_ms: rtts.slice().sort((a, b) => a - b)[1],
    max_error_ms: Math.max(...offsets) - Math.min(...offsets),
    rows: parsed.rows,
  };
}
function probe(ip) {
  const command = "node -e \"const http=require('http');const os=require('os');function once(){return new Promise((resolve,reject)=>{const t0=Date.now();http.get('http://192.168.1.200:18080/clock',res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{const t1=Date.now();const s=JSON.parse(b);resolve({t0,t1,rtt:t1-t0,server:s.date_ms,offset:s.date_ms-(t0+t1)/2});});}).on('error',reject);});}(async()=>{const rows=[];for(let i=0;i<3;i++){rows.push(await once());}console.log(JSON.stringify({host:os.hostname(),rows}));})();\"";
  return summarizeProbe(ssh(ip, command, 30000));
}

async function collect(state) {
  const evidence = path.join(WAVE, "evidence", RUN_ID);
  const logs = path.join(WAVE, "logs", RUN_ID);
  for (const [id, client] of Object.entries(CLIENTS)) {
    const dest = path.join(evidence, id);
    fs.mkdirSync(dest, { recursive: true });
    const remote = `p5remote@${client.ip}:${REMOTE_ROOT_FWD}/evidence/${RUN_ID}/${id}`;
    const copied = scpDir(remote, dest);
    if (copied.status !== 0) state.collectError = `${id} ${copied.stderr || copied.stdout}`;
    try { scpFrom(client.ip, `${REMOTE_ROOT_FWD}/evidence/${RUN_ID}/${id}_stdout.log`, path.join(logs, `${id}_stdout.log`)); } catch (error) { state.collectError = `${id} stdout ${error.message}`; }
    try { scpFrom(client.ip, `${REMOTE_ROOT_FWD}/evidence/${RUN_ID}/${id}_stderr.log`, path.join(logs, `${id}_stderr.log`)); } catch (error) { state.collectError = `${id} stderr ${error.message}`; }
    sshSoft(client.ip, `rem chrome-left-running`);
  }
  for (const pid of Object.values((state && state.pids) || {})) {
    if (pid) spawnSync("taskkill.exe", ["/PID", String(pid), "/F"], { windowsHide: true });
  }
  killPids(leftoverPids(18080));
  killPids(leftoverPids(18081));
  killPids(leftoverPids(18443));
  const image = scoreCellImages({ wave: WAVE, runId: RUN_ID, clients: SELECTED });
  state.imageMetrics = { psnr_measured: image.psnrMeasured, pairs: image.pairs, image: image.summary.image };
  state.phase = "DONE";
  saveState(state);
  logLine(`IMAGE_SCORED ${JSON.stringify(state.imageMetrics)}`);
  logLine(`CELL_FINISHED ${JSON.stringify({ ready: state.ready, done: state.done, runId: RUN_ID, hop: HOP, slots: SLOTS, n: N, image: state.imageMetrics })}`);
}

async function main() {
  guard();
  if (process.env.SPADE_F_DRY_RUN === "1") {
    const plan = { attempt_id: ATTEMPT_ID, run_id: RUN_ID, wave: WAVE, remote_root: REMOTE_ROOT, spark_read_only: SPARK_ROOT, trace: TRACE_FILE, ledger: LEDGER, seed: SEED };
    fs.mkdirSync(WAVE, { recursive: true });
    fs.writeFileSync(path.join(WAVE, "DRY_RUN_PLAN.json"), JSON.stringify(plan, null, 2));
    console.log("DRY_RUN_OK");
    return;
  }
  assertPortsFree();
  const state = loadState();
  if (state.phase === "DONE") {
    logLine(`ALREADY_DONE ${RUN_ID}`);
    return;
  }
  if (state.phase === "FAILED" && state.workersLaunched) {
    throw new Error("ATTEMPT_ALREADY_COUNTED_NO_RETRY");
  }
  if (state.workersLaunched && state.phase !== "FAILED") {
    await collect(state);
    return;
  }
  const cache = cacheSpec(RUN_ID);
  appendAttemptLedger("LAUNCHED");
  logLine(`start ${RUN_ID} method=${METHOD} client_scheduler=${CLIENT_SCHEDULER} hop=${HOP} slots=${SLOTS} N=${N} clients=${SELECTED.join(",")} phase_regime=${PHASE_REGIME} offsets=${OFFSETS.join(",")} cache_mb=${cache.mb} cache_entries=${cache.entries}`);
  killPids(leftoverPids(18080));
  killPids(leftoverPids(18081));
  killPids(leftoverPids(18443));
  const evidence = path.join(WAVE, "evidence", RUN_ID);
  fs.mkdirSync(path.join(evidence, "S_runtime"), { recursive: true });
  fs.writeFileSync(path.join(WAVE, "metrics", RUN_ID, "cell_spec.json"), JSON.stringify({
    run_id: RUN_ID, cell_id: CELL, method: METHOD, client_scheduler: CLIENT_SCHEDULER, hop: HOP, slots: SLOTS, n: N,
    phase_regime: PHASE_REGIME, phase_offsets_s: OFFSETS, clients: CLIENTS, rad_base: RAD_BASE, origin: ORIGIN,
    cache_max_entries: cache.entries, cache_max_bytes: cache.bytes,
  }, null, 2));
  const proxyOut = fs.openSync(path.join(WAVE, "logs", RUN_ID, "proxy_stdout.log"), "a");
  const proxyErr = fs.openSync(path.join(WAVE, "logs", RUN_ID, "proxy_stderr.log"), "a");
  const proxy = spawn(NODE, [
    path.join(ROOT, "proxy.js"),
    "--method", METHOD, "--port", "18081",
    "--origin-url", ORIGIN,
    "--cache-max-entries", String(cache.entries), "--cache-max-mb", String(cache.mb),
    "--dls-k", "0", "--run-id", RUN_ID, "--evidence-dir", path.join(evidence, "S_runtime"),
  ], { windowsHide: true, stdio: ["ignore", proxyOut, proxyErr] });
  if (!(await clockReady())) {
    const viteOut = fs.openSync(path.join(WAVE, "logs", RUN_ID, "vite_stdout.log"), "a");
    const viteErr = fs.openSync(path.join(WAVE, "logs", RUN_ID, "vite_stderr.log"), "a");
    const vite = spawn(NODE, [
      path.join(SPARK_ROOT, "node_modules", "vite", "bin", "vite.js"),
      "--config", path.join(ROOT, "vite.g1.config.js"),
      "--port", "18080", "--host", "0.0.0.0", "--strictPort",
    ], {
      cwd: SPARK_ROOT,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", viteOut, viteErr],
      env: {
        ...process.env,
        G1_STAGE_LOG: path.join(evidence, "S_runtime", "vite_rad_stages.jsonl"),
        G1_VITE_CACHE: path.join(WAVE, "runtime", "vite-cache"),
      },
    });
    vite.unref();
    logLine(`vite_persistent_started pid=${vite.pid}`);
  } else {
    logLine("vite_persistent_reused");
  }
  state.pids = { proxy: proxy.pid };
  state.phase = "SERVICES";
  state.method = METHOD;
  state.clientScheduler = CLIENT_SCHEDULER;
  state.hop = HOP;
  state.slots = SLOTS;
  state.n = N;
  saveState(state);
  const contractBody = await waitHttp("http://127.0.0.1:18081/runtime-contract");
  fs.writeFileSync(path.join(evidence, "S_runtime", "runtime_contract.json"), contractBody);
  const contract = JSON.parse(contractBody);
  if (contract.method !== METHOD || contract.cache_max_bytes !== cache.bytes || contract.cache_max_entries !== cache.entries || contract.dls_k !== 0) {
    throw new Error(`RUNTIME_CONFIG ${contractBody}`);
  }
  await waitHttp("http://127.0.0.1:18080/examples/streaming-lod/");
  await waitHttp("http://127.0.0.1:18080/dist/spark.module.js");
  await waitHttp("http://127.0.0.1:18080/clock");
  if (HOP === "rad_h2") {
    const h2Out = fs.openSync(path.join(WAVE, "logs", RUN_ID, "h2_stdout.log"), "a");
    const h2Err = fs.openSync(path.join(WAVE, "logs", RUN_ID, "h2_stderr.log"), "a");
    const h2 = spawn(NODE, [path.join(ROOT, "h2_front.js")], {
      windowsHide: true,
      stdio: ["ignore", h2Out, h2Err],
      env: {
        ...process.env,
        E1_H2_PORT: "18443",
        E1_H2_BACKEND: "18081",
        E1_H2_KEY: path.join(WAVE, "runtime", "key.pem"),
        E1_H2_CERT: path.join(WAVE, "runtime", "cert.pem"),
        E1_H2_LOG: path.join(evidence, "S_runtime", "h2_front.jsonl"),
      },
    });
    state.pids.h2 = h2.pid;
    saveState(state);
    const h2log = path.join(evidence, "S_runtime", "h2_front.jsonl");
    let listened = false;
    for (let i = 0; i < 40; i += 1) {
      if (fs.existsSync(h2log) && fs.readFileSync(h2log, "utf8").includes('"type":"listen"')) {
        listened = true;
        break;
      }
      await sleep(250);
    }
    if (!listened) throw new Error("H2_LISTEN_TIMEOUT");
  }
  const probeUrl = HOP === "vite_h1"
    ? `http://127.0.0.1:18080/_p5rad/coit-40m-sh1-lod.rad?user_id=C3_0&run_id=${encodeURIComponent(RUN_ID)}`
    : HOP === "rad_h2"
      ? `https://192.168.1.200:18443/coit-40m-sh1-lod.rad?user_id=C3_0&run_id=${encodeURIComponent(RUN_ID)}`
      : `http://127.0.0.1:18081/coit-40m-sh1-lod.rad?user_id=C3_0&run_id=${encodeURIComponent(RUN_ID)}`;
  let hopRes;
  try {
    hopRes = await hopGet(probeUrl);
  } catch (error) {
    hopRes = { status: 0, len: 0, error: String(error.message || error) };
  }
  fs.writeFileSync(path.join(WAVE, "metrics", RUN_ID, "hop_probe.json"), JSON.stringify({ hop: HOP, url: probeUrl, ...hopRes }, null, 2));
  if (hopRes.status !== 206 && hopRes.status !== 200) {
    if (HOP === "rad_h2") logLine(`hop probe warn ${JSON.stringify(hopRes)}; H2 listen already confirmed, continue`);
    else throw new Error(`HOP_PROBE ${JSON.stringify(hopRes)}`);
  } else {
    logLine(`hop probe ${HOP} status=${hopRes.status} len=${hopRes.len} origin=${hopRes.origin || ""} ttfb_ms=${hopRes.originTtfbMs || ""}`);
  }
  if (HOP !== "rad_h2" && !String(hopRes.origin || "").includes("myqcloud.com")) {
    throw new Error(`ORIGIN_NOT_COS ${JSON.stringify(hopRes)}`);
  }
  for (const [id, client] of Object.entries(CLIENTS)) {
    const reach = ssh(client.ip, "curl.exe -s -o NUL -w %{http_code} http://192.168.1.200:18080/examples/streaming-lod/");
    if (!reach.includes("200")) throw new Error(`CLIENT_FRONTEND ${id} ${reach}`);
    state.clockBefore = state.clockBefore || {};
    state.clockBefore[id] = probe(client.ip);
  }
  appendAttemptLedger("LAUNCHED");
  const schedulerContractSha = sha(path.join(evidence, "S_runtime", "runtime_contract.json"));
  const traceSha = sha(TRACE_FILE);
  const workerSha = sha(path.join(ROOT, "remote_worker_bundle.js"));
  const actuationSha = sha(path.join(ROOT, "runtime_actuation_contract.js"));
  const epoch = crypto.createHash("sha256").update(`n3mux-${RUN_ID}`).digest("hex");
  const matrix = crypto.createHash("sha256").update(`g1-stopgo-n${N}-hop-${HOP}-slots-${SLOTS}`).digest("hex");
  const topology = crypto.createHash("sha256").update("ethernet-c3-c4-c5").digest("hex");
  const fullConfigHash = crypto.createHash("sha256").update(RUN_ID).digest("hex");
  state.bindings = { schedulerContractSha, traceSha, workerSha, epoch, fullConfigHash, offsets: OFFSETS, hop: HOP, slots: SLOTS, n: N, clientScheduler: CLIENT_SCHEDULER };
  for (const [id, client] of Object.entries(CLIENTS)) {
    prepareConsoleAcl(client.ip);
    ssh(client.ip, `cmd /c if not exist ${REMOTE_ROOT}\\worker mkdir ${REMOTE_ROOT}\\worker`);
    ssh(client.ip, `cmd /c if not exist ${REMOTE_ROOT}\\traces mkdir ${REMOTE_ROOT}\\traces`);
    ssh(client.ip, `cmd /c if not exist ${REMOTE_ROOT}\\evidence\\${RUN_ID} mkdir ${REMOTE_ROOT}\\evidence\\${RUN_ID}`);
    ssh(client.ip, `cmd /c rmdir /s /q ${REMOTE_ROOT}\\evidence\\${RUN_ID}\\${id} & exit /b 0`);
    for (const name of ["remote_worker_bundle.js", "client_observation_hook.js", "capture_checkpoint.js", "runtime_actuation_contract.js", "render_diagnostic_contract.js", "cleanroom_visual_guard.js"]) {
      scp(path.join(ROOT, name), client.ip, `${REMOTE_ROOT_FWD}/worker/${name}`);
    }
    scp(path.join(ROOT, "ready_protocol.js"), client.ip, `${REMOTE_ROOT_FWD}/worker/ready_protocol.js`);
    scp(TRACE_FILE, client.ip, `${REMOTE_ROOT_FWD}/traces/${TRACE_NAME}.json`);
    const config = {
      runId: RUN_ID, clientId: id, cellId: `cell_${fullConfigHash}`, expectedClientIp: client.ip,
      method: METHOD, runtimeMethod: CLIENT_SCHEDULER, scene: ATTEMPT.scene_file || "coit-40m-sh1-lod", trace: TRACE_NAME, duration: 70,
      viteUrl: `http://192.168.1.200:18080/examples/streaming-lod/?rad_base=${encodeURIComponent(RAD_BASE)}&world=${encodeURIComponent(ATTEMPT.world || "Coit Tower, SF")}&p5_route=1&p5_test=1&user_id=${client.user}&run_id=${RUN_ID}&lod_fetchers=${SLOTS}&runtime_method=${encodeURIComponent(CLIENT_SCHEDULER)}&seed=${SEED}&scheduler_contract=${schedulerContractSha}`,
      evidenceDir: `${REMOTE_ROOT}\\evidence\\${RUN_ID}\\${id}`,
      tracePath: `${REMOTE_ROOT}\\traces\\${TRACE_NAME}.json`,
      traceSha256: traceSha, workerSha256: workerSha, phaseOffset: client.phaseOffset, seed: SEED,
      capacity: { max_entries: cache.entries, max_bytes: cache.bytes },
      runtimeSemantics: { key: CLIENT_SCHEDULER, dls_enabled: false, lookahead_K: 0, admit: CLIENT_SCHEDULER === "SPADE" ? "serial_current_demand" : CLIENT_SCHEDULER === "SPADE_V2" ? "headers_pending_1_body_active_1" : "fixed_slots" },
      scientificEpoch: epoch, matrixSha256: matrix, topologySha256: topology, fullConfigHash,
      actuationContractSha256: actuationSha,       schedulerContractSha256: schedulerContractSha, screenshotSampled: false, canvasCheckpoints: [2, 5, 10, 20, 40, 60],
      clockOffsetMs: state.clockBefore[id].offset_ms,
      replayWarmupMs: RUN_ID.includes("_warm15_") ? 15000 : 5000,
    };
    const localConfig = path.join(evidence, `${id}_config.json`);
    fs.writeFileSync(localConfig, JSON.stringify(config));
    const configSha = sha(localConfig);
    const remoteConfig = `${REMOTE_ROOT}\\evidence\\${RUN_ID}\\${id}_config.json`;
    scp(localConfig, client.ip, remoteConfig.replace(/\\/g, "/"));
    const launcher = [
      "@echo off",
      "set PLAYWRIGHT_BROWSERS_PATH=C:\\Users\\p5remote\\AppData\\Local\\ms-playwright",
      "set NODE_PATH=D:\\Program\\P5_3DGS_ICASSP_CLEAN\\node_modules",
      `"C:\\Program Files\\nodejs\\node.exe" ${REMOTE_ROOT}\\worker\\remote_worker_bundle.js ${REMOTE_ROOT}\\evidence\\${RUN_ID}\\${id}_config.json ${configSha} > ${REMOTE_ROOT}\\evidence\\${RUN_ID}\\${id}_stdout.log 2> ${REMOTE_ROOT}\\evidence\\${RUN_ID}\\${id}_stderr.log`,
      "",
    ].join("\r\n");
    const launcherPath = path.join(evidence, `start_${id}.cmd`);
    fs.writeFileSync(launcherPath, launcher);
    scp(launcherPath, client.ip, `${REMOTE_ROOT_FWD}/evidence/${RUN_ID}/start_${id}.cmd`);
    sshSoft(client.ip, `schtasks /End /TN SPADEF_${ATTEMPT_ID}_${id} >nul 2>&1`);
    sshSoft(client.ip, `icacls ${REMOTE_ROOT}\\evidence\\${RUN_ID} /grant Users:(OI)(CI)M /T /Q`);
    const launched = launchProvenTask(id, client.ip);
    fs.writeFileSync(path.join(evidence, `${id}_CONSOLE_LAUNCH.json`), launched);
    fs.writeFileSync(path.join(WAVE, "logs", RUN_ID, `${id}_CONSOLE_LAUNCH.json`), launched);
    state.consoleLaunch = state.consoleLaunch || {};
    state.consoleLaunch[id] = launched;
    state.workersLaunched = true;
    state.phase = "WORKERS";
    saveState(state);
    logLine(`launched ${id} ${launched}`);
  }
  const ready = {};
  const readyProbe = {};
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline && Object.keys(ready).length < N) {
    for (const [id, client] of Object.entries(CLIENTS)) {
      if (ready[id]) continue;
      const localPath = path.join(WAVE, "evidence", RUN_ID, id, "READY");
      const remote = `${REMOTE_ROOT_FWD}/evidence/${RUN_ID}/${id}/READY`;
      const received = receiveReady({
        fs,
        localPath,
        expected: { runId: RUN_ID, clientId: id },
        readRemote() {
          fs.mkdirSync(path.dirname(localPath), { recursive: true });
          const incoming = path.join(path.dirname(localPath), "READY.incoming");
          try { fs.unlinkSync(incoming); } catch (_) {}
          try {
            scpFrom(client.ip, remote, incoming);
          } catch (error) {
            const message = String(error && error.message ? error.message : error);
            if (/open local/i.test(message)) throw error;
            if (/No such file|not found|cannot find the file/i.test(message)) return null;
            throw error;
          }
          return fs.readFileSync(incoming, "utf8");
        },
      });
      readyProbe[id] = received.ok ? "RECEIVED" : `${received.reason || "REJECTED"} ${received.detail || ""}`.slice(0, 240);
      if (received.ok) ready[id] = true;
    }
    if (Object.keys(ready).length < N) await sleep(2000);
  }
  state.ready = ready;
  state.readyProbe = readyProbe;
  if (Object.keys(ready).length < N) throw new Error(`READY_MISSING ${JSON.stringify(ready)} probe=${JSON.stringify(readyProbe)}`);
  state.phase = "BARRIER";
  saveState(state);
  const barrierNow = Date.now();
  for (const [id, client] of Object.entries(CLIENTS)) {
    const barrier = buildBarrierRelease({
      cell_id: `cell_${fullConfigHash}`, seed: SEED, phase_offsets: OFFSETS, selected_clients: SELECTED,
    }, id, {
      runId: RUN_ID, scientificEpoch: epoch, matrixSha256: matrix, topologySha256: topology,
      traceSha256: traceSha, configSha256: sha(path.join(evidence, `${id}_config.json`)), schedulerContractSha256: schedulerContractSha,
    }, barrierNow);
    const barrierPath = path.join(evidence, `${id}_BARRIER.json`);
    fs.writeFileSync(barrierPath, JSON.stringify(barrier));
    scp(barrierPath, client.ip, `${REMOTE_ROOT_FWD}/evidence/${RUN_ID}/${id}/BARRIER.json`);
  }
  state.phase = "WAIT_DONE";
  saveState(state);
  const done = {};
  const doneDeadline = Date.now() + 900000;
  while (Date.now() < doneDeadline && Object.keys(done).length < N) {
    for (const [id, client] of Object.entries(CLIENTS)) {
      if (done[id]) continue;
      const out = sshSoft(client.ip, `cmd /c if exist ${REMOTE_ROOT}\\evidence\\${RUN_ID}\\${id}\\DONE echo DONE & if exist ${REMOTE_ROOT}\\evidence\\${RUN_ID}\\${id}\\${id}_error.json echo ERROR`);
      if (out.includes("DONE") || out.includes("ERROR")) done[id] = out.includes("DONE") ? "DONE" : "ERROR";
    }
    if (Object.keys(done).length < N) await sleep(3000);
  }
  state.done = done;
  state.clockAfter = {};
  for (const [id, client] of Object.entries(CLIENTS)) {
    try { state.clockAfter[id] = probe(client.ip); } catch (error) { state.clockAfter[id] = { error: error.message }; }
  }
  state.phase = "COLLECT";
  saveState(state);
  await collect(state);
  if (Object.values(done).some((value) => value !== "DONE") || Object.keys(done).length < N) {
    throw new Error(`CLIENT_NOT_DONE ${JSON.stringify(done)}`);
  }
  releaseEpochLock("DONE");
}

main().catch((error) => {
  const state = loadState();
  state.phase = "FAILED";
  state.error = error.stack || error.message;
  saveState(state);
  fs.writeFileSync(path.join(WAVE, "metrics", RUN_ID, "cell_result.json"), JSON.stringify({
    run_id: RUN_ID, status: state.workersLaunched ? "FAILED" : "PRECHECK_FAIL", error: state.error,
  }, null, 2));
  if (state.pids) {
    for (const pid of Object.values(state.pids)) spawnSync("taskkill.exe", ["/PID", String(pid), "/F"], { windowsHide: true });
  }
  killPids(leftoverPids(18080));
  killPids(leftoverPids(18081));
  killPids(leftoverPids(18443));
  for (const [id, client] of Object.entries(CLIENTS)) {
    sshSoft(client.ip, `rem chrome-left-running`);
  }
  releaseEpochLock("FAILED");
  logLine(error.stack || error.message);
  console.error(error.stack || error.message);
  process.exit(1);
});
