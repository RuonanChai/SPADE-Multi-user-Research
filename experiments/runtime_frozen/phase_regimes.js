"use strict";

// Frozen viewing regimes for the same Coit stop_go trace.
// synchronized: every client starts the trace at the shared barrier epoch.
// staggered: C4 lags by half the 10 s stop/go cycle, C5 by one full cycle.
// The trace player always starts at frame 0. The offset delays replay and the
// measurement window together; it does not seek inside the trace.

const REPLAY_WARMUP_MS = 5000;
const MEASUREMENT_DURATION_S = 70;
const TRACE_DURATION_S = 70;
const RUN_ID_RE = /^nsdi_N[123]_(LRU|FIFO|SIEVE|S3FIFO|IND|SPADEF|SPADEQ|SPADEM200|SPADEHOLD|SPADEPRESS|SPADEDEMAND|SPADER2|SPADES3|FG1|FG2|FG3|FG4|FG5|SPADEBYTE)_[A-Za-z0-9._-]+$/;

const REGIMES = Object.freeze({
  synchronized: Object.freeze({ C3: 0, C4: 0, C5: 0 }),
  staggered: Object.freeze({ C3: 0, C4: 5, C5: 10 }),
});

function regimeForRunId(runId) {
  if (!RUN_ID_RE.test(runId || "")) throw new Error("PHASE_RUN_ID_INVALID");
  return runId.includes("_staggered_") ? "staggered" : "synchronized";
}

function phaseOffsetMap(regime) {
  const row = REGIMES[regime];
  if (!row) throw new Error(`PHASE_REGIME_UNKNOWN:${regime}`);
  return { C3: row.C3, C4: row.C4, C5: row.C5 };
}

function schedule(barrierEpochMs, phaseOffsetSeconds) {
  if (!Number.isInteger(barrierEpochMs) || !Number.isFinite(phaseOffsetSeconds)) {
    throw new Error("PHASE_SCHEDULE_INVALID");
  }
  const targetMeasurementStart = barrierEpochMs + phaseOffsetSeconds * 1000;
  return {
    targetMeasurementStart,
    replayReleaseAt: targetMeasurementStart - REPLAY_WARMUP_MS,
    traceSeekMs: 0,
    traceTimeAtMeasurementStartMs: REPLAY_WARMUP_MS,
  };
}

function traceTimeMs(replayReleaseAt, wallMs) {
  return wallMs - replayReleaseAt;
}

module.exports = {
  REPLAY_WARMUP_MS,
  MEASUREMENT_DURATION_S,
  TRACE_DURATION_S,
  REGIMES,
  regimeForRunId,
  phaseOffsetMap,
  schedule,
  traceTimeMs,
};
