#!/usr/bin/env node
/** Pure fail-closed bindings from one frozen matrix cell to the live runtime. */

'use strict';

const crypto = require('crypto');
const path = require('path');

const SHA256_RE = /^[0-9a-f]{64}$/;
const SAFE_RUN_ID_RE = /^nsdi_N[123]_[A-Za-z0-9._-]+$/;
const CANONICAL_ORIGIN_URL =
  'https://streaming-1438331348.cos.ap-guangzhou.myqcloud.com';
const DEFAULT_CACHE_MAX_BYTES = 50 * 1024 * 1024;
const SCHEDULER_PORT = 8081;
const BARRIER_LEAD_MS = 15000;
const SUPPORTED_RUNTIME_METHODS = Object.freeze(new Set([
  'IND', 'FIFO', 'LRU', 'SIEVE', 'S3-FIFO', 'LRU-cache-only', 'SPADE-N', 'Size-Aware', 'SPADE',
  'SPADE-1', 'SPADE-N-1', 'SPADE-2', 'SPADE-N-2', 'MARS-LRU',
  'CoLRU-age', 'CoLRU-fair', 'CoLRU-common', 'CoLRU-full', 'CoLRU-no-fair',
  'CoLRU-no-common', 'DLS-only', 'DLS-CoLRU', 'DLS-CoLRU-no-lookahead',
  'DLS-CoLRU-no-fair', 'DLS-CoLRU-no-common', 'DLS-CoLRU-strict-gate',
  'DLS-CoLRU-partial-gate', 'DLS-CoLRU-safe'
]));

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeCapacity(capacity) {
  if (Number.isInteger(capacity) && capacity > 0) {
    return {max_entries: capacity, max_bytes: DEFAULT_CACHE_MAX_BYTES};
  }
  if (exactKeys(capacity, ['max_entries', 'max_bytes', 'calibration_artifact_sha256']) &&
      Number.isInteger(capacity.max_entries) && capacity.max_entries > 0 &&
      Number.isInteger(capacity.max_bytes) && capacity.max_bytes > 0 &&
      SHA256_RE.test(capacity.calibration_artifact_sha256 || '')) {
    return {max_entries: capacity.max_entries, max_bytes: capacity.max_bytes};
  }
  throw new Error('RUNTIME_CAPACITY_NOT_FROZEN');
}

function deriveRuntimeActuation(cell, context) {
  if (!cell || !context || !SAFE_RUN_ID_RE.test(context.runId || '') ||
      !SHA256_RE.test(context.scientificEpoch || '') ||
      !SHA256_RE.test(context.matrixSha256 || '') ||
      !SHA256_RE.test(context.topologySha256 || '') ||
      !SHA256_RE.test(context.schedulerSourceSha256 || '') ||
      !SHA256_RE.test(context.colruScoringSourceSha256 || '') ||
      !SHA256_RE.test(cell.cell_id?.replace(/^cell_/, '') || '') ||
      cell.execution_eligible !== true) {
    throw new Error('RUNTIME_ACTUATION_CONTEXT_INVALID');
  }
  const semantics = cell.runtime_semantics;
  if (!semantics || typeof semantics !== 'object' || Array.isArray(semantics) ||
      !SUPPORTED_RUNTIME_METHODS.has(semantics.key)) {
    throw new Error('RUNTIME_METHOD_NOT_SOURCE_BACKED');
  }
  const capacity = normalizeCapacity(cell.capacity);
  const dlsK = semantics.dls_enabled === true ? semantics.lookahead_K : 0;
  if (!Number.isInteger(dlsK) || dlsK < 0 || dlsK > 64 ||
      (semantics.dls_enabled !== true && semantics.lookahead_K !== undefined &&
        semantics.lookahead_K !== 0)) {
    throw new Error('RUNTIME_DLS_K_SEMANTICS_INVALID');
  }
  const evidenceDir = path.resolve(context.evidenceDir);
  const argv = [
    context.schedulerSourcePath,
    '--method', semantics.key,
    '--port', String(SCHEDULER_PORT),
    '--origin-url', CANONICAL_ORIGIN_URL,
    '--force-origin',
    '--cache-max-entries', String(capacity.max_entries),
    '--cache-max-mb', String(capacity.max_bytes / (1024 * 1024)),
    '--dls-k', String(dlsK),
    '--run-id', context.runId,
    '--evidence-dir', evidenceDir
  ];
  // command254 L1R6: optional demand-amp soft brake (source-backed from cell runtime_semantics)
  if (Number.isFinite(semantics.l1_miss_budget) && semantics.l1_miss_budget > 0) {
    argv.push('--l1-miss-budget', String(Math.floor(semantics.l1_miss_budget)));
  }
  if (Number.isFinite(semantics.l1_excess_delay_ms) && semantics.l1_excess_delay_ms > 0) {
    argv.push('--l1-excess-delay-ms', String(Math.floor(semantics.l1_excess_delay_ms)));
  }
  if (Number.isFinite(semantics.origin_slots) && semantics.origin_slots >= 0) {
    argv.push('--origin-slots', String(Math.floor(semantics.origin_slots)));
  }
  if (semantics.m1_pin === true) argv.push('--m1-pin');
  if (semantics.m2_bpb === true) argv.push('--m2-bpb');
  return {
    schema_version: 1,
    run_id: context.runId,
    cell_id: cell.cell_id,
    requested_method: cell.method,
    runtime_method: semantics.key,
    runtime_semantics: semantics,
    scheduler_port: SCHEDULER_PORT,
    origin_url: CANONICAL_ORIGIN_URL,
    force_origin: true,
    cache_max_entries: capacity.max_entries,
    cache_max_bytes: capacity.max_bytes,
    dls_k: dlsK,
    scheduler_source_sha256: context.schedulerSourceSha256,
    colru_scoring_source_sha256: context.colruScoringSourceSha256,
    scientific_epoch: context.scientificEpoch,
    matrix_sha256: context.matrixSha256,
    topology_sha256: context.topologySha256,
    evidence_dir: evidenceDir,
    argv,
    argv_sha256: sha256Bytes(Buffer.from(JSON.stringify(argv)))
  };
}

