"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { scorePair } = require("./score_cell_images");

const env = Object.assign({}, process.env, { MSYS_NO_PATHCONV: "1" });
const python = "/home/dd/spade_f_repair_venv/bin/python";
const scorer = "/mnt/d/Program/SPADE_REUSE_AND_EXECUTE_20261019/tools/score_psnr_ssim.py";

function linux(file) {
  return String(file).replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spade-img-"));
const identA = path.join(tmp, "a.png");
const identB = path.join(tmp, "b.png");
const make = spawnSync("wsl.exe", ["-e", python, "-c",
  "from PIL import Image; import sys; Image.new('RGB',(16,16),(20,40,60)).save(sys.argv[1]); Image.new('RGB',(16,16),(20,40,60)).save(sys.argv[2])",
  linux(identA), linux(identB),
], { encoding: "utf8", env, timeout: 30000, windowsHide: true });
assert.strictEqual(make.status, 0, make.stderr || make.stdout);

const unproven = spawnSync("wsl.exe", ["-e", python, scorer, linux(identA), linux(identB), "--reference-proven", "false"], {
  encoding: "utf8", env, timeout: 30000, windowsHide: true,
});
const unprovenJson = JSON.parse(unproven.stdout);
assert.strictEqual(unprovenJson.status, "REJECTED");
assert.strictEqual(unprovenJson.reason, "NO_ALIGNED_REFERENCE");
assert.strictEqual(unprovenJson.psnr, null);
assert.strictEqual(unprovenJson.ssim, null);

const proven = spawnSync("wsl.exe", ["-e", python, scorer, linux(identA), linux(identB), "--reference-proven", "true"], {
  encoding: "utf8", env, timeout: 30000, windowsHide: true,
});
const provenJson = JSON.parse(proven.stdout);
assert.strictEqual(provenJson.status, "IDENTICAL_INF");
assert.strictEqual(provenJson.psnr, "+Infinity");
assert.strictEqual(provenJson.ssim, 1.0);

const viaJs = scorePair(identA, identB);
assert.ok(viaJs.status === "IDENTICAL_INF" || viaJs.status === "MEASURED", JSON.stringify(viaJs));
assert.ok(viaJs.psnr === "+Infinity" || viaJs.psnr === Infinity || typeof viaJs.psnr === "number");
assert.strictEqual(viaJs.ssim, 1);

const realCanvas = "F:/WWW_N3_MUX/research_control/SPADE_REUSE_AND_EXECUTE_20261019/cells/bq1_n2_lru_stop_go_synchronized_seed27190001/evidence/nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_synchronized_seed27190001_bq1/C3/C3/canvas_t60.png";
const realRef = "F:/WWW_N3_MUX/research_control/SPADE_REUSE_AND_EXECUTE_20261019/cells/bq1_n2_lru_stop_go_synchronized_seed27190001/evidence/nsdi_N2_LRU_coit-40m-sh1-lod_stop_go_synchronized_seed27190001_bq1/C3/C3/reference_t60.png";
const live = scorePair(realCanvas, realRef);
assert.strictEqual(live.status, "MEASURED", JSON.stringify(live));
assert.equal(typeof live.psnr, "number");
assert.equal(typeof live.ssim, "number");
assert.ok(Number.isFinite(live.psnr));
assert.ok(live.ssim > 0 && live.ssim <= 1);
console.log("TEST_SCORE_CELL_IMAGES_PASS", JSON.stringify({ psnr: live.psnr, ssim: live.ssim }));
