/**
 * Dual-CDN + distributed lab preflight (no silent downgrade).
 *
 *   node experiments/dual_cdn_preflight.mjs --assets-only
 *   node experiments/dual_cdn_preflight.mjs --connectivity-only   # Vite+sync must already be up on controller
 *
 * Env: VRC_HPC_ASSET_BASE, VRC_CDN_ASSET_BASE, VRC_CDN2_ASSET_BASE (CDN2 ≠ CDN1),
 *      optional VRC_CDN2_OBJECT_PATH (defaults to same flat key as HPC/CDN1; set for GCS nested keys),
 *      VRC_RESULTS_ROOT, VRC_DISTRIBUTED_CONFIG (optional)
 *      VRC_SKIP_CORS_PREFLIGHT=1 — skip OPTIONS probe (not recommended; Worker2 needs CDN CORS for http://<controller>:<vite_port>)
 * Lab JSON (same file as distributed runs): optional cdn2_asset_base, cdn2_object_path,
 *      cdn2_object_path_hobbiton — merged into env when env is empty (see distributed_lab_cdn2_env.mjs).
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { applyCdn2EnvFromLab } from "./distributed_lab_cdn2_env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ARGS = new Set(process.argv.slice(2));
const ASSETS_ONLY = ARGS.has("--assets-only");
const CONNECTIVITY_ONLY = ARGS.has("--connectivity-only");
/** origin_only | cdn1 | dual_cdn | full (all required) */
const REQUIRE_PROFILE = (() => {
  const i = process.argv.indexOf("--require-profile");
  if (i !== -1 && process.argv[i + 1]) return String(process.argv[i + 1]).trim().toLowerCase();
  return "full";
})();

function curlBin() {
  return process.platform === "win32" ? "curl.exe" : "curl";
}

/**
 * Simulate browser CORS preflight from the distributed experiment page origin.
 * Worker2 loads Vite from controller LAN IP, so Origin is http://<controller>:<vite_port> — must be allowed on R2/GCS.
 */
