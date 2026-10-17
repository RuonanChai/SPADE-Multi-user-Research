#!/bin/bash
# Usage: sudo bash run-perf-tiers.sh [network-interface]
DEV=${1:-eth0}

run_tier() {
  local label=$1
  echo "=== $label ==="
  for n in 1 5; do
    echo "-- users=$n --"
    node perf-load.mjs $n 2>/dev/null
  done
}

reset_tc() { sudo tc qdisc del dev $DEV root 2>/dev/null; }

reset_tc
run_tier "baseline"

reset_tc
sudo tc qdisc add dev $DEV root netem rate 50mbit delay 20ms
run_tier "50mbit-20ms"

reset_tc
sudo tc qdisc add dev $DEV root netem rate 20mbit delay 50ms loss 0.5%
run_tier "20mbit-50ms-loss0.5"

reset_tc
sudo tc qdisc add dev $DEV root netem rate 10mbit delay 100ms loss 1%
run_tier "10mbit-100ms-loss1"

reset_tc
