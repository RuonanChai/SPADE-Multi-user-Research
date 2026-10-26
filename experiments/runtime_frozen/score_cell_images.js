"use strict";

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CHECKS = [2, 5, 10, 20, 40, 60];
const WSL_PYTHON = "/home/dd/spade_f_repair_venv/bin/python";
const SCORER_LINUX = "/mnt/d/Program/SPADE/SPADE_BYTE_N23_20261023/physical_runtime/image_metrics/score_psnr_ssim.py";
const SCRATCH = path.join(process.env.TEMP || "C:\\Users\\IoT\\AppData\\Local\\Temp", "spade_score");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function pngSize(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 24 || buf.toString("ascii", 1, 4) !== "PNG") return { width: "", height: "" };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
function near(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((value, index) => Math.abs(Number(value) - Number(right[index])) < 1e-6);
}
function linuxPath(file) {
  return String(file).replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
}
function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function clientDir(evidenceRoot, id) {
  const nested = path.join(evidenceRoot, id, id);
  if (fs.existsSync(path.join(nested, `${id}_evidence.json`)) || fs.existsSync(path.join(nested, "REFERENCE_STAGE.json"))) {
    return nested;
  }
  return path.join(evidenceRoot, id);
}
function scorePair(measured, reference) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const left = path.join(SCRATCH, "measured.png");
  const right = path.join(SCRATCH, "reference.png");
  fs.copyFileSync(measured, left);
  fs.copyFileSync(reference, right);
  const env = Object.assign({}, process.env, { MSYS_NO_PATHCONV: "1" });
  const run = spawnSync("wsl.exe", [
    "-e", WSL_PYTHON, SCORER_LINUX, linuxPath(left), linuxPath(right), "--reference-proven", "true",
  ], { encoding: "utf8", env, timeout: 120000, windowsHide: true });
  const stdout = (run.stdout || "").trim();
  if (!stdout.startsWith("{")) {
    return { status: "SCORER_FAILED", psnr: null, ssim: null, reason: ((run.stderr || stdout || `status=${run.status}`)).slice(0, 240) };
  }
  const parsed = JSON.parse(stdout);
  const measuredOk = parsed.status === "MEASURED" || parsed.status === "IDENTICAL_INF";
  return {
    status: parsed.status,
    psnr: measuredOk ? parsed.psnr : null,
    ssim: measuredOk ? parsed.ssim : null,
    reason: parsed.reason || "",
  };
}

