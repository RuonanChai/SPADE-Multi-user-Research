/**
 * Robust summary CSV read/write (PowerShell Import-Csv compatible: UTF-8 BOM, CRLF, proper quoting).
 */
import fs from "node:fs";
import path from "node:path";

export const RUN_PASS_FAIL_COLUMNS = [
  "run",
  "method",
  "scenario",
  "trial",
  "delivery_profile",
  "canary",
  "status",
  "pass",
  "fail_reason",
  "session_id",
  "result_dir",
];

function escapeCsvCell(v) {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQ = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/** @param {string} file */
export function readSummaryCsv(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    /** @type {Record<string, string>} */
    const o = {};
    header.forEach((k, i) => { o[k] = cols[i] ?? ""; });
    return o;
  });
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {string} file
 * @param {{ bom?: boolean }} [opts]
 */
export function writeSummaryCsv(rows, file, opts = {}) {
  if (!rows.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const headerOnly = `${RUN_PASS_FAIL_COLUMNS.join(",")}\r\n`;
    const buf = (opts.bom !== false ? "\uFEFF" : "") + headerOnly;
    const fd = fs.openSync(file, "w");
    try {
      fs.writeSync(fd, buf, null, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return;
  }
  const keys = [...RUN_PASS_FAIL_COLUMNS];
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!keys.includes(k)) keys.push(k);
    }
  }
  const header = keys.join(",");
  const body = rows.map((r) => keys.map((k) => escapeCsvCell(r[k])).join(",")).join("\r\n");
  const text = `${header}\r\n${body}\r\n`;
  const buf = (opts.bom !== false ? "\uFEFF" : "") + text;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "w");
  try {
    fs.writeSync(fd, buf, null, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * @param {string} file
 * @param {Record<string, unknown>[]} newRows
 */
export function appendSummaryCsv(file, newRows) {
  if (!newRows.length) return;
  const prev = fs.existsSync(file) && fs.statSync(file).size > 0 ? readSummaryCsv(file) : [];
  writeSummaryCsv([...prev, ...newRows], file);
}

/**
 * @param {object} p
 */
export function buildRunPassFailRow(p) {
  const status = String(p.status ?? "FAIL");
  const pass = status === "PASS" || status === "SHARD_DONE";
  return {
    run: p.run ?? "",
    method: p.method ?? "",
    scenario: p.scenario ?? "",
    trial: p.trial ?? 0,
    delivery_profile: p.delivery_profile ?? "",
    canary: p.canary ?? "",
    status,
    pass: pass ? "true" : "false",
    fail_reason: pass ? "" : String(p.fail_reason ?? status),
    session_id: p.session_id ?? "",
    result_dir: p.result_dir ?? "",
  };
}

/**
 * @param {string} file
 * @param {number} [minRows]
 */
export function verifyRunPassFailCsv(file, minRows = 1) {
  if (!fs.existsSync(file)) {
    throw new Error(`run_pass_fail.csv missing: ${file}`);
  }
  const st = fs.statSync(file);
  if (st.size === 0) {
    throw new Error(`run_pass_fail.csv empty (0 bytes): ${file}`);
  }
  const rows = readSummaryCsv(file);
  if (rows.length < minRows) {
    const preview = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").slice(0, 400);
    throw new Error(
      `run_pass_fail.csv has ${rows.length} data row(s), need >=${minRows}. ` +
      `Path=${file} size=${st.size} preview=${JSON.stringify(preview)}`,
    );
  }
  const header = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)[0] ?? "";
  for (const col of ["status", "session_id", "delivery_profile"]) {
    if (!header.split(",").map((h) => h.trim()).includes(col)) {
      throw new Error(`run_pass_fail.csv missing column "${col}" in header: ${header}`);
    }
  }
  return rows;
}

/**
 * Merge-or-write for generic summary tables (per_client_metrics, etc.).
 * @param {string} file
 * @param {Record<string, unknown>[]} newRows
 * @param {boolean} append
 */
export function mergeOrWriteSummaryCsv(file, newRows, append) {
  if (!newRows.length) return;
  if (!append || !fs.existsSync(file) || fs.statSync(file).size === 0) {
    writeSummaryCsv(newRows, file);
    return;
  }
  const prev = readSummaryCsv(file);
  writeSummaryCsv([...prev, ...newRows], file);
}

function isMain() {
  try {
    const u = new URL(import.meta.url);
    const a = process.argv[1] ? path.resolve(process.argv[1]) : "";
    return u.pathname.replace(/^\/([A-Za-z]:)/, "$1").replace(/\//g, "\\") === a.replace(/\//g, "\\")
      || u.href.endsWith(process.argv[1] ?? "\0");
  } catch {
    return false;
  }
}

if (isMain()) {
  const cmd = process.argv[2];
  const file = process.argv[3];
  if (cmd === "read" && file) {
    console.log(JSON.stringify(readSummaryCsv(file)));
    process.exit(0);
  }
  if (cmd === "verify" && file) {
    const min = Number(process.argv[4] ?? 1);
    verifyRunPassFailCsv(file, min);
    console.log(`OK ${readSummaryCsv(file).length} row(s) in ${file}`);
    process.exit(0);
  }
  if (cmd === "append-row" && file && process.argv[4]) {
    const raw = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
    const rows = Array.isArray(raw) ? raw : [raw];
    appendSummaryCsv(file, rows.map((r) => buildRunPassFailRow(r)));
    verifyRunPassFailCsv(file, 1);
    console.log(`OK appended ${rows.length} row(s) → ${file}`);
    process.exit(0);
  }
  console.error("usage: summary_csv.mjs read|verify|append-row <csvPath> [minRows|jsonPath]");
  process.exit(2);
}