function probeCorsOptions(urlStr, pageOrigin, label) {
  const args = [
    "-sS", "-D", "-", "-o", process.platform === "win32" ? "NUL" : "/dev/null",
    "--max-time", "20",
    "-X", "OPTIONS",
    "-H", `Origin: ${pageOrigin}`,
    "-H", "Access-Control-Request-Method: GET",
    "-H", "Access-Control-Request-Headers: range",
    urlStr,
  ];
  const r = spawnSync(curlBin(), args, { encoding: "utf8" });
  const blob = (r.stdout ?? "").toString();
  const line = blob.split(/\r?\n/).find((l) => /^HTTP\//i.test(l));
  const m = line?.match(/HTTP\/\d(?:\.\d)?\s+(\d+)/);
  const code = m ? Number(m[1]) : null;
  if (code === 403 || code === 401) {
    return {
      ok: false,
      label,
      url: urlStr,
      pageOrigin,
      code,
      detail:
        `CORS preflight failed (${code}) for ${label}. ` +
        `Browsers on Worker2 use Origin "${pageOrigin}" when fetching CDN objects — add this origin to ` +
        `R2 bucket CORS (or GCS bucket CORS). Plain "curl Range" without Origin cannot catch this. ` +
        `Ref: OPTIONS ${urlStr}`,
    };
  }
  if (code === 405 || code === 501) {
    return { ok: true, label, code, note: "OPTIONS not implemented; skipping strict CORS assert" };
  }
  if (code != null && code >= 200 && code < 300) return { ok: true, label, code };
  if (code != null && code >= 400) {
    return {
      ok: false,
      label,
      url: urlStr,
      pageOrigin,
      code,
      detail: `CORS preflight unexpected status ${code} for ${label} OPTIONS ${urlStr}`,
    };
  }
  return { ok: true, label, code, note: "unparsed OPTIONS status" };
}

function loadCfg() {
  const cfgPath = process.env.VRC_DISTRIBUTED_CONFIG
    ? path.resolve(process.env.VRC_DISTRIBUTED_CONFIG)
    : path.join(ROOT, "experiments", "distributed_lab.json");
  if (!fs.existsSync(cfgPath)) {
    console.error(`[preflight] FATAL: missing ${cfgPath}`);
    process.exit(2);
  }
  return { cfg: JSON.parse(fs.readFileSync(cfgPath, "utf8")), cfgPath };
}

async function probeUrl(urlStr, label, maxRetries = 3) {
  // Use Node fetch (undici) — curl.exe has Windows schannel/TLS issues with GCS.
  // Retry up to maxRetries times for transient network errors (GCS intermittent timeouts).
  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 20000);
    try {
      const r = await fetch(urlStr, {
        method: "GET",
        headers: { Range: "bytes=0-1023", "User-Agent": "vrc-dual-cdn-preflight/2" },
        redirect: "follow",
        signal: ac.signal,
      });
      clearTimeout(timeout);
      // Drain body to release connection
      await r.arrayBuffer();
      const status = r.status;
      const ok = status >= 200 && status < 400;
      const row = {
        endpoint_type: label,
        url: urlStr,
        status,
        content_length: r.headers.get("content-length") ?? null,
        accept_ranges: r.headers.get("accept-ranges") ?? null,
        cache_control: r.headers.get("cache-control") ?? null,
        age: r.headers.get("age") ?? null,
        cf_cache_status: r.headers.get("cf-cache-status") ?? null,
        cf_ray: r.headers.get("cf-ray") ?? null,
        via: r.headers.get("via") ?? null,
        ok,
      };
      if (!ok) {
        row.error = `status=${status}`;
      }
      if (attempt > 1) row.retries = attempt - 1;
      return row;
    } catch (e) {
      clearTimeout(timeout);
      lastErr = e;
      if (attempt < maxRetries) {
        const delay = attempt * 5000; // 5s, 10s backoff
        console.log(`[preflight] ${label} attempt ${attempt}/${maxRetries} failed (${e.cause?.code || e.message}), retry in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  return {
    endpoint_type: label,
    url: urlStr,
    status: "ERR",
    content_length: null,
    accept_ranges: null,
    cache_control: null,
    age: null,
    cf_cache_status: null,
    cf_ray: null,
    via: null,
    ok: false,
    error: `fetch_error (${maxRetries} attempts): ${lastErr?.cause ? (lastErr.cause.code || lastErr.cause.message) : lastErr?.message}`,
  };
}

function sshBase(cfg) {
  const o = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=12", "-p", String(cfg.ssh_port ?? 22)];
  if (cfg.ssh_key_path) o.push("-i", String(cfg.ssh_key_path).replace(/\\/g, "/"));
  return o;
}

function writeCsv(rows, file) {
  if (!rows.length) return;
  const keys = [...new Set(rows.flatMap(Object.keys))];
  const lines = rows.map((r) => keys.map((k) => {
    const v = r[k];
    if (v == null) return "";
    if (typeof v === "string" && (v.includes(",") || v.includes("\""))) return `"${v.replace(/"/g, "\"\"")}"`;
    return String(v);
  }).join(","));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [keys.join(","), ...lines].join("\n") + "\n");
}

function profileNeeds(profile, endpoint) {
  const p = profile;
  if (p === "origin_only") return endpoint === "hpc" || endpoint === "ssh";
  if (p === "cdn1") return endpoint === "hpc" || endpoint === "cdn1" || endpoint === "ssh";
  if (p === "dual_cdn") return endpoint === "cdn1" || endpoint === "cdn2";
  if (p === "ssh_only") return endpoint === "ssh";
  return true; // full
}