function buildBarrierRelease(cell, clientId, bindings, nowMs = Date.now()) {
  const clientIndex = cell?.selected_clients?.indexOf(clientId);
  if (clientIndex < 0 || !Number.isInteger(cell.seed) ||
      !Number.isFinite(cell.phase_offsets?.[clientIndex]) ||
      !SAFE_RUN_ID_RE.test(bindings.runId || '') ||
      ![bindings.scientificEpoch, bindings.matrixSha256, bindings.topologySha256,
        bindings.traceSha256, bindings.configSha256, bindings.schedulerContractSha256]
        .every(value => SHA256_RE.test(value || ''))) {
    throw new Error('BARRIER_RELEASE_BINDINGS_INVALID');
  }
  const barrierEpochMs = nowMs + BARRIER_LEAD_MS + Math.abs(cell.seed % 997);
  const identity = {
    run_id: bindings.runId,
    cell_id: cell.cell_id,
    scientific_epoch: bindings.scientificEpoch,
    barrier_epoch_ms: barrierEpochMs,
    seed: cell.seed
  };
  return {
    schema_version: 1,
    barrier_id: `barrier_${sha256Bytes(Buffer.from(stableStringify(identity)))}`,
    run_id: bindings.runId,
    client_id: clientId,
    cell_id: cell.cell_id,
    scientific_epoch: bindings.scientificEpoch,
    matrix_sha256: bindings.matrixSha256,
    topology_sha256: bindings.topologySha256,
    issued_at: new Date(nowMs).toISOString(),
    barrier_epoch_ms: barrierEpochMs,
    phase_offset_seconds: cell.phase_offsets[clientIndex],
    seed: cell.seed,
    trace_sha256: bindings.traceSha256,
    config_sha256: bindings.configSha256,
    scheduler_contract_sha256: bindings.schedulerContractSha256
  };
}

function validateBarrierRelease(value, expected) {
  const keys = [
    'schema_version', 'barrier_id', 'run_id', 'client_id', 'cell_id',
    'scientific_epoch', 'matrix_sha256', 'topology_sha256', 'issued_at',
    'barrier_epoch_ms', 'phase_offset_seconds', 'seed', 'trace_sha256',
    'config_sha256', 'scheduler_contract_sha256'
  ];
  const errors = [];
  if (!exactKeys(value, keys) || value.schema_version !== 1) {
    return ['BARRIER_RELEASE_SCHEMA_INVALID'];
  }
  for (const key of [
    'run_id', 'client_id', 'cell_id', 'scientific_epoch', 'matrix_sha256',
    'topology_sha256', 'phase_offset_seconds', 'seed', 'trace_sha256',
    'config_sha256', 'scheduler_contract_sha256'
  ]) {
    if (value[key] !== expected[key]) errors.push(`BARRIER_RELEASE_${key.toUpperCase()}_MISMATCH`);
  }
  if (!/^barrier_[0-9a-f]{64}$/.test(value.barrier_id || '') ||
      !Number.isFinite(Date.parse(value.issued_at || '')) ||
      !Number.isInteger(value.barrier_epoch_ms) ||
      value.barrier_epoch_ms <= Date.parse(value.issued_at || '')) {
    errors.push('BARRIER_RELEASE_TIMING_OR_ID_INVALID');
  }
  return errors;
}

