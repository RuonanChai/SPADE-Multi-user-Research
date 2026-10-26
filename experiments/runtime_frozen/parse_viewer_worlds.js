"use strict";

const fs = require("fs");

const VIEWER_HTML = "D:\\Program\\SPADE\\NSDI_SPADE_DIAG_W04\\spark\\examples\\streaming-lod\\index.html";

function extractObject(source, marker) {
  const at = source.indexOf(marker);
  if (at < 0) throw new Error("VIEWER_WORLDS_MISSING");
  const open = source.indexOf("{", at);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error("VIEWER_WORLDS_UNCLOSED");
}

function splitEntries(body) {
  const inner = body.slice(1, -1);
  const entries = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && /[\s,]/.test(inner[i])) i += 1;
    if (i >= inner.length) break;
    if (inner[i] !== "\"") throw new Error("VIEWER_WORLD_KEY");
    let j = i + 1;
    while (j < inner.length && inner[j] !== "\"") j += 1;
    const key = inner.slice(i + 1, j);
    const brace = inner.indexOf("{", j);
    let depth = 0;
    let quote = null;
    let escaped = false;
    let end = brace;
    for (; end < inner.length; end += 1) {
      const ch = inner[end];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "\"" || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    entries.push({ key, block: inner.slice(brace, end) });
    i = end;
  }
  return entries;
}

function arrayField(block, name) {
  const matched = block.match(new RegExp("(?<![A-Za-z])" + name + "\\s*:\\s*\\[([^\\]]+)\\]"));
  if (!matched) return null;
  return matched[1].split(",").map((part) => Number(part.trim()));
}

function numberField(block, name) {
  const matched = block.match(new RegExp("(?<![A-Za-z])" + name + "\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)"));
  return matched ? Number(matched[1]) : null;
}

function framesFromViewer(htmlPath = VIEWER_HTML) {
  const html = fs.readFileSync(htmlPath, "utf8");
  const frames = {};
  for (const { key, block } of splitEntries(extractObject(html, "const worlds = {"))) {
    const url = block.match(/localRadUrl\("([^"]+)"\)/);
    if (!url) throw new Error(`VIEWER_WORLD_URL ${key}`);
    const file = url[1].replace(/\.rad$/, "");
    const scale = numberField(block, "scale");
    frames[file] = {
      world: key,
      camera: arrayField(block, "cameraPosition") || [0, 0, 0],
      quaternion: arrayField(block, "cameraQuaternion") || [0, 0, 0, 1],
      scale: scale == null ? 1 : scale,
      worldPosition: arrayField(block, "position") || [0, 0, 0],
      worldQuaternion: arrayField(block, "quaternion") || [0, 0, 0, 1],
    };
  }
  return frames;
}

function sameVec(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => Math.abs(value - right[index]) < 1e-9);
}

function frameMatches(vendored, parsed) {
  if (!vendored || !parsed) return false;
  if (!sameVec(vendored.camera, parsed.camera)) return false;
  if (!sameVec(vendored.quaternion, parsed.quaternion)) return false;
  if (!(Math.abs(vendored.scale - parsed.scale) < 1e-9)) return false;
  if (vendored.worldPosition && !sameVec(vendored.worldPosition, parsed.worldPosition)) return false;
  if (vendored.worldQuaternion && !sameVec(vendored.worldQuaternion, parsed.worldQuaternion)) return false;
  return true;
}

module.exports = { VIEWER_HTML, framesFromViewer, frameMatches };
