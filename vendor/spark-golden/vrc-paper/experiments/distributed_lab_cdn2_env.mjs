/**
 * Optional HPC + CDN1/CDN2 fields on distributed_lab.json.
 * - Normal rule: real process.env wins over JSON when env is a non-placeholder URL.
 * - If env is empty or still a template like `<CDN_A>`, JSON values are applied so runs
 *   never silently keep angle-bracket placeholders in vrc_scene query params.
 */

function looksLikeCdnPlaceholder(s) {
  const v = String(s ?? "").trim();
  if (!v) return true;
  if (/^<[^>]+>$/.test(v)) return true;
  if (/\bCDN_[AB]\b/i.test(v) && !/^https?:\/\//i.test(v)) return true;
  if (/^TODO/i.test(v)) return true;
  return false;
}

function shouldApplyLabCdnOverEnv(envVal, labVal) {
  const lab = String(labVal ?? "").trim();
  if (!lab) return false;
  return looksLikeCdnPlaceholder(envVal);
}

/**
 * @param {Record<string, unknown>} [cfg]
 */
export function applyCdn2EnvFromLab(cfg) {
  if (!cfg || typeof cfg !== "object") return;

  const hpcLab = String(cfg.hpc_asset_base ?? "").trim().replace(/\/+$/, "");
  const hpcEnv = String(process.env.VRC_HPC_ASSET_BASE ?? "").trim();
  if (shouldApplyLabCdnOverEnv(hpcEnv, hpcLab)) {
    process.env.VRC_HPC_ASSET_BASE = hpcLab;
  }

  const cdn1Lab = String(cfg.cdn_asset_base ?? "").trim().replace(/\/+$/, "");
  const cdn1Env = String(process.env.VRC_CDN_ASSET_BASE ?? "").trim();
  if (shouldApplyLabCdnOverEnv(cdn1Env, cdn1Lab)) {
    process.env.VRC_CDN_ASSET_BASE = cdn1Lab;
  }

  const base = String(cfg.cdn2_asset_base ?? "").trim().replace(/\/+$/, "");
  const cdn2Env = String(process.env.VRC_CDN2_ASSET_BASE ?? "").trim();
  if (shouldApplyLabCdnOverEnv(cdn2Env, base)) {
    process.env.VRC_CDN2_ASSET_BASE = base;
  }
  const p1 = String(cfg.cdn2_object_path ?? "").trim().replace(/^\/+/, "");
  if (p1 && !String(process.env.VRC_CDN2_OBJECT_PATH ?? "").trim()) {
    process.env.VRC_CDN2_OBJECT_PATH = p1;
  }
  const p2 = String(cfg.cdn2_object_path_hobbiton ?? "").trim().replace(/^\/+/, "");
  if (p2 && !String(process.env.VRC_CDN2_OBJECT_PATH_HOBBITON ?? "").trim()) {
    process.env.VRC_CDN2_OBJECT_PATH_HOBBITON = p2;
  }
}
