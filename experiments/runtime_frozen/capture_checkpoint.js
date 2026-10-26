"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function crc32(buffer) {
  let value = -1;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (~value) >>> 0;
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    raw[start] = 0;
    rgba.copy(raw, start + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function expectedBuffer(cssWidth, cssHeight, dpr) {
  return { width: Math.round(cssWidth * dpr), height: Math.round(cssHeight * dpr) };
}

function poseHash(pose) {
  return crypto.createHash("sha256").update(JSON.stringify({
    position: pose && pose.position,
    quaternion: pose && pose.quaternion,
    projection: pose && pose.projection,
    buffer_width: pose && pose.buffer_width,
    buffer_height: pose && pose.buffer_height,
  })).digest("hex");
}

const lastFrame = new Map();

function classifyStale(clientId, pose, pngHash) {
  const previous = lastFrame.get(clientId) || null;
  const currentPose = poseHash(pose || {});
  const stale = Boolean(previous && previous.pose !== currentPose && previous.png === pngHash);
  lastFrame.set(clientId, { pose: currentPose, png: pngHash });
  return { pose_sha256: currentPose, stale_frame: stale };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

async function installCaptureHook(page) {
  return page.evaluate(() => {
    if (window.__spadeHookInstalled) return true;
    const renderer = window.__spark && window.__spark.renderer;
    if (!renderer || typeof renderer.render !== "function" || typeof renderer.getContext !== "function") return false;
    const original = renderer.render.bind(renderer);
    window.__spadeReadFrame = (camera) => {
      const canvas = document.getElementById("canvas") || document.querySelector("canvas");
      const gl = renderer.getContext();
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const flipped = new Uint8Array(pixels.length);
      const rowBytes = width * 4;
      for (let y = 0; y < height; y += 1) {
        flipped.set(pixels.subarray((height - 1 - y) * rowBytes, (height - y) * rowBytes), y * rowBytes);
      }
      let lit = 0;
      let seen = 0;
      for (let index = 0; index < flipped.length; index += 64) {
        seen += 1;
        if (flipped[index] > 8 || flipped[index + 1] > 8 || flipped[index + 2] > 8) lit += 1;
      }
      const litFraction = seen ? lit / seen : 0;
      if (litFraction < 0.002) {
        return { lit_fraction: litFraction, too_dark: true, width, height, capture_frame_seq: window.__spadeFrameSeq };
      }
      let binary = "";
      const step = 8192;
      for (let index = 0; index < flipped.length; index += step) {
        binary += String.fromCharCode.apply(null, flipped.subarray(index, index + step));
      }
      return {
        png_base64: btoa(binary),
        lit_fraction: litFraction,
        width,
        height,
        capture_frame_seq: window.__spadeFrameSeq,
        pose: {
          position: camera && camera.position && camera.position.toArray ? camera.position.toArray() : null,
          quaternion: camera && camera.quaternion && camera.quaternion.toArray ? camera.quaternion.toArray() : null,
          fov: camera ? camera.fov : null,
          matrix_world: camera && camera.matrixWorld ? Array.from(camera.matrixWorld.elements) : null,
          projection: camera && camera.projectionMatrix ? Array.from(camera.projectionMatrix.elements) : null,
          visible_splats: window.__spark && typeof window.__spark.activeSplats === "number" ? window.__spark.activeSplats : (window.__visibleSplats ?? null),
          dpr: window.devicePixelRatio,
          css_width: canvas ? canvas.clientWidth : 0,
          css_height: canvas ? canvas.clientHeight : 0,
          buffer_width: width,
          buffer_height: height,
          canvas_width: canvas ? canvas.width : 0,
          canvas_height: canvas ? canvas.height : 0,
        },
      };
    };
    renderer.render = function renderWithCapture(scene, camera) {
      const hold = window.__spadeHoldPose;
      if (hold && camera && camera.position && camera.position.set) {
        camera.position.set(hold.position[0], hold.position[1], hold.position[2]);
        if (camera.quaternion && camera.quaternion.set && hold.quaternion) {
          camera.quaternion.set(hold.quaternion[0], hold.quaternion[1], hold.quaternion[2], hold.quaternion[3]);
        }
        if (typeof hold.fov === "number") {
          camera.fov = hold.fov;
          if (camera.updateProjectionMatrix) camera.updateProjectionMatrix();
        }
        if (camera.updateMatrixWorld) camera.updateMatrixWorld(true);
      }
      const result = original(scene, camera);
      window.__spadeFrameSeq = (window.__spadeFrameSeq || 0) + 1;
      if (hold) window.__spadeHoldDraws = (window.__spadeHoldDraws || 0) + 1;
      const job = window.__spadeCaptureJob;
      if (job && !job.filled) {
        const view = window.__slDiagCam;
        if (view && camera !== view) return result;
        let frame = null;
        try { frame = window.__spadeReadFrame(view || camera); } catch (error) {
          job.filled = true;
          job.frame = { error: String(error && error.message || error) };
          return result;
        }
        if (!frame || frame.too_dark || !(frame.lit_fraction >= 0.002)) return result;
        job.filled = true;
        job.frame = frame;
      }
      return result;
    };
    window.__spadeHookInstalled = true;
    return true;
  });
}

async function holdPose(page, pose) {
  await installCaptureHook(page);
  await page.evaluate((target) => {
    window.__spadeHoldPose = target;
    window.__spadeHoldDraws = 0;
  }, pose);
}

async function waitHoldDraws(page, count, timeoutMs) {
  return page.evaluate((request) => new Promise((resolve) => {
    const needed = request.count;
    const timeout = request.timeoutMs;
    const started = Date.now();
    const timer = setInterval(() => {
      if ((window.__spadeHoldDraws || 0) >= needed) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        resolve(false);
      }
    }, 30);
  }), { count, timeoutMs });
}

async function probeReference(page) {
  return page.evaluate(async () => {
    const paged = window.__world && window.__world.paged;
    let fileChunkCount = null;
    try {
      const resolved = paged && paged.radMetaPromise ? await paged.radMetaPromise : null;
      const chunks = resolved && resolved.meta && resolved.meta.chunks;
      fileChunkCount = Array.isArray(chunks) ? chunks.length : null;
    } catch (_) {
      fileChunkCount = null;
    }
    const pager = window.__spark && window.__spark.pager;
    const rows = pager && Array.isArray(pager.fetchPriority) ? pager.fetchPriority.filter((row) => !paged || row.splats === paged) : [];
    let resident = 0;
    let pending = 0;
    for (const row of rows) {
      const hasPage = pager && typeof pager.getSplatsChunk === "function" ? !!pager.getSplatsChunk(row.splats, row.chunk) : false;
      const fetching = (pager.fetchers || []).some((item) => item && item.splats === row.splats && item.chunk === row.chunk);
      const queued = (pager.fetched || []).some((item) => item && item.splats === row.splats && item.chunk === row.chunk);
      if (hasPage) resident += 1;
      else if (!fetching && !queued) pending += 1;
    }
    const activeFetchers = pager && Array.isArray(pager.fetchers) ? pager.fetchers.length : null;
    const visible = window.__spark && typeof window.__spark.activeSplats === "number" ? window.__spark.activeSplats : null;
    const proven = fileChunkCount > 0 && rows.length > 0 && resident === rows.length && pending === 0 && activeFetchers === 0 && visible > 0;
    return {
      status: proven ? "FULL_VIEW_REFERENCE_PROVEN" : "NO_VALID_REFERENCE",
      full_file_proven: false,
      full_resource: false,
      file_chunk_count: fileChunkCount,
      demanded_chunk_count: rows.length,
      resident_demanded_count: resident,
      pending_demand_count: pending,
      active_fetchers: activeFetchers,
      visible_splats: visible,
      reason: proven ? null : "NO_VALID_REFERENCE",
    };
  });
}

async function captureCheckpoint(page, cdp, destDir, spec) {
  const stem = spec.file_stem || `canvas_t${spec.checkpoint_s}`;
  const started = Date.now();
  const deadline = spec.deadline_ms || (started + (spec.timeout_ms || 800));
  const row = {
    checkpoint_s: spec.checkpoint_s,
    file: `${stem}.png`,
    meta: `${stem}.json`,
    ok: false,
    method: "webgl_readpixels_after_render",
    hud_hidden: true,
    client_id: spec.client_id || null,
    trace_origin_ms: spec.trace_origin_ms || null,
    measurement_origin_ms: spec.measurement_origin_ms || null,
  };
  const finish = (extra) => {
    Object.assign(row, extra, { capture_ms: Date.now() - started });
    writeJson(path.join(destDir, row.meta), row);
    return row;
  };
  if (Date.now() > deadline) return finish({ error: "MISSED_CHECKPOINT" });
  const installed = await installCaptureHook(page);
  if (!installed) return finish({ error: "CAPTURE_HOOK_MISSING" });
  const frame = await page.evaluate((deadlineMs) => new Promise((resolve) => {
    window.__spadeCaptureJob = { filled: false, frame: null };
    const timer = setInterval(() => {
      const job = window.__spadeCaptureJob;
      if (job && job.filled) {
        clearInterval(timer);
        resolve(job.frame);
      } else if (Date.now() > deadlineMs) {
        clearInterval(timer);
        window.__spadeCaptureJob = null;
        resolve({ error: "MISSED_CHECKPOINT" });
      }
    }, 20);
  }), deadline);
  if (!frame || frame.error || !frame.png_base64) return finish({ error: frame && frame.error || "READPIXELS_FAILED", pose: frame && frame.pose || null, pose_saved: !!(frame && frame.pose) });
  const rgba = Buffer.from(frame.png_base64, "base64");
  if (rgba.length !== frame.width * frame.height * 4) return finish({ error: "PNG_BUFFER_MISMATCH", pose: frame.pose, pose_saved: true });
  const png = encodePng(frame.width, frame.height, rgba);
  const size = pngSize(png);
  fs.writeFileSync(path.join(destDir, row.file), png);
  const sha = crypto.createHash("sha256").update(png).digest("hex");
  const stale = classifyStale(spec.client_id || "default", frame.pose, sha);
  return finish({
    ok: !stale.stale_frame,
    error: stale.stale_frame ? "STALE_FRAME" : null,
    pose: frame.pose,
    pose_saved: true,
    bytes: png.length,
    sha256: sha,
    lit_fraction: Number.isFinite(frame.lit_fraction) ? frame.lit_fraction : null,
    width: size.width,
    height: size.height,
    capture_frame_seq: frame.capture_frame_seq,
    pose_sha256: stale.pose_sha256,
    stale_frame: stale.stale_frame,
    trace_relative_s: spec.trace_origin_ms ? (Date.now() - spec.trace_origin_ms) / 1000 : null,
    measurement_relative_s: spec.measurement_origin_ms ? (Date.now() - spec.measurement_origin_ms) / 1000 : null,
  });
}

module.exports = {
  captureCheckpoint, installCaptureHook, holdPose, waitHoldDraws, probeReference,
  encodePng, pngSize, expectedBuffer, classifyStale,
};
