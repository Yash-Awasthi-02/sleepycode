#!/usr/bin/env bash
# Run all test suites and report the combined result.
# Usage: bash tests/run-all.sh
# bun test auto-discovers tests/*.test.ts; run-contracts.py is the remaining
# Python harness (dies with the hermit-start/stop/watchdog ports).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

rc=0
(cd "$SCRIPT_DIR/.." && bun test) || rc=$?
python3 "$SCRIPT_DIR/run-contracts.py" || rc=$?
exit $rc
