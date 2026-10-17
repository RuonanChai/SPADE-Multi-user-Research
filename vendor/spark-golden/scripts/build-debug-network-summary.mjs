import fs from "node:fs/promises";
import path from "node:path";
import { SCENE_EXT } from "./dist-replay-constants.mjs";

function parseArgs(argv) {
  const out = { runDir: "", runId: "", serverBase: "" };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "runDir") out.runDir = v;
    else if (k === "runId") out.runId = v;
    else if (k === "serverBase") out.serverBase = v;
  }
  return out;
}

async function readJsonl(file) {
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function isSceneByType(row) {
  const rh = row?.response_headers || {};
  const k = Object.keys(rh).find((x) => x.toLowerCase() === "content-type");
  if (!k) return false;
  const v = String(rh[k] || "").toLowerCase();
  return v.includes("octet-stream") || v.includes("binary");
}

function isDebugProbeUrl(u) {
  return typeof u === "string" && /\/debug-scene-probe\.rad(\?|$)/i.test(u);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.runDir) throw new Error("need --runDir");
  const runDir = path.resolve(args.runDir);
  const serverBase = String(args.serverBase || "").replace(/\/$/, "");

  const localDir = path.join(runDir, "local");
  const proxyFile = path.join(runDir, "proxy", "proxy.jsonl");
  const clientSummary = path.join(localDir, "client-local-summary.json");
  const entries = await fs.readdir(localDir).catch(() => []);
  const clientFiles = entries.filter((n) => n.startsWith("client-") && n.endsWith(".jsonl"));
  const clientRows = [];
  for (const f of clientFiles) {
    for (const r of await readJsonl(path.join(localDir, f))) {
      if (args.runId && String(r.run_id || "") !== String(args.runId)) continue;
      clientRows.push(r);
    }
  }
  const cdpRows = clientRows.filter((r) => !r.source || r.source === "cdp_network");
  const fetchRows = clientRows.filter((r) => r.source === "fetch_hook");
  const pRows = (await readJsonl(proxyFile)).filter((p) => !p.event || p.event === "request_complete");
  const pByRun = args.runId ? pRows.filter((p) => String(p.run_id || "") === String(args.runId)) : pRows;

  const topUrlMap = new Map();
  for (const r of cdpRows) topUrlMap.set(r.url || "", (topUrlMap.get(r.url || "") || 0) + 1);
  const top_20_urls_seen = [...topUrlMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([url, count]) => ({ url, count }));

  const all_response_content_types = [...new Set(cdpRows.map((r) => String(r.mimeType || "").trim()).filter(Boolean))];
  const all_request_headers_that_contain_range = cdpRows
    .filter((r) => r.raw_range || /range/i.test(JSON.stringify(r.request_headers || {})))
    .map((r) => ({ url: r.url || "", raw_range: r.raw_range || null, request_headers: r.request_headers || {} }));
  const all_response_headers_that_contain_content_range = cdpRows
    .filter((r) => /content-range/i.test(JSON.stringify(r.response_headers || {})))
    .map((r) => ({ url: r.url || "", response_headers: r.response_headers || {} }));

  const debug_probe_seen = cdpRows.some((r) => isDebugProbeUrl(String(r.url || "")) || r.debug_only);
  const formalRows = cdpRows.filter((r) => !isDebugProbeUrl(String(r.url || "")) && !r.debug_only);
  const bySceneUrl = formalRows.find((r) => SCENE_EXT.test(String(r.url || ""))) || null;
  const byContentType = formalRows.find((r) => isSceneByType(r)) || null;
  const byTraceMain = formalRows.find((r) => String(r.url || "").includes("/scripts/traces/generated/")) || null;
  const firstScene = bySceneUrl || byContentType || byTraceMain || null;
  const scene_match_rule = bySceneUrl
    ? "url_extension"
    : byContentType
      ? "content_type_binary"
      : byTraceMain
        ? "scene_main_resource_trace_url"
        : "none";

  const first_scene_request_url = firstScene ? String(firstScene.url || "") : null;
  const first_scene_request_ts = firstScene ? Number(firstScene.request_ts_ms || firstScene.ts || 0) || null : null;
  const firstRange = cdpRows.find((r) => String(r.raw_range || "").length > 0) || null;
  const first_range_request_ts = firstRange ? Number(firstRange.request_ts_ms || firstRange.ts || 0) || null : null;

  let traceState = {
    trace_player_started: false,
    scene_load_started: false,
    scene_load_completed: false,
    first_camera_sample_ts: null,
    first_scene_request_ts: first_scene_request_ts,
    first_range_request_ts,
  };
  try {
    const arr = JSON.parse(await fs.readFile(clientSummary, "utf8"));
    const u0 = Array.isArray(arr) && arr.length ? arr[0] : null;
    if (u0) {
      traceState = {
        ...traceState,
        trace_player_started: Boolean(u0.trace_player_started || u0.replay_start_wallclock),
        scene_load_started: Boolean(u0.scene_load_started || first_scene_request_url),
        scene_load_completed: Boolean(u0.scene_load_completed || first_scene_request_url),
        first_camera_sample_ts: u0.first_camera_sample_ts ?? null,
        first_scene_request_ts: u0.first_scene_request_ts ?? traceState.first_scene_request_ts,
        first_range_request_ts: u0.first_range_request_ts ?? traceState.first_range_request_ts,
      };
    }
  } catch {
    /* */
  }

  const summary = {
    run_id: args.runId || null,
    total_requests_seen_by_cdp: cdpRows.length,
    total_requests_seen_by_fetch_hook: fetchRows.length,
    total_requests_seen_by_proxy: pByRun.length,
    top_20_urls_seen,
    all_response_content_types,
    all_request_headers_that_contain_range,
    all_response_headers_that_contain_content_range,
    whether_any_url_matches_scene_asset: Boolean(first_scene_request_url),
    whether_any_request_has_range: Boolean(firstRange || all_request_headers_that_contain_range.length || all_response_headers_that_contain_content_range.length),
    debug_probe_seen,
    formal_scene_request_seen_excluding_probe: Boolean(first_scene_request_url),
    scene_match_rule,
    first_scene_request_url,
    first_scene_request_ts: traceState.first_scene_request_ts,
    first_range_request_ts: traceState.first_range_request_ts,
    whether_first_scene_request_goes_to_expected_server_base: first_scene_request_url
      ? String(first_scene_request_url).startsWith(serverBase)
      : false,
    trace_player_started: traceState.trace_player_started,
    scene_load_started: traceState.scene_load_started,
    scene_load_completed: traceState.scene_load_completed,
    first_camera_sample_ts: traceState.first_camera_sample_ts,
  };

  const outPath = path.join(runDir, "debug-network-summary.json");
  await fs.writeFile(outPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

