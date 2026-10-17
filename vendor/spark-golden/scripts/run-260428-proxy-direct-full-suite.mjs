/**
 * 一键：清空旧 **260428/**（保留 README_metrics.md）→ **260428_repeat10**（proxy）→ **260428_direct_v1**（无 proxy），并写入对照清单。
 *
 * 环境变量：
 *   SKIP_CLEAR_260428=1 — 不删除 260428/ 下已有文件
 *   REPEAT10_DRY、SUITE_DURATION_MS、DIRECT_SCENARIO — 透传子套件
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const DIR_260428 = path.join(projectRoot, "260428");

function runNode(script, args, cwd, env = process.env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...args], { cwd, stdio: "inherit", env });
    p.on("error", () => resolve(1));
    p.on("exit", (c) => resolve(c ?? 1));
  });
}

async function clear260428ExceptReadme() {
  if (process.env.SKIP_CLEAR_260428 === "1" || process.env.SKIP_CLEAR_260428 === "true") {
    console.log("[260428-full] SKIP_CLEAR_260428=1，跳过清空 260428/");
    return;
  }
  if (!existsSync(DIR_260428)) return;
  const entries = await fs.readdir(DIR_260428, { withFileTypes: true }).catch(() => []);
  const keep = new Set(["README_metrics.md"]);
  for (const e of entries) {
    if (keep.has(e.name)) continue;
    const p = path.join(DIR_260428, e.name);
    await fs.rm(p, { recursive: true, force: true });
    console.log(`[260428-full] removed ${path.relative(projectRoot, p)}`);
  }
}

async function main() {
  await clear260428ExceptReadme();

  console.log("[260428-full] === 1/2 proxy arm: 260428_repeat10 ===");
  const c1 = await runNode(path.join(projectRoot, "scripts", "run-260428-repeat10-suite.mjs"), [], projectRoot, process.env);

  console.log("[260428-full] === 2/2 direct CDN arm: 260428_direct_v1 ===");
  const c2 = await runNode(path.join(projectRoot, "scripts", "run-260428-direct-v1-suite.mjs"), [], projectRoot, process.env);

  const manifest = {
    generated_at: new Date().toISOString(),
    proxy_repeat10_dir: "260428_repeat10",
    direct_no_proxy_dir: "260428_direct_v1",
    note:
      "两臂均为 **run-bcd-repeatability**（A/B/C/D × repeat10 + 同一套聚合）。proxy 臂经 **instrumented-reverse-proxy**；direct 臂设 **SPARK_DIRECT_CLIENT=1**，worker 直连 **upstream_origin**，并由 CDP 合成 proxy.jsonl。剥离的是本地反向代理 hop；上游应用与 CDN 路径仍见 metadata.direct_client。",
    exit_codes: { repeat10_proxy: c1, direct_cdn: c2 },
  };
  await fs.mkdir(DIR_260428, { recursive: true });
  await fs.writeFile(path.join(DIR_260428, "proxy_vs_direct_manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(`[260428-full] wrote ${path.relative(projectRoot, path.join(DIR_260428, "proxy_vs_direct_manifest.json"))}`);

  const code = c1 !== 0 || c2 !== 0 ? 2 : 0;
  process.exitCode = code;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
