// visual_validator.mjs
// Pixel-level PNG validation for VRC screenshots.
// Returns ratios + screenshot_valid + failure_reason.
//
// Thresholds (per VRC_MASTER_AUTORUN.md):
//   black_ratio          > 0.80   -> FAIL (BLACK_SCREEN)
//   blue_ratio           > 0.80   -> FAIL (BLUE_SCREEN)
//   white_ratio          > 0.95   -> FAIL (WHITE_SCREEN)
//   non_background_ratio < 0.10   -> FAIL (BLANK)
//   luma_std             < 5      -> FAIL (FLAT_LOW_VARIANCE)
//   flat_color_ratio     > 0.90   -> FAIL (FLAT_COLOR)

import fs from "node:fs";
import { PNG } from "pngjs";

const SAMPLE_STRIDE = 4;          // sample every Nth pixel for speed
const BLACK_LUMA_MAX = 18;        // pixel is "black" if luma <= 18
const WHITE_LUMA_MIN = 240;       // pixel is "white" if luma >= 240
const BLUE_THRESHOLD = { rMax: 80, gMax: 110, bMin: 90, bgGap: 30 };
const FLAT_BUCKET_BITS = 4;       // quantize each channel to 4 bits when checking flat-color dominance

function lumaOf(r, g, b) {
  // Rec.601 luma
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function isBluePixel(r, g, b) {
  return r <= BLUE_THRESHOLD.rMax
      && g <= BLUE_THRESHOLD.gMax
      && b >= BLUE_THRESHOLD.bMin
      && b - r >= BLUE_THRESHOLD.bgGap
      && b - g >= BLUE_THRESHOLD.bgGap;
}

export function validatePngFile(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); }
  catch { return { exists: false, screenshot_valid: false, failure_reason: "FILE_MISSING" }; }

  let png;
  try {
    const buf = fs.readFileSync(filePath);
    png = PNG.sync.read(buf);
  } catch (e) {
    return {
      exists: true, bytes: stat.size,
      screenshot_valid: false,
      failure_reason: `PNG_DECODE_FAILED:${e.message}`,
    };
  }

  const { width, height, data } = png;
  if (width <= 0 || height <= 0) {
    return {
      exists: true, bytes: stat.size, width, height,
      screenshot_valid: false, failure_reason: "ZERO_DIMENSIONS",
    };
  }

  let nSampled = 0;
  let nBlack = 0;
  let nBlue = 0;
  let nWhite = 0;
  let lumaSum = 0;
  let lumaSqSum = 0;
  const colorBuckets = new Map();

  for (let y = 0; y < height; y += SAMPLE_STRIDE) {
    for (let x = 0; x < width; x += SAMPLE_STRIDE) {
      const idx = (y * width + x) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      const Y = lumaOf(r, g, b);
      nSampled++;
      lumaSum += Y;
      lumaSqSum += Y * Y;
      if (Y <= BLACK_LUMA_MAX) nBlack++;
      if (Y >= WHITE_LUMA_MIN) nWhite++;
      if (isBluePixel(r, g, b)) nBlue++;
      const key = ((r >> FLAT_BUCKET_BITS) << 8) | ((g >> FLAT_BUCKET_BITS) << 4) | (b >> FLAT_BUCKET_BITS);
      colorBuckets.set(key, (colorBuckets.get(key) || 0) + 1);
    }
  }

  const meanLuma = lumaSum / nSampled;
  const variance = Math.max(0, lumaSqSum / nSampled - meanLuma * meanLuma);
  const lumaStd  = Math.sqrt(variance);

  let topBucket = 0;
  for (const c of colorBuckets.values()) if (c > topBucket) topBucket = c;
  const flatColorRatio = topBucket / nSampled;

  const blackRatio = nBlack / nSampled;
  const whiteRatio = nWhite / nSampled;
  const blueRatio  = nBlue  / nSampled;
  // "non_background" = pixels that are NOT pure-black, NOT pure-white, NOT solid-blue
  const backgroundCount = nBlack + nWhite + nBlue;
  const nonBackgroundRatio = Math.max(0, 1 - backgroundCount / nSampled);

  const reasons = [];
  if (blackRatio > 0.80) reasons.push("BLACK_SCREEN");
  if (blueRatio  > 0.80) reasons.push("BLUE_SCREEN");
  if (whiteRatio > 0.95) reasons.push("WHITE_SCREEN");
  if (nonBackgroundRatio < 0.10) reasons.push("BLANK_SCENE");
  if (lumaStd < 5) reasons.push("FLAT_LOW_VARIANCE");
  if (flatColorRatio > 0.90) reasons.push("FLAT_COLOR");

  const valid = reasons.length === 0;

  return {
    exists: true,
    bytes: stat.size,
    width, height,
    samples: nSampled,
    black_ratio:          +blackRatio.toFixed(4),
    blue_ratio:           +blueRatio.toFixed(4),
    white_ratio:          +whiteRatio.toFixed(4),
    flat_color_ratio:     +flatColorRatio.toFixed(4),
    non_background_ratio: +nonBackgroundRatio.toFixed(4),
    mean_luma:            +meanLuma.toFixed(2),
    luma_std:             +lumaStd.toFixed(2),
    screenshot_valid:     valid,
    failure_reason:       valid ? null : reasons.join(";"),
  };
}

export function buildVisualCheck(sessionId, screenshotsDir, numUsers) {
  const out = { session_id: sessionId, screenshots: {}, summary: {} };
  let validCount = 0;
  let missingCount = 0;
  let invalidPixelCount = 0;
  const failures = [];
  const pixelReasonCounts = {};
  for (let i = 0; i < numUsers; i++) {
    const userId = `u${i}`;
    const file = `${screenshotsDir}/${sessionId}_${userId}.png`;
    const r = validatePngFile(file);
    out.screenshots[userId] = r;
    if (r.screenshot_valid) {
      validCount++;
      continue;
    }
    failures.push(`${userId}:${r.failure_reason}`);
    if (r.failure_reason === "FILE_MISSING") {
      missingCount++;
    } else {
      invalidPixelCount++;
      const first = String(r.failure_reason || "UNKNOWN").split(";")[0];
      pixelReasonCounts[first] = (pixelReasonCounts[first] || 0) + 1;
    }
  }
  const allValid = validCount === numUsers;

  let overall_status;
  if (allValid) {
    overall_status = "PASS";
  } else if (missingCount === numUsers) {
    overall_status = "FAIL_VISUAL_MISSING_SCREENSHOTS";
  } else if (missingCount > 0) {
    overall_status = "FAIL_VISUAL_INCOMPLETE_USERS";
  } else {
    const dominant = Object.entries(pixelReasonCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
    switch (dominant) {
      case "BLACK_SCREEN":      overall_status = "FAIL_VISUAL_BLACK_SCREEN"; break;
      case "BLUE_SCREEN":       overall_status = "FAIL_VISUAL_BLUE_SCREEN"; break;
      case "WHITE_SCREEN":      overall_status = "FAIL_VISUAL_WHITE_SCREEN"; break;
      case "BLANK_SCENE":       overall_status = "FAIL_VISUAL_BLANK_SCENE"; break;
      case "FLAT_LOW_VARIANCE":
      case "FLAT_COLOR":        overall_status = "FAIL_VISUAL_FLAT"; break;
      default:                  overall_status = "FAIL_VISUAL_INVALID";
    }
  }

  out.summary = {
    users_total: numUsers,
    users_valid: validCount,
    users_missing: missingCount,
    users_invalid_pixels: invalidPixelCount,
    all_valid: allValid,
    overall_status,
    failures,
  };
  return out;
}
