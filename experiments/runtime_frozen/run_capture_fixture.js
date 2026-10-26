"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { chromium } = require("D:/Program/P5_3DGS/node_modules/playwright");
const { captureCheckpoint, expectedBuffer, encodePng, pngSize, classifyStale } = require("./capture_checkpoint");

function decodePng(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  const parts = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    }
    if (type === "IDAT") parts.push(data);
    if (type === "IEND") break;
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const pixels = Buffer.alloc(width * height * 4);
  const stride = width * 4;
  for (let y = 0; y < height; y += 1) pixels.set(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride), y * stride);
  return { width, height, pixels };
}

function pixel(decoded, x, y) {
  const index = (y * decoded.width + x) * 4;
  return [decoded.pixels[index], decoded.pixels[index + 1], decoded.pixels[index + 2], decoded.pixels[index + 3]];
}

async function main() {
  const failures = [];
  const round = encodePng(2, 2, Buffer.from([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]));
  if (pngSize(round).width !== 2 || decodePng(round).pixels[0] !== 1) failures.push("PNG_ROUNDTRIP");
  const mapA = expectedBuffer(1280, 720, 1.25);
  const mapB = expectedBuffer(1024, 576, 1.25);
  if (mapA.width !== 1600 || mapA.height !== 900 || mapB.width !== 1280 || mapB.height !== 720) failures.push("DPR_MAPPING");
  classifyStale("unit", { position: [0], buffer_width: 1, buffer_height: 1 }, "aaa");
  if (!classifyStale("unit", { position: [1], buffer_width: 1, buffer_height: 1 }, "aaa").stale_frame) failures.push("STALE_UNIT");

  const root = path.join(__dirname, "fixture_out");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: "C:/Users/IoT/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe" });
  const cases = [
    { client: "C3", css_w: 1280, css_h: 720 },
    { client: "C4", css_w: 1024, css_h: 576 },
  ];
  for (const item of cases) {
    const page = await browser.newPage({ viewport: { width: item.css_w, height: item.css_h } });
    await page.goto(`file:///${path.join(__dirname, "capture_fixture.html").replace(/\\/g, "/")}?css_w=${item.css_w}&css_h=${item.css_h}&dpr=1.25`);
    await page.waitForTimeout(100);
    const colors = [[10, 180, 40, 255], [10, 180, 40, 255], [20, 40, 200, 255]];
    const poses = [[0, 0, 0], [1, 0, 0], [2, 0, 0]];
    const expectError = [null, "STALE_FRAME", null];
    for (let index = 0; index < colors.length; index += 1) {
      await page.evaluate((payload) => {
        window.__poseColor = payload.color;
        window.__nextPose = payload.pose;
      }, { color: colors[index], pose: poses[index] });
      const row = await captureCheckpoint(page, null, root, { checkpoint_s: [2, 5, 10][index], client_id: item.client, timeout_ms: 2000 });
      if ((row.error || null) !== expectError[index]) failures.push(`${item.client}_capture_${index}_${row.error}`);
      if (row.ok || row.error === "STALE_FRAME") {
        const decoded = decodePng(fs.readFileSync(path.join(root, row.file)));
        const expect = expectedBuffer(item.css_w, item.css_h, 1.25);
        if (decoded.width !== expect.width || decoded.height !== expect.height) failures.push(`${item.client}_size_${decoded.width}x${decoded.height}`);
        const center = pixel(decoded, Math.floor(decoded.width / 2), Math.floor(decoded.height / 2));
        if (center[0] !== colors[index][0] || center[1] !== colors[index][1]) failures.push(`${item.client}_color_${center}`);
        const corner = pixel(decoded, 0, 0);
        if (corner[0] === 255 && corner[2] === 255) failures.push(`${item.client}_hud`);
      }
    }
    const missed = await captureCheckpoint(page, null, root, { checkpoint_s: 99, client_id: item.client, deadline_ms: Date.now() - 1000, file_stem: `${item.client}_missed` });
    if (missed.error !== "MISSED_CHECKPOINT" || fs.existsSync(path.join(root, missed.file))) failures.push(`${item.client}_deadline`);
    await page.close();
  }
  await browser.close();
  const result = { ok: failures.length === 0, failures };
  fs.writeFileSync(path.join(__dirname, "LOCAL_CAPTURE_FIXTURE.json"), JSON.stringify(result, null, 2));
  console.log(result.ok ? "CAPTURE_FIXTURE_PASS" : `CAPTURE_FIXTURE_FAIL ${failures.join(",")}`);
  if (!result.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