function scoreClient(dir, id) {
  const stageFile = path.join(dir, "REFERENCE_STAGE.json");
  const stage = fs.existsSync(stageFile) ? readJson(stageFile) : { rows: [] };
  const refByCheckpoint = new Map((stage.rows || []).map((row) => [row.checkpoint_s, row]));
  const rows = [];
  for (const checkpoint of CHECKS) {
    const posePath = path.join(dir, `canvas_t${checkpoint}.json`);
    const framePath = path.join(dir, `canvas_t${checkpoint}.png`);
    const refPath = path.join(dir, `reference_t${checkpoint}.png`);
    const pose = fs.existsSync(posePath) ? readJson(posePath) : null;
    const frameExists = fs.existsSync(framePath);
    const refMeta = refByCheckpoint.get(checkpoint) || (fs.existsSync(path.join(dir, `reference_t${checkpoint}.json`)) ? readJson(path.join(dir, `reference_t${checkpoint}.json`)) : null);
    const completeness = refMeta && refMeta.completeness ? refMeta.completeness : {};
    const proven = completeness.status === "FULL_VIEW_REFERENCE_PROVEN" && completeness.full_resource === false;
    const frameSha = frameExists ? sha256(framePath) : "";
    const size = frameExists ? pngSize(framePath) : { width: "", height: "" };
    const bufferW = pose && pose.pose ? pose.pose.buffer_width : "";
    const bufferH = pose && pose.pose ? pose.pose.buffer_height : "";
    const hashOk = Boolean(pose && pose.ok && frameExists && frameSha === pose.sha256);
    const dimensionOk = Boolean(hashOk && size.width === bufferW && size.height === bufferH);
    const refExists = fs.existsSync(refPath);
    const refSha = refExists ? sha256(refPath) : "";
    const samePose = Boolean(
      pose && pose.pose && refMeta && refMeta.pose_before && refMeta.pose_after
      && near(pose.pose.position, refMeta.pose_before.position)
      && near(pose.pose.quaternion, refMeta.pose_before.quaternion)
      && near(pose.pose.position, refMeta.pose_after.position)
      && near(pose.pose.quaternion, refMeta.pose_after.quaternion)
    );
    const reasons = [];
    if (!pose) reasons.push("POSE_JSON_MISSING");
    else if (pose.error) reasons.push(pose.error);
    else if (!frameExists) reasons.push("FRAME_MISSING");
    else if (frameSha !== pose.sha256) reasons.push("FRAME_HASH_MISMATCH");
    else if (hashOk && !dimensionOk) reasons.push(`PNG_${size.width}x${size.height}_BUFFER_${bufferW}x${bufferH}`);
    if (!proven) reasons.push(completeness.reason || "REFERENCE_NOT_PROVEN");
    if (hashOk && refMeta && !samePose) reasons.push("POSE_NOT_ALIGNED");
    let psnr = null;
    let ssim = null;
    let status = "NOT_MEASURED";
    if (dimensionOk && proven && samePose && refExists && (!refMeta.sha256 || refSha === refMeta.sha256) && size.width === pngSize(refPath).width && size.height === pngSize(refPath).height) {
      const scored = scorePair(framePath, refPath);
      if (scored.status === "MEASURED" || scored.status === "IDENTICAL_INF") {
        psnr = scored.psnr;
        ssim = scored.ssim;
        status = scored.status;
      } else {
        reasons.push(scored.reason || scored.status);
        status = scored.status || "REJECTED";
      }
    }
    rows.push({
      client: id,
      checkpoint_s: checkpoint,
      status,
      psnr,
      ssim,
      completeness_status: completeness.status || "",
      same_pose: samePose,
      proven,
      missing_reason: reasons.join("|"),
    });
  }
  const measured = rows.filter((row) => row.psnr !== null && row.ssim !== null);
  if (measured.length) {
    fs.writeFileSync(path.join(dir, "qoe_sample.json"), JSON.stringify({
      phase: "aligned_checkpoint",
      checkpoint_s: measured[measured.length - 1].checkpoint_s,
      psnr: measured[measured.length - 1].psnr,
      ssim: measured[measured.length - 1].ssim,
      psnr_reason: null,
      ssim_reason: null,
      pairs_measured: measured.length,
      scorer: "wsl:/home/dd/spade_f_repair_venv/bin/python + live_runtime/image_metrics/score_psnr_ssim.py",
    }, null, 2));
  }
  return { rows, measured: measured.length };
}

function scoreCellImages({ wave, runId, clients }) {
  const evidenceRoot = path.join(wave, "evidence", runId);
  const allRows = [];
  let psnrMeasured = 0;
  for (const id of clients) {
    const dir = clientDir(evidenceRoot, id);
    const scored = scoreClient(dir, id);
    allRows.push(...scored.rows);
    psnrMeasured += scored.measured;
  }
  const outDir = path.join(wave, "metrics", runId);
  fs.mkdirSync(outDir, { recursive: true });
  const header = ["client", "checkpoint_s", "status", "psnr", "ssim", "completeness_status", "same_pose", "proven", "missing_reason"];
  const csv = [header.join(","), ...allRows.map((row) => header.map((key) => csvCell(row[key])).join(","))].join("\n") + "\n";
  fs.writeFileSync(path.join(outDir, "FRAME_METRICS.csv"), csv);
  const summary = {
    run_id: runId,
    psnr_measured: psnrMeasured,
    pairs_total: allRows.length,
    image: psnrMeasured > 0 ? "MEASURED" : "NOT_MEASURED",
    rows: allRows,
  };
  fs.writeFileSync(path.join(outDir, "IMAGE_METRICS.json"), JSON.stringify(summary, null, 2));
  return { psnrMeasured, pairs: allRows.length, summary };
}

module.exports = { scoreCellImages, scorePair, CHECKS };

if (require.main === module) {
  const wave = process.argv[2];
  const runId = process.argv[3];
  const clients = (process.argv[4] || "C3,C4").split(",");
  const result = scoreCellImages({ wave, runId, clients });
  console.log(JSON.stringify({ psnr_measured: result.psnrMeasured, pairs: result.pairs, image: result.summary.image }, null, 2));
}
