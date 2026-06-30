#!/usr/bin/env bash
# =============================================================================
# sleepy.sh — SleepyCode main entry point
#
# Starts an autonomous Claude Code session inside tmux, then launches the
# DeepSeek-powered watchdog brain in the background to monitor and recover it.
#
# Usage:
#   ./sleepy.sh                        # Start with no initial prompt
#   ./sleepy.sh "Build me a REST API"  # Start with an initial task
#
# Environment:
#   ANTHROPIC_API_KEY  — Required by Claude Code (the worker)
#   DEEPSEEK_API_KEY   — Required by watchdog.py (the orchestrator brain)
#
# Controls:
#   Ctrl+B then D      — Detach from session without stopping it
#   ./sleepy.sh        — Re-run to reattach if already running
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INITIAL_PROMPT="${1:-}"
STATE_DIR="${SCRIPT_DIR}/.sleepycode"

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
info()    { echo "[sleepycode] $*"; }
warn()    { echo "[sleepycode] WARNING: $*" >&2; }
error()   { echo "[sleepycode] ERROR: $*" >&2; exit 1; }

# -----------------------------------------------------------------------------
# 1. Dependency checks
# -----------------------------------------------------------------------------
if ! command -v tmux &>/dev/null; then
    error "tmux is not installed. Install it with:
  Ubuntu/Debian: sudo apt install tmux
  macOS:         brew install tmux
  Fedora/RHEL:   sudo dnf install tmux"
fi

if ! command -v python3 &>/dev/null; then
    error "python3 is not installed. Install it from https://python.org or via your package manager."
fi

# -----------------------------------------------------------------------------
# 2. API key checks (warn only — Claude Code and watchdog will fail themselves
#    if the keys are truly absent, but we want early visibility)
# -----------------------------------------------------------------------------
if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    warn "ANTHROPIC_API_KEY is not set. Claude Code (the worker) will likely fail to start."
fi

if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
    warn "DEEPSEEK_API_KEY is not set. The watchdog brain will not be able to make decisions."
fi

# -----------------------------------------------------------------------------
# 3. Read session name from config.json (fall back to "sleepycode")
# -----------------------------------------------------------------------------
CONFIG_FILE="${SCRIPT_DIR}/config.json"

if [[ -f "${CONFIG_FILE}" ]]; then
    SESSION_NAME="$(python3 -c "
import json, sys
try:
    cfg = json.load(open('${CONFIG_FILE}'))
    print(cfg.get('session_name', 'sleepycode'))
except Exception as e:
    print('sleepycode')
")"
else
    warn "config.json not found at ${CONFIG_FILE}. Using default session name 'sleepycode'."
    SESSION_NAME="sleepycode"
fi

# Sanitise: tmux session names cannot contain dots or colons
SESSION_NAME="${SESSION_NAME//[.:]/_}"

# -----------------------------------------------------------------------------
# 4. Ensure state directory exists
# -----------------------------------------------------------------------------
mkdir -p "${STATE_DIR}"

# -----------------------------------------------------------------------------
# 5. If the tmux session already exists, just reattach
# -----------------------------------------------------------------------------
if tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
    info "Session '${SESSION_NAME}' is already running."
    info "Reattaching... (Ctrl+B then D to detach)"
    exec tmux attach-session -t "${SESSION_NAME}"
fi

# -----------------------------------------------------------------------------
# 6. Create a new detached tmux session
# -----------------------------------------------------------------------------
info "Creating tmux session '${SESSION_NAME}'..."
tmux new-session -d -s "${SESSION_NAME}"

# -----------------------------------------------------------------------------
# 7. Launch Claude Code inside the session
# -----------------------------------------------------------------------------
info "Launching Claude Code..."
tmux send-keys -t "${SESSION_NAME}" "claude" Enter

# Give Claude Code a moment to initialise its TUI before we send any prompt
sleep 2

# -----------------------------------------------------------------------------
# 8. Send initial prompt if provided
# -----------------------------------------------------------------------------
if [[ -n "${INITIAL_PROMPT}" ]]; then
    info "Sending initial prompt: ${INITIAL_PROMPT}"
    tmux send-keys -t "${SESSION_NAME}" "${INITIAL_PROMPT}" Enter
fi

# -----------------------------------------------------------------------------
# 9. Start watchdog brain in background
# -----------------------------------------------------------------------------
WATCHDOG="${SCRIPT_DIR}/watchdog.py"

if [[ ! -f "${WATCHDOG}" ]]; then
    warn "watchdog.py not found at ${WATCHDOG}. Skipping watchdog launch."
    WATCHDOG_PID=""
else
    info "Starting watchdog brain..."
    python3 "${WATCHDOG}" >> "${STATE_DIR}/watchdog.log" 2>&1 &
    WATCHDOG_PID=$!

    # Persist the PID so external tools (install.sh, stop scripts) can find it
    echo "${WATCHDOG_PID}" > "${STATE_DIR}/watchdog.pid"
fi

# -----------------------------------------------------------------------------
# 10. Print status summary
# -----------------------------------------------------------------------------
echo ""
echo "┌─────────────────────────────────────────┐"
echo "│         SleepyCode started               │"
echo "├─────────────────────────────────────────┤"
printf  "│  Session : %-29s│\n" "${SESSION_NAME}"
if [[ -n "${WATCHDOG_PID:-}" ]]; then
    printf "│  Watchdog: PID %-25s│\n" "${WATCHDOG_PID}"
else
    printf "│  Watchdog: not running                  │\n"
fi
echo "├─────────────────────────────────────────┤"
echo "│  Ctrl+B then D  →  detach (keeps alive) │"
echo "│  ./sleepy.sh    →  reattach later        │"
echo "└─────────────────────────────────────────┘"
echo ""

# Brief pause so the user can read the status before the display switches
sleep 1

# -----------------------------------------------------------------------------
# 11. Attach to the session (replaces this process — no orphan shell)
# -----------------------------------------------------------------------------
exec tmux attach-session -t "${SESSION_NAME}"
