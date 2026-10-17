/**
 * Direct CDN：按 run / 用户诊断资产 URL、Range、与相机轨迹（来自 traces/generated，非 CDP）。
 * 不写新「分析器」指标文件；仅生成各 run 的 summary/per_user_asset_request_sets.{json,md}。
 *
 *   node scripts/diagnose-direct-cdn-asset-requests.mjs --runRoot=<runDir>
 *   node scripts/diagnose-direct-cdn-asset-requests.mjs --matrixParent=results/distributed/direct-cdn-bcd-matrix-clean
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const ASSET_PATH_RE = /\/assets\/|\.(spz|ply|wasm|ktx2|glb|gltf|bin)(\?|$)/i;

function parseArgs(argv) {
  const o = { runRoot: "", matrixParent: "" };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "runRoot") o.runRoot = v;
    else if (k === "matrixParent") o.matrixParent = v;
  }
  return o;
}

function scenarioToTraceSubdir(scenario) {
  const s = String(scenario || "");
  if (s.startsWith("B-viewport-lockstep")) return "B-viewport-lockstep";
  if (s.startsWith("C-viewport-nearcohort")) return "C-viewport-nearcohort";
  if (s.startsWith("D-viewport-divergent")) return "D-viewport-divergent";
  if (s.startsWith("B-")) return "lockstep";
  if (s.startsWith("C-")) return "near-cohort";
  if (s.startsWith("D-")) return "divergent";
  return "lockstep";
}

function parseJsonl(raw) {
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

function isFormalRow(r) {
  if (!r) return false;
  const s = r.source;
  if (s !== "cdp_network" && s !== "fetch_hook") return false;
  if (r.debug_only) return false;
  const u = String(r.url || "");
  if (/\/debug-scene-probe\.rad(\?|$)/i.test(u)) return false;
  return true;
}

function isAssetUrl(url) {
  try {
    const p = new URL(String(url)).pathname;
    return ASSET_PATH_RE.test(p);
  } catch {
    return false;
  }
}

function normalizedAssetUrl(url) {
  try {
    const u = new URL(String(url));
    return `${u.origin.toLowerCase()}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return String(url || "");
  }
}

function rangeFromRow(r) {
  const raw = r.raw_range != null && String(r.raw_range).trim() ? String(r.raw_range).trim() : null;
  const rh = r.request_headers && typeof r.request_headers === "object" ? r.request_headers : {};
  const hdrRange = rh.Range || rh.range || null;
  return raw || (hdrRange ? String(hdrRange).trim() : null);
}

function contentRangeFromRow(r) {
  if (r.content_range != null && String(r.content_range).trim()) return String(r.content_range).trim();
  const hdrs = { ...(r.response_headers || {}), ...(r.cdn_edge_headers || {}) };
  for (const [k, v] of Object.entries(hdrs)) {
    if (String(k).toLowerCase() === "content-range" && v != null) return String(v).trim();
  }
  return null;
}

async function walkClientJsonl(runDir) {
  const out = [];
  async function walk(d) {
    const ent = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of ent) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.startsWith("client-") && e.name.endsWith(".jsonl")) out.push(p);
    }
  }
  await walk(runDir);
  return out;
}

function poseKey(sample) {
  const pos = sample?.position;
  const quat = sample?.quaternion;
  if (!Array.isArray(pos) || !Array.isArray(quat)) return null;
  const round = (x) => (Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : x);
  return JSON.stringify({ p: pos.map(round), q: quat.map(round) });
}

async function loadTracePose(projectRoot, traceSubdir, userId) {
  const fp = path.join(projectRoot, "scripts", "traces", "generated", traceSubdir, `${userId}.json`);
  const raw = await fs.readFile(fp, "utf8").catch(() => "");
  if (!raw) {
    return {
      trace_path: fp,
      loaded: false,
      first_pose: null,
      last_pose: null,
      distinct_pose_sample_count: null,
      sample_count: null,
    };
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return { trace_path: fp, loaded: false, error: "invalid_json" };
  }
  const samples = Array.isArray(j.samples) ? j.samples : [];
  const keys = new Set();
  for (const s of samples) {
    const k = poseKey(s);
    if (k) keys.add(k);
  }
  const first = samples[0] || null;
  const last = samples.length ? samples[samples.length - 1] : null;
  return {
    trace_path: fp,
    loaded: true,
    first_pose: first ? { t_ms: first.t_ms, position: first.position, quaternion: first.quaternion, fov: first.fov } : null,
    last_pose: last ? { t_ms: last.t_ms, position: last.position, quaternion: last.quaternion, fov: last.fov } : null,
    distinct_pose_sample_count: keys.size,
    sample_count: samples.length,
  };
}

async function readClientSummaries(runDir) {
  const out = [];
  async function walk(d) {
    const ent = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of ent) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && /client-.*summary\.json$/i.test(e.name)) {
        const raw = await fs.readFile(p, "utf8").catch(() => "[]");
        try {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) for (const row of arr) out.push({ ...row, _summary_file: path.relative(runDir, p) });
        } catch {
          /* */
        }
      }
    }
  }
  await walk(runDir);
  return out;
}

