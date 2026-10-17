/**
 * 将单次 run 的工件复制到独立目录，避免混跑后手动整理。
 * manifest.files[]: path_abs, size_bytes, missing
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const o = { root: "", runId: "", out: "" };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, vRaw] = arg.slice(2).split("=");
    const v = vRaw ?? "";
    if (k === "root") o.root = v;
    else if (k === "runId") o.runId = v;
    else if (k === "out") o.out = v;
  }
  return o;
}

async function fileSize(p) {
  const st = await fs.stat(p).catch(() => null);
  if (!st || !st.isFile()) return null;
  return st.size;
}

async function readJsonRunId(p) {
  try {
    const j = JSON.parse(await fs.readFile(p, "utf8"));
    return j.run_id != null ? String(j.run_id) : null;
  } catch {
    return null;
  }
}

async function anyClientRunId(dir, runId) {
  if (!existsSync(dir)) return false;
  const ent = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of ent) {
    if (!e.isFile() || !e.name.startsWith("client-") || !e.name.endsWith(".jsonl")) continue;
    const raw = await fs.readFile(path.join(dir, e.name), "utf8").catch(() => "");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        if (String(JSON.parse(line).run_id || "") === String(runId)) return true;
      } catch {
        /* */
      }
    }
  }
  return false;
}

async function findRunDir(root, wantId) {
  const want = String(wantId);
  const r = path.resolve(root);
  const m0 = path.join(r, "metadata.json");
  if (existsSync(m0) && (await readJsonRunId(m0)) === want) return r;
  async function walk(d, depth) {
    if (depth > 12) return null;
    const m = path.join(d, "metadata.json");
    if (existsSync(m) && (await readJsonRunId(m)) === want) return d;
    const ent = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of ent) {
      if (!e.isDirectory() || e.name === "node_modules" || e.name.startsWith(".")) continue;
      const f = await walk(path.join(d, e.name), depth + 1);
      if (f) return f;
    }
    return null;
  }
  const w = await walk(r, 0);
  if (w) return w;
  async function walk2(d, depth) {
    if (depth > 12) return null;
    if ((await anyClientRunId(path.join(d, "local"), want)) || (await anyClientRunId(path.join(d, "remote"), want))) {
      if (existsSync(path.join(d, "metadata.json")) && (await readJsonRunId(path.join(d, "metadata.json"))) === want) return d;
    }
    const ent = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of ent) {
      if (!e.isDirectory()) continue;
      const f = await walk2(path.join(d, e.name), depth + 1);
      if (f) return f;
    }
    return null;
  }
  return walk2(r, 0);
}

async function copyDirTo(src, dest) {
  if (!existsSync(src)) return;
  await fs.mkdir(dest, { recursive: true });
  const ent = await fs.readdir(src, { withFileTypes: true }).catch(() => []);
  for (const e of ent) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) await copyDirTo(from, to);
    else if (e.isFile()) await fs.copyFile(from, to);
  }
}

async function allFiles(under) {
  const out = [];
  async function w(d) {
    const ent = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of ent) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await w(p);
      else if (e.isFile()) out.push(p);
    }
  }
  if (existsSync(under)) await w(under);
  return out;
}

function pushM(files, pathAbs, missing) {
  files.push({
    path_abs: path.resolve(pathAbs),
    size_bytes: null,
    missing,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root || !args.runId || !args.out) {
    console.error("用法: --root=<...> --runId=<...> --out=<export dir>");
    process.exitCode = 1;
    return;
  }
  const runDir = await findRunDir(args.root, args.runId);
  if (!runDir) {
    console.error(`未在 ${path.resolve(args.root)} 下找到 run_id=${args.runId} 的实验目录。`);
    process.exitCode = 1;
    return;
  }

  const destRoot = path.resolve(path.join(args.out, args.runId));
  await fs.mkdir(destRoot, { recursive: true });
  const files = [];

  async function copyOne(pathRel, srcPath) {
    const absIn = path.join(destRoot, pathRel);
    const miss = !existsSync(srcPath);
    if (miss) {
      pushM(files, absIn, true);
      return;
    }
    await fs.mkdir(path.dirname(absIn), { recursive: true });
    await fs.copyFile(srcPath, absIn);
    const sz = await fileSize(absIn);
    files.push({ path_abs: path.resolve(absIn), size_bytes: sz, missing: false });
  }

  await copyOne("metadata.json", path.join(runDir, "metadata.json"));
  await copyOne("validate-run-coverage.json", path.join(runDir, "validate-run-coverage.json"));
  await copyOne("distributed-summary.json", path.join(runDir, "summary", "distributed-summary.json"));

  for (const [slot, relp] of [
    ["proxy", "proxy"],
    ["local", "local"],
    ["remote", "remote"],
  ]) {
    const from = path.join(runDir, slot);
    if (!existsSync(from)) {
      pushM(files, path.join(destRoot, relp), true);
    } else {
      await copyDirTo(from, path.join(destRoot, relp));
      for (const f of await allFiles(from)) {
        const r = path.relative(from, f).split(path.sep).join("/");
        const absOut = path.join(destRoot, relp, r);
        const sz = await fileSize(absOut);
        files.push({ path_abs: path.resolve(absOut), size_bytes: sz, missing: false });
      }
    }
  }

  const analysisDest = path.join(destRoot, "analysis");
  let analysisCount = 0;
  if (existsSync(path.join(runDir, "analysis"))) {
    await copyDirTo(path.join(runDir, "analysis"), analysisDest);
    for (const f of await allFiles(analysisDest)) {
      const sz = await fileSize(f);
      files.push({ path_abs: path.resolve(f), size_bytes: sz, missing: false });
      analysisCount += 1;
    }
  }
  const sumDir = path.join(runDir, "summary");
  if (existsSync(sumDir)) {
    for (const n of await fs.readdir(sumDir)) {
      if (n === "distributed-summary.json") continue;
      const sp = path.join(sumDir, n);
      const st = await fs.stat(sp).catch(() => null);
      if (!st || !st.isFile()) continue;
      await fs.mkdir(analysisDest, { recursive: true });
      const outP = path.join(analysisDest, n);
      await fs.copyFile(sp, outP);
      files.push({ path_abs: path.resolve(outP), size_bytes: await fileSize(outP), missing: false });
      analysisCount += 1;
    }
  }
  if (!analysisCount) {
    files.push({ path_abs: path.resolve(path.join(destRoot, "analysis")), size_bytes: null, missing: true });
  }

  const manifestPath = path.join(destRoot, "manifest.json");
  const manifest = {
    exported_at: new Date().toISOString(),
    run_id: String(args.runId),
    run_dir: runDir,
    dest_root: destRoot,
    files,
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  const mSz0 = await fileSize(manifestPath);
  manifest.files.push({ path_abs: path.resolve(manifestPath), size_bytes: mSz0, missing: false });
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  const mSz1 = await fileSize(manifestPath);
  manifest.files[manifest.files.length - 1].size_bytes = mSz1;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  console.log(`export complete: ${destRoot}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
