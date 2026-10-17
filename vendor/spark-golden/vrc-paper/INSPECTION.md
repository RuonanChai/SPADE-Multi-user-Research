# Spark Repository Inspection

Inspected: `D:\Program\spark-main\spark-main`  
Focus: `examples/streaming-lod` and its supporting source files  
Date: 2026-05-07

---

## Role Legend

| Role | Meaning |
|------|---------|
| **1** | 3DGS tile/chunk loading — managing, streaming, or decoding Gaussian Splatting chunk/page data |
| **2** | Camera/viewport updates — camera movement, frustum calculation, view-state management |
| **3** | Network requests — HTTP `fetch`, HTTP Range requests, or WebSocket calls to retrieve remote assets |

---

## `examples/streaming-lod/` — Files

This directory contains exactly **one file**.

| File | Lines | Role(s) | Description |
|------|-------|---------|-------------|
| `examples/streaming-lod/index.html` | 263 | **2, 3** | Single-page demo entry point. Imports `SparkRenderer`, `SplatMesh`, and `SparkControls` from the built library. Instantiates `SplatMesh` with `paged: true` (triggers streaming) and `SparkRenderer` with `pagedExtSplats: true`. Defines `MiniTracePlayer` (camera replay via SLERP/lerp, **Role 2**). In replay mode, `fetch(traceUrl)` loads a JSON trace file over the network (**Role 3**). The `selectWorld()` function sets camera pose and spawns a new `SplatMesh` per world. An `AnimationLoop` calls `tracePlayer.update()` or `controls.update(camera)` each frame. |

### Key inline class: `MiniTracePlayer` (lines 58–120, inside `index.html`)

| Responsibility | Role |
|----------------|------|
| Interpolates position (lerp) and rotation (quaternion SLERP) between recorded trace samples | **2** |
| Applies camera `position`, `quaternion`, `fov`, and calls `updateProjectionMatrix()` | **2** |
| Fetches the trace JSON file via `fetch(traceUrl, { cache: "no-store" })` when in replay mode (line 224) | **3** |

---

## Supporting Source Files (`src/`)

These files are consumed by `examples/streaming-lod/index.html` through the built `@sparkjsdev/spark` library (`dist/spark.module.js`).

| File | Lines | Role(s) | Description |
|------|-------|---------|-------------|
| `src/SplatPager.ts` | 1538 | **1, 3** | Core paging engine. `PagedSplats` class implements the `SplatSource` interface and exposes GPU texture descriptors (dyno blocks) for streamed splat data. `SplatPager` manages a pool of 64 k-splat pages with LRU eviction and GPU `DataArrayTexture` slot allocation. `driveFetchers()` (line 1242) consumes a `fetchPriority[]` queue and calls the module-level `fetchRange()` for each pending chunk. `fetchRange()` (line 1511) issues an HTTP `fetch` with a `Range: bytes=<offset>-<end>` header to retrieve exactly the needed byte slice of a `.rad` file. |
| `src/SparkRenderer.ts` | 2075 | **1, 2** | Central rendering coordinator. `onBeforeRender()` (line 711) receives the Three.js `camera` each frame and extracts `matrixWorld`, position, direction, and foveation parameters. `updateInternal()` (line 878) calls `driveLod({ visibleGenerators, camera, scene })` (line 958) to determine which LOD tree nodes are in-frustum and sets `SplatPager.fetchPriority` accordingly. Also calls `driveSort()` to offload depth-sorting to a worker. Tracks viewport pixel size and clip frustum bounds (`clipXY`). |
| `src/SplatMesh.ts` | 1317 | **1** | Three.js `Object3D` wrapper for a splat cloud. When constructed with `paged: true`, delegates to `PagedSplats` + `SplatPager` for streaming. Manages geometry, materials, bounding volumes, and modifier hooks (custom GLSL dyno blocks). `asyncInitialize()` prepares GPU buffers; `raycast()` offloads intersection tests to WASM workers. |
| `src/SplatLoader.ts` | 922 | **3** | Three.js `Loader` subclass. `load()` / `loadAsync()` fetch asset URLs via Three.js `FileLoader` (wraps `fetch`). Performs magic-number format detection (`.SPZ`, `.RAD`, `.KSPLAT`, `.PLY`) and routes binary buffers to the appropriate parser. Also manages a `WorkerPool` for background decoding. |
| `src/SplatWorker.ts` | ~120 | **1** | Main-thread RPC client for the bundled Web Worker (`worker.ts`). Dispatches messages to the worker and resolves promises on reply. Used by `SplatPager` and `SparkRenderer` to offload CPU-heavy tasks without blocking the render loop. |
| `src/worker.ts` | 898 | **1** | Web Worker implementation. Handles: `loadPackedSplats` / `loadExtSplats` (decode compressed splat chunks into raw buffers); `sortSplats32` (back-to-front index sort for transparency); `traverseLodTrees` / `updateLodTrees` (WASM-accelerated LOD tree traversal returning visible splat ranges and required chunk lists). |
| `src/controls.ts` | ~600 | **2** | `SparkControls` — keyboard (WASD/R/F), mouse, gamepad, and multi-touch input handler. Updates camera position and rotation with configurable inertia, roll spring, and pointer-roll scale. Used by `index.html` when not in trace-replay mode. |
| `src/ExtSplats.ts` | — | **1** | Extended-precision splat format (32-bit float positions). Provides `ExtSplats` data container and `evaluateExtSH()` for spherical-harmonics evaluation on ext-encoded splats. |
| `src/PackedSplats.ts` | — | **1** | Compact splat format with quantized attributes. Provides `PackedSplats` data container and `evaluatePackedSH()`. |
| `src/defines.ts` | — | — | Shared constants and TypeScript type/interface definitions (`SplatFileType`, `SplatEncoding`, `RadMeta`, texture dimensions, etc.). No runtime logic. |
| `src/shaders.ts` | — | — | GLSL shader source strings for splat rasterization. No tile loading, camera, or network logic. |
| `src/utils.ts` | — | — | General utilities: `getTextureSize`, `decompressPartialGzip`, `isMobile`, `cloneClock`, etc. |
| `src/dyno/` (directory) | — | — | Composable shader-block DSL ("dyno") for generating GLSL at runtime. Used by `PagedSplats` to build texture-sampling shader code. No tile, camera, or network logic directly. |

---

## Data-Flow Summary

```
index.html
  └─ MiniTracePlayer.update()          [Role 2] drives camera pose each frame
  └─ SplatMesh (paged: true)
       └─ PagedSplats / SplatPager     [Role 1] manages page pool & GPU textures
            └─ driveFetchers()         [Role 3] issues HTTP Range requests
                 └─ fetchRange()       [Role 3] fetch() with Range header → Uint8Array
  └─ SparkRenderer
       └─ onBeforeRender(camera)       [Role 2] extracts frustum & foveation from camera
       └─ driveLod(camera)             [Role 1] sets SplatPager.fetchPriority
       └─ driveSort()                  [Role 1] depth-sorts visible splats via worker
  └─ SparkControls (non-replay)        [Role 2] WASD/mouse → camera position/rotation
```