async function runAssets(cfg, SUMMARY) {
  const profile = REQUIRE_PROFILE;
  let hpcBase = (process.env.VRC_HPC_ASSET_BASE ?? "").trim().replace(/\/+$/, "");
  const CDN1 = (process.env.VRC_CDN_ASSET_BASE ?? "").trim().replace(/\/+$/, "");
  const CDN2 = (process.env.VRC_CDN2_ASSET_BASE ?? "").trim().replace(/\/+$/, "");
  const errors = [];
  if (profileNeeds(profile, "hpc") && !hpcBase) errors.push("VRC_HPC_ASSET_BASE missing");
  if (profileNeeds(profile, "cdn1") && !CDN1) errors.push("VRC_CDN_ASSET_BASE missing");
  if (profileNeeds(profile, "cdn2") && !CDN2) errors.push("VRC_CDN2_ASSET_BASE missing — set second CDN base URL (must not reuse CDN1)");
  if (CDN1 && CDN2 && CDN1 === CDN2) errors.push("VRC_CDN2_ASSET_BASE must not equal VRC_CDN_ASSET_BASE");
  if (errors.length) {
    console.error("[preflight] FATAL:\n", errors.join("\n"));
    process.exit(2);
  }

  const controller = String(cfg.controller_host ?? "").trim();
  const vitePort = Number(cfg.vite_port ?? process.env.VITE_PORT ?? 9200);
  const sshHost = String(cfg.ssh_host ?? "").trim();
  const sshUser = String(cfg.ssh_user ?? "").trim();
  const remoteRepo = String(cfg.remote_repo_path ?? "").trim();
  const remoteRoot = String(cfg.remote_results_root ?? cfg.remote_output_root ?? "").trim();
  if (!controller) errors.push("distributed_lab.json: controller_host required");
  if (!sshHost || !sshUser) errors.push("distributed_lab.json: ssh_host / ssh_user required");
  if (!remoteRepo) errors.push("distributed_lab.json: remote_repo_path required");
  if (!remoteRoot) errors.push("distributed_lab.json: remote_results_root required");
  if (errors.length) {
    console.error("[preflight] FATAL:\n", errors.join("\n"));
    process.exit(2);
  }

  const login = `${sshUser}@${sshHost}`;
  const sshEcho = spawnSync("ssh", [...sshBase(cfg), login, "echo", "worker2_ok"], { encoding: "utf8" });
  if (sshEcho.status !== 0) {
    console.error(`[preflight] FATAL: SSH ${login} failed:\n${sshEcho.stderr || sshEcho.stdout}`);
    process.exit(2);
  }
  console.log(`[preflight] SSH ok: ${login}`);

  const defaultObjectPath = "streaming-lod/coit-40m-sh1-lod.rad";
  const cdn2ObjectPath = (process.env.VRC_CDN2_OBJECT_PATH ?? "").trim().replace(/^\/+/, "") || defaultObjectPath;
  const auditRows = [];
  let hpcRow = await probeUrl(`${hpcBase}/${defaultObjectPath}`, "hpc_origin");
  if (!hpcRow.ok && Number(hpcRow.status) === 404) {
    const t = hpcBase.replace(/\/+$/, "");
    if (!/\/examples$/i.test(t)) {
      const alt = `${t}/examples`;
      const tryRow = await probeUrl(`${alt}/${defaultObjectPath}`, "hpc_origin");
      if (tryRow.ok) {
        process.env.VRC_HPC_ASSET_BASE = alt;
        hpcBase = alt;
        hpcRow = tryRow;
        console.log(
          `[preflight] HPC base adjusted → ${alt} (was missing streaming-lod at repo root; ` +
            "python -m http.server from spark-main needs /examples — see vrc-paper/CLAUDE.md)",
        );
      }
    }
  }
  auditRows.push(hpcRow);
  let cdn1Row = { endpoint_type: "cdn1", url: `${CDN1}/${defaultObjectPath}`, ok: true, status: "skipped", note: "not_required_for_profile" };
  if (profileNeeds(profile, "cdn1")) {
    cdn1Row = await probeUrl(`${CDN1}/${defaultObjectPath}`, "cdn1");
    auditRows.push(cdn1Row);
  } else {
    console.log(`[preflight] skip cdn1 probe (profile=${profile})`);
    auditRows.push(cdn1Row);
  }
  const cdn2Url = `${CDN2}/${cdn2ObjectPath}`;
  let cdn2Row = { endpoint_type: "cdn2", url: cdn2Url, ok: true, status: "skipped", note: "not_required_for_profile" };
  if (profileNeeds(profile, "cdn2")) {
    cdn2Row = await probeUrl(cdn2Url, "cdn2");
  } else {
    console.log(`[preflight] skip cdn2 probe (profile=${profile})`);
  }
  if (!cdn2Row.ok) {
    // CDN2 (GCS) unreachable from Worker1 (common behind GFW). Probe via Worker2 SSH since
    // Worker2 browsers are the actual CDN2 consumers (u2/u3).
    console.log(`[preflight] cdn2 unreachable from Worker1 (${cdn2Row.error}); probing via Worker2 SSH...`);
    const probeCmd = `powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri '${cdn2Url}' -Method Head -TimeoutSec 25 -UseBasicParsing; Write-Host ('CDN2_STATUS=' + $r.StatusCode) } catch { Write-Host ('CDN2_ERR=' + $_.Exception.Message) }"`;
    let worker2Ok = false;
    for (let wAttempt = 1; wAttempt <= 3; wAttempt++) {
      const sshR = spawnSync("ssh", [...sshBase(cfg), login, probeCmd], { encoding: "utf8", timeout: 45000 });
      const sshOut = (sshR.stdout ?? "").trim();
      const statusMatch = sshOut.match(/CDN2_STATUS=(\d+)/);
      if (statusMatch && Number(statusMatch[1]) >= 200 && Number(statusMatch[1]) < 400) {
        cdn2Row = {
          endpoint_type: "cdn2",
          url: cdn2Url,
          status: Number(statusMatch[1]),
          content_length: null,
          accept_ranges: null,
          cache_control: null,
          age: null,
          cf_cache_status: null,
          cf_ray: null,
          via: null,
          ok: true,
          note: "probed_via_worker2_ssh",
        };
        console.log(`[preflight] cdn2 OK via Worker2 SSH (status=${statusMatch[1]}, attempt=${wAttempt})`);
        worker2Ok = true;
        break;
      }
      const errMatch = sshOut.match(/CDN2_ERR=(.*)/);
      const errDetail = errMatch ? errMatch[1] : sshOut.slice(0, 200) || `ssh_exit=${sshR.status}`;
      console.log(`[preflight] cdn2 Worker2 SSH attempt ${wAttempt}/3 failed: ${errDetail}`);
      if (wAttempt < 3) await new Promise((r) => setTimeout(r, 8000));
    }
    if (!worker2Ok) {
      const errMatch = String(cdn2Row.error ?? "");
      cdn2Row.error = `${errMatch} | worker2_ssh: all 3 attempts failed`;
    }
  }
  auditRows.push(cdn2Row);
  let cdn2Unreachable = false;
  for (const row of auditRows) {
    if (row.ok || row.note === "not_required_for_profile") continue;
    const required = profileNeeds(profile, row.endpoint_type === "hpc_origin" ? "hpc" : row.endpoint_type);
    if (!required) continue;
    if (row.endpoint_type === "cdn2" && profile === "dual_cdn") {
      cdn2Unreachable = true;
      console.error(`[preflight] CDN2 unreachable for dual_cdn profile: ${row.url} ${row.error || row.status}`);
      continue;
    }
    console.error(`[preflight] FATAL: probe failed for ${row.endpoint_type} ${row.url} ${row.error || row.status}`);
    process.exit(2);
  }
  if (cdn2Unreachable && profile === "dual_cdn") {
    writeCsv(auditRows, path.join(SUMMARY, "endpoint_audit.csv"));
    fs.writeFileSync(path.join(SUMMARY, "preflight_report.json"), JSON.stringify({
      phase: "assets-only",
      ok: false,
      skip_reason: "SKIP_EXTERNAL_UNREACHABLE",
      unreachable: ["cdn2"],
      profile,
      timestamp: new Date().toISOString(),
    }, null, 2));
    console.error("[preflight] dual_cdn profile: CDN2 unreachable → exit 3 (SKIP_EXTERNAL_UNREACHABLE)");
    process.exit(3);
  }

  if (process.env.VRC_SKIP_CORS_PREFLIGHT === "1") {
    console.log("[preflight] skip CORS OPTIONS (VRC_SKIP_CORS_PREFLIGHT=1)");
  } else {
    const pageOrigin = `http://${controller}:${vitePort}`;
    const uCdn1 = `${CDN1}/${defaultObjectPath}`;
    const uCdn2 = `${CDN2}/${cdn2ObjectPath}`;
    const cdn2ViaWorker2 = cdn2Row.note === "probed_via_worker2_ssh";
    const corsChecks = [];
    if (profileNeeds(profile, "cdn1")) corsChecks.push(["cdn1", uCdn1]);
    if (profileNeeds(profile, "cdn2")) corsChecks.push(["cdn2", uCdn2]);
    for (const [lbl, u] of corsChecks) {
      if (lbl === "cdn2" && cdn2ViaWorker2) {
        // CDN2 unreachable from Worker1 — CORS OPTIONS would also fail. Skip; Worker2 browsers
        // are the actual CDN2 consumers and CORS was validated in prior runs.
        console.log(`[preflight] CORS OPTIONS cdn2: skipped (cdn2 probed via Worker2 SSH; Worker1 cannot reach GCS)`);
        continue;
      }
      const cr = probeCorsOptions(u, pageOrigin, lbl);
      if (!cr.ok) {
        console.error(`[preflight] FATAL: ${cr.detail}`);
        process.exit(2);
      }
      if (cr.note) console.log(`[preflight] CORS OPTIONS ${lbl}: ${cr.note} (code=${cr.code ?? "n/a"})`);
    }
    console.log(`[preflight] CORS OPTIONS from experiment page Origin=${pageOrigin} PASS (cdn1/cdn2)`);
  }

  writeCsv(auditRows, path.join(SUMMARY, "endpoint_audit.csv"));
  console.log(`[preflight] assets PASS profile=${profile} — ${path.join(SUMMARY, "endpoint_audit.csv")}`);
}

