/**
 * Direct CDN + streaming-lod：B/C/D 矩阵（--directCdnStreamingLod=1）。
 * 依赖 distributed-replay.config.json；相机 trace 由 replay-worker 内联注入。
 *
 *   node scripts/run-direct-cdn-streaming-lod-bcd-matrix.mjs [--phase=smoke|formal] [--parentOut=...]
 *   smoke: repeats=1 durationMs=60000
 *   formal: repeats=3 durationMs=120000
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const o = { phase: "formal", parentOut: "", durationMs: null };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "phase") o.phase = (v || "formal").toLowerCase();
    else if (k === "parentOut" || k === "outParent") o.parentOut = v || "";
    else if (k === "durationMs") {
      const n = Number.parseInt(v || "", 10);
      o.durationMs = Number.isFinite(n) && n > 0 ? n : null;
    }
  }
  return o;
}

function runDistributedReplay(args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(projectRoot, "scripts", "run-distributed-replay.mjs"), ...args], {
      cwd: projectRoot,
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    p.on("error", reject);
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`run-distributed-replay exit ${c}`))));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const smoke = opts.phase === "smoke";
  const repeats = smoke ? 1 : 3;
  const durationMs =
    opts.durationMs != null ? opts.durationMs : smoke ? 60_000 : 120_000;
  const ts = Date.now();
  const parent =
    opts.parentOut ||
    path.join(projectRoot, "260506_v4_multi-users", smoke ? `streaming-lod-bcd-smoke-${ts}` : `streaming-lod-bcd-formal-${ts}`);
  await fs.mkdir(parent, { recursive: true });

  const scenarios = [
    { scenario: "B-lockstep", label: "B-lockstep" },
    { scenario: "C-nearcohort", label: "C-nearcohort" },
    { scenario: "D-divergent", label: "D-divergent" },
  ];

  const manifest = {
    generated_at: new Date().toISOString(),
    parent_out: parent,
    phase: smoke ? "smoke" : "formal",
    repeats,
    duration_ms: durationMs,
    direct_cdn_streaming_lod: true,
    runs: /** @type {object[]} */ ([]),
  };

  for (const { scenario, label } of scenarios) {
    for (let i = 1; i <= repeats; i++) {
      const outRoot = path.join(parent, `${label}-rep${i}-${Date.now()}`);
      const row = { scenario, repeat: i, out_root: outRoot, ok: false, error: null };
      manifest.runs.push(row);
      await fs.writeFile(path.join(parent, "streaming-lod-matrix-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      console.log(`\n>>> streaming-lod matrix: ${scenario} rep ${i}/${repeats} -> ${outRoot}\n`);
      try {
        await runDistributedReplay(
          [
            `--scenario=${scenario}`,
            "--distributed=0",
            "--directCdn=1",
            "--directCdnStreamingLod=1",
            `--durationMs=${durationMs}`,
            `--outRoot=${outRoot}`,
          ],
          { SPARK_DIRECT_CDN: "1", SPARK_DIRECT_CDN_STREAMING_LOD: "1" },
        );
        row.ok = true;
      } catch (e) {
        row.ok = false;
        row.error = String(e?.message || e);
        console.error(e);
        process.exitCode = 2;
      }
      await fs.writeFile(path.join(parent, "streaming-lod-matrix-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }
  }

  const md = [
    "# streaming-lod Direct CDN B/C/D 矩阵",
    "",
    `- **phase**: ${manifest.phase}`,
    `- **repeats / durationMs**: ${repeats} / ${durationMs}`,
    "",
    "## 允许表述",
    "",
    "- Spark hello-world（butterfly.spz）不体现相机驱动的不同网络对象请求。",
    "- Spark streaming-lod 可体现与相机相关的 HTTP Range / 资源 URL 请求模式。",
    "- 多用户 streaming-lod 可用于研究场景相关的 **Range 对象重叠** 与直连 **请求级时延**。",
    "",
    "## 禁止表述",
    "",
    "- GPU 或渲染性能提升。",
    "- 缺少 CF-Cache-Status 时推断 Cloudflare 缓存命中/未命中。",
    "- 代理共享增益（本模式为直连）。",
    "",
    "| scenario | rep | out_root | ok |",
    "|---|---:|---|---|",
    ...manifest.runs.map((r) => `| ${r.scenario} | ${r.repeat} | \`${path.relative(projectRoot, r.out_root)}\` | ${r.ok ? "yes" : "no"} |`),
    "",
    "各 run：`summary/streaming_lod_range_overlap.{json,md}`、`summary/direct_cdn_delivery.{json,md}`、`validate-direct-cdn-run.json`。",
    "",
  ].join("\n");
  await fs.writeFile(path.join(parent, "STREAMING_LOD_BCD_MATRIX.md"), md, "utf8");
  console.log(`\n[matrix] ${path.join(parent, "STREAMING_LOD_BCD_MATRIX.md")}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