async function analyzeRun(runDirAbs, projectRoot) {
  const meta = JSON.parse(await fs.readFile(path.join(runDirAbs, "metadata.json"), "utf8").catch(() => "{}"));
  const scenario = String(meta.scenario || "unknown");
  const traceSubdir = scenarioToTraceSubdir(scenario);

  const files = await walkClientJsonl(runDirAbs);
  const byUser = new Map();

  for (const fp of files) {
    const raw = await fs.readFile(fp, "utf8").catch(() => "");
    for (const r of parseJsonl(raw)) {
      if (!isFormalRow(r)) continue;
      const uid = String(r.user_id || "");
      if (!uid) continue;
      if (!byUser.has(uid)) {
        byUser.set(uid, {
          user_id: uid,
          rows: [],
        });
      }
      byUser.get(uid).rows.push(r);
    }
  }

  const butterflyCanon = "https://sparkjs.dev/assets/splats/butterfly.spz";
  const butterflyNorm = normalizedAssetUrl(butterflyCanon);
  const perUser = [];
  const allSpzRanges = new Set();
  let allSameButterfly = true;

  for (const uid of [...byUser.keys()].sort()) {
    const { rows } = byUser.get(uid);
    const assetRows = rows.filter((r) => isAssetUrl(r.url));
    const uniqueAssetUrls = [...new Set(assetRows.map((r) => normalizedAssetUrl(r.url)))].sort();
    const spzRows = rows.filter((r) => /\.spz(\?|$)/i.test(String(r.url || "")));
    const uniqueSpzUrls = [...new Set(spzRows.map((r) => normalizedAssetUrl(r.url)))].sort();
    const spzRanges = [
      ...new Set(
        spzRows
          .map((r) => rangeFromRow(r))
          .filter(Boolean)
          .map(String),
      ),
    ];
    for (const rg of spzRanges) allSpzRanges.add(rg);
    for (const u of uniqueSpzUrls) {
      if (u !== butterflyNorm) allSameButterfly = false;
    }
    for (const row of spzRows) {
      if (normalizedAssetUrl(row.url) !== butterflyNorm) allSameButterfly = false;
    }
    const spzDetail = spzRows.map((r) => ({
      url: normalizedAssetUrl(r.url),
      range_request: rangeFromRow(r),
      content_range_response: contentRangeFromRow(r),
    }));

    const pose = await loadTracePose(projectRoot, traceSubdir, uid);

    perUser.push({
      scenario,
      user_id: uid,
      unique_asset_urls: uniqueAssetUrls,
      unique_asset_url_count: uniqueAssetUrls.length,
      spz_request_count: spzRows.length,
      spz_unique_url_count: uniqueSpzUrls.length,
      spz_unique_range_values: spzRanges,
      spz_requests_detail: spzDetail,
      trace_pose: pose,
      client_summary_hits: (await readClientSummaries(runDirAbs)).filter((s) => s.user_id === uid),
    });
  }

  const rangeVariesAcrossUsers = allSpzRanges.size > 1;

  const poseFirstSigs = perUser.map((p) => {
    const fp = p.trace_pose?.first_pose;
    if (!fp) return null;
    return JSON.stringify({ pos: fp.position, quat: fp.quaternion });
  });
  const pose_differs_across_users_in_run = new Set(poseFirstSigs.filter(Boolean)).size > 1;

  let conclusion_en =
    "Inspect per_user_asset_request_sets.json for URL and Range details relative to traces.";
  if (rangeVariesAcrossUsers) {
    conclusion_en =
      "Range requests differ across users or requests; object deduplication should include the byte range (see analyze-direct-cdn-delivery object_key).";
  } else if (allSameButterfly && pose_differs_across_users_in_run) {
    conclusion_en =
      "Camera pose affects local rendering only. It does not currently drive network object selection.";
  } else if (allSameButterfly) {
    conclusion_en =
      "All formal .spz requests use the same URL and the same Range; repeated_object_request_ratio is dominated by the shared page load graph and fixed probe, not camera-driven URL changes.";
  }

  return {
    run_root: runDirAbs,
    scenario,
    trace_subdir: traceSubdir,
    all_users_request_same_butterfly_url: allSameButterfly,
    range_request_differs_across_users: rangeVariesAcrossUsers,
    distinct_range_values_all_users_spz: [...allSpzRanges].sort(),
    pose_differs_across_users_in_run,
    per_user: perUser,
    conclusion_en,
  };
}