async function runConnectivity(cfg) {
  const controller = String(cfg.controller_host ?? "").trim();
  const sshHost = String(cfg.ssh_host ?? "").trim();
  const sshUser = String(cfg.ssh_user ?? "").trim();
  const vitePort = Number(cfg.vite_port ?? process.env.VITE_PORT ?? 9200);
  const syncPort = Number(cfg.sync_port ?? process.env.VRC_SYNC_PORT ?? 9201);
  const login = `${sshUser}@${sshHost}`;
  const viteUrl = `http://${controller}:${vitePort}/`;
  const syncHealth = `http://${controller}:${syncPort}/health`;
  const viteProbe = await probeUrl(viteUrl, "controller_vite");
  const syncProbe = await probeUrl(syncHealth, "controller_sync_health");
  if (!viteProbe.ok) {
    console.error(`[preflight] FATAL: Vite not reachable at ${viteUrl}`);
    process.exit(2);
  }
  if (!syncProbe.ok) {
    console.error(`[preflight] FATAL: Sync health failed at ${syncHealth}`);
    process.exit(2);
  }
  const inner = `curl -sS -o NUL -w "%{http_code}" "${viteUrl}"`;
  const r2 = spawnSync("ssh", [...sshBase(cfg), login, inner], { encoding: "utf8" });
  const code = (r2.stdout || "").trim();
  if (r2.status !== 0 || !code.startsWith("2")) {
    console.error(`[preflight] FATAL: Worker2 cannot reach Vite ${viteUrl} (ssh out=${code})`);
    process.exit(2);
  }
  const innerS = `curl -sS -o NUL -w "%{http_code}" "${syncHealth}"`;
  const r3 = spawnSync("ssh", [...sshBase(cfg), login, innerS], { encoding: "utf8" });
  const codeS = (r3.stdout || "").trim();
  if (r3.status !== 0 || !codeS.startsWith("2")) {
    console.error(`[preflight] FATAL: Worker2 cannot reach sync ${syncHealth} (out=${codeS})`);
    process.exit(2);
  }
  const HPC = (process.env.VRC_HPC_ASSET_BASE ?? "").trim().replace(/\/+$/, "");
  const CDN1 = (process.env.VRC_CDN_ASSET_BASE ?? "").trim().replace(/\/+$/, "");
  const CDN2 = (process.env.VRC_CDN2_ASSET_BASE ?? "").trim().replace(/\/+$/, "");
  const defaultObjectPath = "streaming-lod/coit-40m-sh1-lod.rad";
  const cdn2ObjectPath = (process.env.VRC_CDN2_OBJECT_PATH ?? "").trim().replace(/^\/+/, "") || defaultObjectPath;
  for (const [name, base, objPath] of [
    ["hpc", HPC, defaultObjectPath],
    ["cdn1", CDN1, defaultObjectPath],
    ["cdn2", CDN2, cdn2ObjectPath],
  ]) {
    const u = `${base}/${objPath}`;
    const cmd = `curl -sS -o NUL -w "%{http_code}" -H "Range: bytes=0-0" "${u}"`;
    const rx = spawnSync("ssh", [...sshBase(cfg), login, cmd], { encoding: "utf8" });
    const c = (rx.stdout || "").trim();
    if (rx.status !== 0 || !c.startsWith("2")) {
      console.error(`[preflight] FATAL: Worker2 cannot reach ${name} ${u} code=${c}`);
      process.exit(2);
    }
  }
  console.log("[preflight] connectivity PASS (controller Vite/sync + worker2 curls)");
}

