# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**VRC / multi-agent long runs:** Read **`.claude/主智能体提示词.md`** then **`vrc-paper/CLAUDE.md`** §「Autonomous pipeline: Canary → Full 72」+ §「Unattended agent mode」; Full 72 gates in **`vrc-paper/VRC_MASTER_AUTORUN.md`**. Auto-Advance + Unattended mandatory.

**READY single-user:** Read **`.claude/READY主智能体提示词.md`** + skill **`ready-single-user-readiness`** + **`PHASE_GATE_RUNBOOK.md`** §2.1 & §9–§10. Remote: mini uses **`remote_infra_gate`** only; **`remote_claim_gate`** is for paper claims (n≥5). Do not block mini→main on n=1 claim RED.

## Caveman Mode Rule
Only output core results. Zero pleasantries. Zero explanations unless asked. Technical content complete but minimal.

## Commands

```bash
# Install dependencies (run after wasm is built)
npm install

# Build wasm crates (required before first npm install / after Rust changes)
npm run build:wasm

# Full build (production + dev bundles)
npm run build

# Dev server at http://localhost:8080/
npm start

# Watch mode (rebuilds JS on src changes, no wasm)
npm run build:watch

# Lint
npm run lint

# Lint with autofix
npm run lint:fix

# Format
npm run format:fix

# Tests
node --no-warnings --loader ts-node/esm --test test/**/*.test.ts

# Clean everything (dist, node_modules, rust targets, wasm pkgs)
npm run clean

# Download splat example assets locally (optional; examples work without this via CDN)
npm run assets:download

# Compress a splat file to .spz
npm run assets:compress <file-or-url>
```

## Build System Architecture

Two-phase build:

1. **Rust → WASM** (`npm run build:wasm`): Runs `rust/build_rust_wasm.ps1` (Windows) or `rust/build_rust_wasm.sh`. Compiles `rust/spark-worker-rs` and `rust/spark-rs` via `wasm-pack` with SIMD flags (`+simd128,+bulk-memory`). Output goes to `rust/spark-worker-rs/pkg/` and `rust/spark-rs/pkg/` — these are referenced in `package.json` as `file:` local packages. **Must be built before `npm install` can resolve them.**

2. **TypeScript → JS** (`npm run build`): Vite library build with entry `src/index.ts`. Produces 4 bundles in `dist/`: `spark.module[.min].js` (ESM) and `spark.cjs[.min].js` (CJS). TypeScript declarations go to `dist/types/`. `three` is external (not bundled). GLSL files are inlined as strings via `vite-plugin-glsl`.

`npm start` = `npm run dev` = build dev bundle + start Vite dev server with file watcher.

The `sparkLocalAssets` global is set at build time: `true` if `examples/assets/` exists locally, `false` if assets should be fetched from `https://sparkjs.dev/assets/`.

## Code Architecture

### Library Core (`src/`)

**Rendering pipeline:**
- `SparkRenderer.ts` — integrates with `THREE.WebGLRenderer`; owns `SplatGeometry`, manages workers and LoD
- `SplatMesh.ts` — `THREE.Mesh` subclass; the primary user-facing object
- `SplatAccumulator.ts` — collects outputs from `SplatGenerator` instances into GPU geometry
- `SplatGeometry.ts` — GPU-side splat storage (textures, attributes)
- `SplatPager.ts` — LoD paging; streams in/out splat tiles based on camera distance

**Worker architecture:**
- `SplatWorker.ts` — main-thread proxy; spawns `worker.ts` as an inline bundled Web Worker
- `worker.ts` — handles async sorting, loading, and LoD computation
- The worker communicates via transferable `SharedArrayBuffer` / `Transferable` objects

**Dyno shader system (`src/dyno/`):**
A composable GLSL code-generation graph. Each `Dyno<T>` node represents a typed GLSL value or operation. `program.ts` assembles nodes into a `Compilation` which emits final shader strings. This is how splat color/transform effects are built at runtime without string concatenation.

**File format I/O:**
- `SplatLoader.ts` dispatches to format readers: `ply.ts`, `spz.ts`, `ksplat.ts`, `antisplat.ts`, `pcsogs.ts`
- `PackedSplats.ts` is the canonical in-memory representation shared between formats and the renderer
- `spz.ts` uses the `spark-rs` WASM crate for decoding

**Rust crates:**
- `spark-lib` — pure Rust: splat math, file I/O, HNSW indexing (not compiled to WASM)
- `spark-rs` — WASM bindings for main-thread (used by `spz.ts` for SPZ decode)
- `spark-worker-rs` — WASM bindings for worker thread (sort, LoD computation)
- `build-lod` — native CLI for offline LOD generation using `wgpu`

### Tooling
- **Linter/formatter**: Biome (not ESLint/Prettier). Double quotes, LF line endings, spaces.
- **Tests**: Node built-in `--test` runner + `ts-node` ESM loader. Only `test/utils.test.ts` exists.
- **CI**: GitHub Actions — `ci-windows.yaml` and `ci-linux.yml` run the full build on both platforms.

### Examples (`examples/`)
Each subdirectory is a standalone HTML demo importing spark from `dist/` or via CDN. They share vendor JS from `examples/js/` (symlinked to `node_modules/` during dev server). Asset manifest at `examples/assets.json`.

## Local Splat Assets

**No local splat files are present by default.** Run `npm run assets:download` to populate `examples/assets/`. Until then, examples fetch splats from `https://sparkjs.dev/assets/` at runtime (requires internet).

To check if assets are present:
```bash
ls examples/assets/ 2>/dev/null || echo "No local assets"
```
## Dual-machine dual-CDN execution rule

For dual-CDN distributed experiments, do not stop after reporting missing CDN2 until both sources have been checked:
1. environment variable VRC_CDN2_ASSET_BASE
2. experiments/distributed_lab.json field cdn2_asset_base

If env is missing but lab JSON has cdn2_asset_base, export it into env and continue.

Remote Worker2 commands must use Ruonan@10.4.146.68. Do not use default Windows username. Remote PowerShell commands must use EncodedCommand or copied .ps1 scripts to avoid broken quoting.

A run is invalid if all users run on Worker1. Never fallback to local 4-Chrome mode. If Worker2 SSH is not non-interactive, stop and report SSH key/passwordless setup required.