async function discoverMatrixRuns(matrixParentAbs) {
  const ent = await fs.readdir(matrixParentAbs, { withFileTypes: true }).catch(() => []);
  const runs = [];
  for (const e of ent) {
    if (!e.isDirectory()) continue;
    const p = path.join(matrixParentAbs, e.name);
    const metaPath = path.join(p, "metadata.json");
    const st = await fs.stat(metaPath).catch(() => null);
    if (st?.isFile()) runs.push(p);
  }
  return runs.sort();
}

function firstPoseSig(poseBlock) {
  if (!poseBlock?.loaded || !poseBlock.first_pose) return null;
  const f = poseBlock.first_pose;
  return JSON.stringify({ pos: f.position, quat: f.quaternion });
}

async function crossScenarioPoseSummary(projectRoot, runAnalyses) {
  /** 每个场景取一场 rep，比较 user0 轨迹首姿态 */
  const byScen = new Map();
  for (const ra of runAnalyses) {
    const s = ra.scenario;
    if (!byScen.has(s)) byScen.set(s, ra);
  }
  const sigs = {};
  for (const [scen, ra] of byScen) {
    const u0 = ra.per_user.find((p) => p.user_id === "user0");
    sigs[scen] = u0 ? firstPoseSig(u0.trace_pose) : null;
  }
  const values = Object.values(sigs).filter(Boolean);
  const distinct = new Set(values);
  return {
    first_pose_signature_by_scenario_user0: sigs,
    pose_differs_across_B_C_D: distinct.size > 1,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.runRoot && !args.matrixParent) {
    console.error("需要 --runRoot= 或 --matrixParent=");
    process.exitCode = 1;
    return;
  }

  const runRoots = args.runRoot
    ? [path.resolve(projectRoot, args.runRoot)]
    : await discoverMatrixRuns(path.resolve(projectRoot, args.matrixParent));

  const allAnalyses = [];
  for (const runDirAbs of runRoots) {
    const one = await analyzeRun(runDirAbs, projectRoot);
    allAnalyses.push(one);
    const summaryDir = path.join(runDirAbs, "summary");
    await fs.mkdir(summaryDir, { recursive: true });
    const jsonOut = path.join(summaryDir, "per_user_asset_request_sets.json");
    const mdOut = path.join(summaryDir, "per_user_asset_request_sets.md");
    await fs.writeFile(jsonOut, `${JSON.stringify(one, null, 2)}\n`, "utf8");

    const md = [
      `# 每用户资产请求集（${one.scenario}）`,
      "",
      `- **run_root**: \`${one.run_root}\``,
      `- **all_users_same_butterfly.spz (normalized)**: ${one.all_users_request_same_butterfly_url}`,
      `- **Range 在 .spz 上是否因用户而异**: ${one.range_request_differs_across_users}（取值集合: \`${JSON.stringify(one.distinct_range_values_all_users_spz)}\`）`,
      "",
      "## 结论（本 run）",
      "",
      one.conclusion_en,
      "",
      "## 每用户",
      "",
      ...one.per_user.map((p) => {
        const tp = p.trace_pose;
        const poseLine = tp?.loaded
          ? `轨迹样本数=${tp.sample_count}，不同姿态数=${tp.distinct_pose_sample_count}；首姿态 position=${JSON.stringify(tp.first_pose?.position)}`
          : `无轨迹文件或加载失败: \`${tp?.trace_path || ""}\``;
        return [
          `### ${p.user_id}`,
          "",
          `- **unique_asset_url_count**: ${p.unique_asset_url_count}`,
          `- **.spz request count**: ${p.spz_request_count}`,
          `- **.spz unique URL count**: ${p.spz_unique_url_count}`,
          `- **.spz Range 取值**: ${p.spz_unique_range_values.join(", ") || "—"}`,
          `- **相机轨迹（generated trace，非浏览器 CDP）**: ${poseLine}`,
          "",
          "**unique_asset_urls**",
          "",
          ...p.unique_asset_urls.map((u) => `- \`${u}\``),
          "",
          "**spz 逐条（Range / Content-Range）**",
          "",
          ...p.spz_requests_detail.map(
            (d) =>
              `- \`${d.url}\`  Range=\`${d.range_request ?? "—"}\`  Content-Range=\`${d.content_range_response ?? "—"}\``,
          ),
          "",
        ].join("\n");
      }),
      "",
    ].join("\n");
    await fs.writeFile(mdOut, md, "utf8");
    console.log(`Wrote ${jsonOut}`);
  }

  const poseCross = await crossScenarioPoseSummary(projectRoot, allAnalyses);
  const networkSame =
    allAnalyses.every((a) => a.all_users_request_same_butterfly_url) && !allAnalyses.some((a) => a.range_request_differs_across_users);

  const poseDiffers = poseCross.pose_differs_across_B_C_D;
  const matrixConclusion =
    poseDiffers && networkSame
      ? "Camera pose affects local rendering only. It does not currently drive network object selection."
      : poseDiffers && !networkSame
        ? "Camera pose differs across scenarios and network ranges or URLs also differ; inspect per_user tables."
        : !poseDiffers && networkSame
          ? "Traces do not differ in first-pose signature (user0) across sampled scenarios, and network asset URLs/ranges align; repeated_object_request_ratio sameness is dominated by identical page graph + fixed probe."
          : "See per-run JSON for mixed signals.";

  const aggregate = {
    generated_at: new Date().toISOString(),
    runs_analyzed: runRoots.length,
    cross_scenario_trace_pose_user0: poseCross,
    conclusion_en: matrixConclusion,
    note:
      "CDP 行不含逐帧相机；`client-*-summary.json` 中的 camera 字段在部分 run 可能为空。此处「相机」以 scripts/traces/generated 下的轨迹为准。",
  };

  if (args.matrixParent) {
    const parentAbs = path.resolve(projectRoot, args.matrixParent);
    const sd = path.join(parentAbs, "summary");
    await fs.mkdir(sd, { recursive: true });
    const aggPath = path.join(sd, "matrix_camera_pose_vs_network.json");
    await fs.writeFile(aggPath, `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");
    const aggMd = [
      "# B/C/D 相机轨迹 vs 网络资产（矩阵汇总）",
      "",
      `生成：${aggregate.generated_at}`,
      "",
      "## 跨场景 user0 首姿态签名",
      "",
      "```json",
      JSON.stringify(poseCross.first_pose_signature_by_scenario_user0, null, 2),
      "```",
      "",
      `- **pose_differs_across_B_C_D**（基于 user0 首姿态 JSON）: **${poseCross.pose_differs_across_B_C_D}**`,
      "",
      "## 结论（英文，便于论文摘句）",
      "",
      conclusion,
      "",
      aggregate.note,
      "",
    ].join("\n");
    await fs.writeFile(path.join(sd, "matrix_camera_pose_vs_network.md"), aggMd, "utf8");
    console.log(`Wrote ${aggPath}`);
  }

  const printConclusion = args.matrixParent ? matrixConclusion : allAnalyses[0]?.conclusion_en || matrixConclusion;
  console.log("\n--- conclusion ---\n" + printConclusion);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