const RUNTIME_CONTRACT_KEYS = Object.freeze([
  'schema_version', 'run_id', 'pid', 'started_at', 'method', 'port', 'origin_url',
  'force_origin', 'cache_max_entries', 'cache_max_bytes', 'dls_k', 'dls_gate',
  'fetcher_slots', 'origin_slots', 'scheduler_source_sha256',
  'colru_scoring_source_sha256', 'evidence_dir'
]);

function validateRuntimeContract(value, actuation, expectedPid) {
  const errors = [];
  if (!exactKeys(value, RUNTIME_CONTRACT_KEYS) || value.schema_version !== 1) {
    return ['RUNTIME_CONTRACT_SCHEMA_INVALID'];
  }
  const expected = {
    run_id: actuation.run_id,
    method: actuation.runtime_method,
    port: actuation.scheduler_port,
    origin_url: actuation.origin_url,
    force_origin: true,
    cache_max_entries: actuation.cache_max_entries,
    cache_max_bytes: actuation.cache_max_bytes,
    dls_k: actuation.dls_k,
    scheduler_source_sha256: actuation.scheduler_source_sha256,
    colru_scoring_source_sha256: actuation.colru_scoring_source_sha256,
    evidence_dir: actuation.evidence_dir
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) errors.push(`RUNTIME_CONTRACT_${key.toUpperCase()}_MISMATCH`);
  }
  if (value.pid !== expectedPid || !Number.isFinite(Date.parse(value.started_at || '')) ||
      !['strict', 'partial'].includes(value.dls_gate) ||
      !Number.isInteger(value.fetcher_slots) || value.fetcher_slots <= 0 ||
      !Number.isInteger(value.origin_slots)) {
    errors.push('RUNTIME_CONTRACT_PROCESS_OR_SCHEDULER_FIELDS_INVALID');
  }
  return errors;
}

function validateResetMetrics(metrics, actuation, expectedPid) {
  const errors = [];
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics) ||
      metrics.run_id !== actuation.run_id || metrics.pid !== expectedPid ||
      metrics.method !== actuation.runtime_method ||
      metrics.scheduler_source_sha256 !== actuation.scheduler_source_sha256 ||
      metrics.colru_scoring_source_sha256 !== actuation.colru_scoring_source_sha256 ||
      metrics.origin_url !== actuation.origin_url || metrics.force_origin !== true ||
      metrics.cache_max_entries !== actuation.cache_max_entries ||
      metrics.cache_max_bytes !== actuation.cache_max_bytes || metrics.dls_k !== actuation.dls_k) {
    errors.push('RUNTIME_RESET_METRICS_BINDING_INVALID');
  }
  for (const key of ['total_requests', 'cache_hits', 'cache_misses', 'origin_bytes', 'cache_size',
    'cache_bytes', 'inflight_count']) {
    if (metrics?.[key] !== 0) errors.push(`RUNTIME_RESET_METRICS_${key.toUpperCase()}_NONZERO`);
  }
  return errors;
}

function validateFinalMetrics(metrics, actuation, expectedPid, options = {}) {
  const errors = [];
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics) ||
      metrics.run_id !== actuation.run_id || metrics.pid !== expectedPid ||
      metrics.method !== actuation.runtime_method ||
      metrics.scheduler_source_sha256 !== actuation.scheduler_source_sha256 ||
      metrics.colru_scoring_source_sha256 !== actuation.colru_scoring_source_sha256 ||
      metrics.origin_url !== actuation.origin_url || metrics.force_origin !== true ||
      metrics.cache_max_entries !== actuation.cache_max_entries ||
      metrics.cache_max_bytes !== actuation.cache_max_bytes || metrics.dls_k !== actuation.dls_k) {
    errors.push('RUNTIME_FINAL_METRICS_BINDING_INVALID');
  }
  for (const key of [
    'total_requests', 'cache_hits', 'cache_misses', 'origin_bytes',
    'cache_size', 'cache_bytes', 'inflight_count', 'queue_length'
  ]) {
    if (!Number.isInteger(metrics?.[key]) || metrics[key] < 0) {
      errors.push(`RUNTIME_FINAL_METRICS_${key.toUpperCase()}_INVALID`);
    }
  }
  if (Number.isInteger(metrics?.total_requests) && metrics.total_requests < 1 &&
      options.allowZeroRequests !== true) {
    errors.push('RUNTIME_FINAL_METRICS_NO_REQUESTS');
  }
  // Accounting equation: total_requests = cache_hits + cache_misses + inflight_merges
  // Treat missing inflight_merges as 0 (backward compatibility with old runs)
  if (Number.isInteger(metrics?.cache_hits) && Number.isInteger(metrics?.cache_misses) &&
      Number.isInteger(metrics?.total_requests)) {
    const inflightMerges = Number.isInteger(metrics?.inflight_merges) ? metrics.inflight_merges : 0;
    if (metrics.cache_hits + metrics.cache_misses + inflightMerges !== metrics.total_requests) {
      errors.push('RUNTIME_FINAL_METRICS_REQUEST_ACCOUNTING_INVALID');
    }
  }
  if (Number.isInteger(metrics?.cache_misses) && metrics.cache_misses > 0 &&
      (!Number.isInteger(metrics?.origin_bytes) || metrics.origin_bytes <= 0)) {
    errors.push('RUNTIME_FINAL_METRICS_ORIGIN_BYTES_INVALID');
  }
  if (metrics?.inflight_count !== 0 || metrics?.queue_length !== 0) {
    errors.push('RUNTIME_FINAL_METRICS_NOT_QUIESCENT');
  }
  const expectedRatio = metrics?.total_requests > 0
    ? metrics.cache_hits / metrics.total_requests
    : 0;
  if (!Number.isFinite(metrics?.cache_hit_ratio) ||
      Math.abs(metrics.cache_hit_ratio - expectedRatio) > Number.EPSILON) {
    errors.push('RUNTIME_FINAL_METRICS_HIT_RATIO_INVALID');
  }
  return errors;
}

