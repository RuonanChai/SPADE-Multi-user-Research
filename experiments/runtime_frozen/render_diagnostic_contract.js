'use strict';

function classifyGpuPath({unmaskedRenderer}) {
  const text = String(unmaskedRenderer || '').toLowerCase();
  if (!text) return 'AMBIGUOUS_UNPROVEN';
  if (/swiftshader|software|basic render|llvmpipe/.test(text)) return 'SOFTWARE_RENDERER';
  if (/nvidia.*rtx\s*3060|geforce rtx 3060/.test(text)) return 'NVIDIA_RTX3060_HARDWARE';
  if (/intel|uhd graphics|iris/.test(text)) return 'INTEL_IGPU_HARDWARE';
  return 'AMBIGUOUS_UNPROVEN';
}

function buildGpuPathEvidence({clientId, runId, scientificEpoch, gpu, page, timing, windows = {}}) {
  return {
    schema_version: 1,
    diagnostic_only: true,
    client_id: clientId,
    run_id: runId,
    scientific_epoch: scientificEpoch,
    classification: classifyGpuPath(gpu),
    gpu,
    page,
    timing,
    windows,
    captured_at: new Date().toISOString()
  };
}

module.exports = {classifyGpuPath, buildGpuPathEvidence};