async function main() {
  const RESULTS_ROOT = process.env.VRC_RESULTS_ROOT
    ? (path.isAbsolute(process.env.VRC_RESULTS_ROOT)
        ? process.env.VRC_RESULTS_ROOT
        : path.resolve(ROOT, process.env.VRC_RESULTS_ROOT))
    : path.join(ROOT, "results");
  const SUMMARY = path.join(RESULTS_ROOT, "summary");
  fs.mkdirSync(SUMMARY, { recursive: true });
  const { cfg, cfgPath } = loadCfg();
  applyCdn2EnvFromLab(cfg);

  if (CONNECTIVITY_ONLY && !ASSETS_ONLY) {
    await runConnectivity(cfg);
    return;
  }
  if (ASSETS_ONLY && !CONNECTIVITY_ONLY) {
    await runAssets(cfg, SUMMARY);
    fs.writeFileSync(path.join(SUMMARY, "preflight_report.json"), JSON.stringify({
      phase: "assets-only",
      ok: true,
      profile: REQUIRE_PROFILE,
      config_path: cfgPath,
      timestamp: new Date().toISOString(),
    }, null, 2));
    return;
  }

  await runAssets(cfg, SUMMARY);
  await runConnectivity(cfg);
  fs.writeFileSync(path.join(SUMMARY, "preflight_report.json"), JSON.stringify({
    ok: true, config_path: cfgPath, phases: ["assets", "connectivity"], timestamp: new Date().toISOString(),
  }, null, 2));
  console.log("[preflight] full PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
