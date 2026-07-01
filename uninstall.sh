#!/usr/bin/env bash
# =============================================================================
# uninstall.sh — SleepyCode watchdog scheduler uninstaller
#
# Reverses everything that install.sh did.  Reads the scheduler type from
# .sleepycode/scheduler (written by install.sh) so it knows which method to
# undo.  Falls back to auto-detection if that file is missing.
#
# Usage:
#   ./uninstall.sh
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${SCRIPT_DIR}/.sleepycode"

SYSTEMD_SERVICE_DIR="${HOME}/.config/systemd/user"
SYSTEMD_SERVICE="${SYSTEMD_SERVICE_DIR}/sleepycode-watchdog.service"
SYSTEMD_TIMER="${SYSTEMD_SERVICE_DIR}/sleepycode-watchdog.timer"
LAUNCHD_PLIST="${HOME}/Library/LaunchAgents/com.sleepycode.watchdog.plist"
CRON_MARKER="# sleepycode-watchdog"

info()  { echo "[uninstall] $*"; }
warn()  { echo "[uninstall] WARNING: $*" >&2; }
error() { echo "[uninstall] ERROR: $*" >&2; exit 1; }

# -----------------------------------------------------------------------------
# Determine which scheduler was used
# -----------------------------------------------------------------------------
if [[ -f "${STATE_DIR}/scheduler" ]]; then
    SCHEDULER="$(cat "${STATE_DIR}/scheduler")"
    info "Scheduler from install record: ${SCHEDULER}"
else
    warn ".sleepycode/scheduler not found — attempting auto-detection."
    os="$(uname -s)"
    if [[ "${os}" == "Darwin" ]]; then
        SCHEDULER="launchd"
    elif command -v systemctl &>/dev/null && systemctl --user show-environment &>/dev/null 2>&1; then
        SCHEDULER="systemd"
    else
        SCHEDULER="cron"
    fi
    info "Auto-detected scheduler: ${SCHEDULER}"
fi

# =============================================================================
# Uninstall functions
# =============================================================================
uninstall_systemd() {
    info "Stopping and disabling systemd service..."
    systemctl --user stop    sleepycode-watchdog 2>/dev/null || true
    systemctl --user disable sleepycode-watchdog 2>/dev/null || true

    info "Removing unit file..."
    rm -f "${SYSTEMD_SERVICE}"

    info "Reloading systemd user daemon..."
    systemctl --user daemon-reload

    echo ""
    echo "Uninstall complete (systemd). Service removed."
}

uninstall_launchd() {
    if [[ -f "${LAUNCHD_PLIST}" ]]; then
        info "Unloading launchd agent..."
        launchctl unload "${LAUNCHD_PLIST}" 2>/dev/null || true

        info "Removing plist..."
        rm -f "${LAUNCHD_PLIST}"

        echo ""
        echo "Uninstall complete (launchd). Plist removed."
    else
        warn "Plist not found at ${LAUNCHD_PLIST}. Nothing to remove."
    fi
}

uninstall_cron() {
    info "Removing cron entry..."
    if crontab -l 2>/dev/null | grep -qF "${CRON_MARKER}"; then
        # Remove only lines containing the marker, preserve everything else
        crontab -l 2>/dev/null | grep -vF "${CRON_MARKER}" | crontab -
        echo ""
        echo "Uninstall complete (cron). Entry removed from crontab."
    else
        warn "No matching cron entry found. Nothing to remove."
    fi
}

# =============================================================================
# Dispatch
# =============================================================================
case "${SCHEDULER}" in
    systemd) uninstall_systemd ;;
    launchd) uninstall_launchd ;;
    cron)    uninstall_cron    ;;
    *) error "Unknown scheduler '${SCHEDULER}'" ;;
esac

# Clean up scheduler record
rm -f "${STATE_DIR}/scheduler"
info "Scheduler record removed."
