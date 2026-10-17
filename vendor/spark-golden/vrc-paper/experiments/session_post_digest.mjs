/**
 * After merge / validation, aggregate session artifacts into session_digest.json
 * for human + agent review. Does not auto-fix code; optional strict exit via env.
 *
 * Env:
 *   VRC_SESSION_DIGEST_FAIL=1 — caller may treat digest gate failure as run failure
 *     (orchestrator uses this with merged status + distributed_validation).
 */

import fs from "node:fs";
import path from "node:path";

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function summarizePerClientCsv(finalRunDir) {
  const p = path.join(finalRunDir, "per_client_metrics.csv");
  let text;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch {
    return { ok: false, reason: "missing_csv", rows: [] };
  }
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { ok: false, reason: "empty_csv", rows: [] };
  const header = lines[0].split(",");
  const idx = (name) => header.indexOf(name);
  const iUser = idx("user_id");
  const iCdn = idx("cdn_bytes");
  const iCdn2 = idx("cdn2_bytes");
  const iHpc = idx("hpc_bytes");
  const iLab = idx("cdn_label");
  const rows = [];
  for (let li = 1; li < lines.length; li++) {
    const cols = lines[li].split(",");
    rows.push({
      user_id: iUser >= 0 ? cols[iUser] : null,
      cdn_label: iLab >= 0 ? cols[iLab] : null,
      cdn_bytes: iCdn >= 0 ? Number(cols[iCdn]) || 0 : null,
      cdn2_bytes: iCdn2 >= 0 ? Number(cols[iCdn2]) || 0 : null,
      hpc_bytes: iHpc >= 0 ? Number(cols[iHpc]) || 0 : null,
    });
  }
  return { ok: true, rows };
}

/**
 * @param {string} finalRunDir merged session directory
 * @param {(s: string) => void} [logFn]
 * @returns {{ digest: object, gate_ok: boolean }}
 */
export function writeSessionPostDigest(finalRunDir, logFn = () => {}) {
  const status = readJsonSafe(path.join(finalRunDir, "status.json"));
  const dist = readJsonSafe(path.join(finalRunDir, "distributed_validation.json"));
  const srcVal = readJsonSafe(path.join(finalRunDir, "source_validation.json"));
  const srcBr = readJsonSafe(path.join(finalRunDir, "source_breakdown.json"));
  const pc = summarizePerClientCsv(finalRunDir);

  const hints = [];
  if (!status) hints.push("missing:status.json");
  if (status?.status && status.status !== "PASS") {
    hints.push(`run_status:${status.status}`);
  }
  if (dist) {
    if (!dist.ok) hints.push(`distributed_errors:${(dist.errors || []).join(";")}`);
    for (const w of dist.warnings || []) hints.push(`distributed_warning:${w}`);
  }
  if (srcVal && srcVal.valid === false) {
    const err = srcVal.errors || [];
    const sample = err.slice(0, 8).join(" | ");
    hints.push(`source_validation_failed(count=${err.length}):${sample}`);
  }
  if (!srcBr) hints.push("missing:source_breakdown.json");
  if (!pc.ok) hints.push(`per_client_metrics:${pc.reason}`);

  const runPass = status?.status === "PASS";
  const distPass = !dist || dist.ok === true;
  const srcPass = !srcVal || srcVal.valid !== false;
  const gate_ok = !!(runPass && distPass && srcPass);

  const digest = {
    timestamp: new Date().toISOString(),
    final_run_dir: finalRunDir,
    gate_ok,
    run_status: status?.status ?? null,
    distributed_validation_ok: dist ? dist.ok : null,
    source_validation_ok: srcVal ? !!srcVal.valid : null,
    hints,
    source_breakdown_counts: srcBr
      ? {
        hpc_request_count: srcBr.hpc_request_count,
        cdn_request_count: srcBr.cdn_request_count,
        cdn2_request_count: srcBr.cdn2_request_count,
        hpc_bytes: srcBr.hpc_bytes,
        cdn_bytes: srcBr.cdn_bytes,
        cdn2_bytes: srcBr.cdn2_bytes,
      }
      : null,
    per_client_transport: pc.rows,
  };

  const outPath = path.join(finalRunDir, "session_digest.json");
  try {
    fs.writeFileSync(outPath, JSON.stringify(digest, null, 2), "utf8");
    logFn(`session_digest → ${outPath} gate_ok=${gate_ok}`);
  } catch (e) {
    logFn(`session_digest write failed: ${e.message}`);
  }

  return { digest, gate_ok };
}