const RUNTIME_PROOF_KEYS = Object.freeze([
  'schema_version', 'run_id', 'cell_id', 'pid', 'requested_method', 'runtime_method',
  'started_at', 'ready_at', 'stopped_at', 'scheduler_source_sha256',
  'colru_scoring_source_sha256', 'argv_sha256', 'origin_url', 'force_origin',
  'cache_max_entries', 'cache_max_bytes', 'dls_k', 'port_owner_before',
  'port_owner_after', 'port_inventory_before_sha256', 'port_inventory_after_sha256',
  'runtime_contract_before_sha256', 'metrics_before_sha256',
  'metrics_after_sha256', 'proxy_log_sha256', 'decision_log_sha256',
  'exchange_log_sha256', 'stdout_sha256', 'stderr_sha256'
]);

function validateRuntimeServiceProof(value, expected) {
  const errors = [];
  if (!exactKeys(value, RUNTIME_PROOF_KEYS) || value.schema_version !== 1) {
    return ['RUNTIME_SERVICE_PROOF_SCHEMA_INVALID'];
  }
  for (const key of [
    'run_id', 'cell_id', 'requested_method', 'runtime_method',
    'scheduler_source_sha256', 'colru_scoring_source_sha256', 'argv_sha256',
    'origin_url', 'force_origin', 'cache_max_entries', 'cache_max_bytes', 'dls_k'
  ]) {
    if (value[key] !== expected[key]) errors.push(`RUNTIME_SERVICE_PROOF_${key.toUpperCase()}_MISMATCH`);
  }
  if (!Number.isInteger(value.pid) || value.pid <= 0 ||
      value.port_owner_before !== null || value.port_owner_after !== null ||
      !Number.isFinite(Date.parse(value.started_at || '')) ||
      !Number.isFinite(Date.parse(value.ready_at || '')) ||
      !Number.isFinite(Date.parse(value.stopped_at || '')) ||
      Date.parse(value.ready_at) < Date.parse(value.started_at) ||
      Date.parse(value.stopped_at) < Date.parse(value.ready_at)) {
    errors.push('RUNTIME_SERVICE_PROOF_LIFECYCLE_INVALID');
  }
  for (const key of [
    'port_inventory_before_sha256', 'port_inventory_after_sha256',
    'runtime_contract_before_sha256', 'metrics_before_sha256', 'metrics_after_sha256',
    'proxy_log_sha256', 'decision_log_sha256', 'exchange_log_sha256',
    'stdout_sha256', 'stderr_sha256'
  ]) {
    if (!SHA256_RE.test(value[key] || '')) errors.push(`RUNTIME_SERVICE_PROOF_${key.toUpperCase()}_INVALID`);
  }
  return errors;
}

module.exports = {
  CANONICAL_ORIGIN_URL,
  DEFAULT_CACHE_MAX_BYTES,
  SCHEDULER_PORT,
  BARRIER_LEAD_MS,
  SUPPORTED_RUNTIME_METHODS,
  exactKeys,
  sha256Bytes,
  stableStringify,
  normalizeCapacity,
  deriveRuntimeActuation,
  buildBarrierRelease,
  validateBarrierRelease,
  validateRuntimeContract,
  validateResetMetrics,
  validateFinalMetrics,
  validateRuntimeServiceProof,
  RUNTIME_CONTRACT_KEYS,
  RUNTIME_PROOF_KEYS
};
