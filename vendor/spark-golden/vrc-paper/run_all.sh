#!/usr/bin/env bash
# VRC Pipeline — Bash entry point
# Usage: bash vrc-paper/run_all.sh [options]
#
# Env overrides:
#   VRC_METHODS="Full,Spark-MU,VP-S,NET-S,VRC"
#   VRC_SCENARIOS="nearby,burst_turn,divergent"
#   VRC_TRIALS=1
#   VRC_TRIAL_DURATION_MS=30000
#   VRC_HEADLESS=true          # false = show browser windows
#   VITE_PORT=9200
#   VRC_SYNC_PORT=9201

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

export VRC_METHODS="${VRC_METHODS:-Full,Spark-MU,VP-S,NET-S,VRC,VRC-V,VRC-N,VRC-O,VRC}"
export VRC_SCENARIOS="${VRC_SCENARIOS:-nearby,burst_turn,divergent}"
export VRC_TRIALS="${VRC_TRIALS:-1}"
export VRC_TRIAL_DURATION_MS="${VRC_TRIAL_DURATION_MS:-30000}"
export VRC_HEADLESS="${VRC_HEADLESS:-true}"
export VITE_PORT="${VITE_PORT:-9200}"
export VRC_SYNC_PORT="${VRC_SYNC_PORT:-9201}"
export VRC_LOG_DIR="$SCRIPT_DIR/results/raw"

DEBUG_LOG="$SCRIPT_DIR/DEBUG_LOG.md"
mkdir -p "$SCRIPT_DIR/results/raw" "$SCRIPT_DIR/results/summary" \
         "$SCRIPT_DIR/results/figures" "$SCRIPT_DIR/results/screenshots"

log() { echo "[$(date +%H:%M:%S)] $*"; }
append_debug() { echo "- $*" >> "$DEBUG_LOG"; }

[ -f "$DEBUG_LOG" ] || echo "# DEBUG_LOG.md" > "$DEBUG_LOG"
append_debug "run_all.sh started at $(date)"

log "=== VRC Pipeline: run_all.sh ==="
log "Repo: $REPO_ROOT"
log "Methods: $VRC_METHODS"
log "Scenarios: $VRC_SCENARIOS"
log "Trials: $VRC_TRIALS  Duration: ${VRC_TRIAL_DURATION_MS}ms  Headless: $VRC_HEADLESS"

# ── Kill existing processes on ports ─────────────────────────────────────────
kill_port() {
    local port="$1"
    if command -v fuser &>/dev/null; then
        fuser -k "$port/tcp" 2>/dev/null || true
    elif command -v lsof &>/dev/null; then
        lsof -ti tcp:"$port" | xargs -r kill -9 2>/dev/null || true
    fi
}

log "Clearing ports $VITE_PORT and $VRC_SYNC_PORT..."
kill_port "$VITE_PORT" || true
kill_port "$VRC_SYNC_PORT" || true
sleep 1

# ── Install server deps ───────────────────────────────────────────────────────
log "Installing sync server deps..."
(cd "$SCRIPT_DIR/server" && npm install --prefer-offline --silent 2>/dev/null) || true

# ── Start sync server ─────────────────────────────────────────────────────────
log "Starting sync server on port $VRC_SYNC_PORT..."
(cd "$SCRIPT_DIR/server" && node sync_server.mjs) &
SYNC_PID=$!

# Wait for sync server
for i in $(seq 1 30); do
    if curl -sf "http://localhost:$VRC_SYNC_PORT/health" &>/dev/null; then
        log "Sync server ready (PID $SYNC_PID)"; break
    fi
    sleep 1
done

# ── Install repo deps ─────────────────────────────────────────────────────────
log "Installing repo deps..."
(cd "$REPO_ROOT" && npm install --prefer-offline --silent 2>/dev/null) || true

# ── Start Vite ────────────────────────────────────────────────────────────────
log "Starting Vite on port $VITE_PORT..."
(cd "$REPO_ROOT" && npx vite --port "$VITE_PORT" --host localhost) &
VITE_PID=$!

for i in $(seq 1 60); do
    if curl -sf "http://localhost:$VITE_PORT" &>/dev/null; then
        log "Vite ready (PID $VITE_PID)"; break
    fi
    sleep 1
done

# ── Cleanup trap ──────────────────────────────────────────────────────────────
cleanup() {
    log "Cleaning up..."
    kill "$SYNC_PID" 2>/dev/null || true
    kill "$VITE_PID" 2>/dev/null || true
    kill_port "$VITE_PORT" || true
    kill_port "$VRC_SYNC_PORT" || true
}
trap cleanup EXIT

# ── Run experiments ───────────────────────────────────────────────────────────
log "Running experiment runner..."
if node "$SCRIPT_DIR/experiments/run_experiment.mjs"; then
    log "Experiments complete"
else
    append_debug "Experiment runner exited with error at $(date)"
    log "WARNING: Experiment runner had errors (check DEBUG_LOG.md)"
fi

# ── Run analysis ──────────────────────────────────────────────────────────────
PYTHON=""
PYTHON_CANDIDATES=(
    python3 python py
    "$HOME/miniforge3/bin/python3"
    "$HOME/miniconda3/bin/python3"
    "$HOME/anaconda3/bin/python3"
    "/usr/local/bin/python3"
    "/opt/homebrew/bin/python3"
)
for candidate in "${PYTHON_CANDIDATES[@]}"; do
    if "$candidate" --version 2>&1 | grep -q "Python 3" 2>/dev/null; then
        if "$candidate" -m pip --version &>/dev/null 2>&1; then
            PYTHON="$candidate"; break
        fi
    fi
done

if [ -n "$PYTHON" ]; then
    log "Running Python analysis (real data only)..."
    "$PYTHON" -m pip install matplotlib --quiet 2>/dev/null || true
    if "$PYTHON" "$SCRIPT_DIR/analysis/analyze.py"; then
        log "Python analysis complete"
    else
        append_debug "Python analysis failed at $(date)"
        log "WARNING: Python analysis failed, using Node.js fallback"
    fi
else
    log "Python 3 not found; using Node.js analysis pipeline"
fi

# Node.js analysis (always runs for source_breakdown + canary + figures)
log "Running Node.js analysis pipeline..."
if node "$SCRIPT_DIR/analysis/run_analysis.mjs"; then
    log "Node.js analysis complete"
else
    append_debug "Node.js analysis exited non-zero at $(date) (canary failures expected)"
    log "Node.js analysis finished (canary validation may have failures)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
fig_count=$(ls "$SCRIPT_DIR/results/figures/"*.png 2>/dev/null | wc -l || echo 0)
csv_count=$(ls "$SCRIPT_DIR/results/summary/"*.csv 2>/dev/null | wc -l || echo 0)
ss_count=$(ls "$SCRIPT_DIR/results/screenshots/"*.png 2>/dev/null | wc -l || echo 0)

log "=== Pipeline complete ==="
log "  Figures:     $fig_count  (results/figures/)"
log "  CSVs:        $csv_count  (results/summary/)"
log "  Screenshots: $ss_count  (results/screenshots/)"
log "  Report:      results/final_report.md"

append_debug "run_all.sh finished at $(date) — $fig_count figures, $csv_count CSVs"
