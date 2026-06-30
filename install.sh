#!/usr/bin/env bash
# =============================================================================
# install.sh — SleepyCode watchdog OS-level scheduler installer
#
# Installs watchdog.py as a recurring background job that fires every 30 s
# independently of the main sleepy.sh process.  This ensures the orchestrator
# brain keeps running even if sleepy.sh exits or the terminal is closed.
#
# Supported schedulers (detected automatically):
#   • systemd user units  (Linux with systemctl --user)
#   • launchd             (macOS)
#   • cron                (fallback — minimum granularity is 1 minute)
#
# Usage:
#   ./install.sh          Install the watchdog scheduler
#
# To remove:
#   ./uninstall.sh        Reverse everything install.sh did
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WATCHDOG_PATH="${SCRIPT_DIR}/watchdog.py"
STATE_DIR="${SCRIPT_DIR}/.sleepycode"

# Scheduler-specific artifact paths (populated below)
SYSTEMD_SERVICE_DIR="${HOME}/.config/systemd/user"
SYSTEMD_SERVICE="${SYSTEMD_SERVICE_DIR}/sleepycode-watchdog.service"
SYSTEMD_TIMER="${SYSTEMD_SERVICE_DIR}/sleepycode-watchdog.timer"
LAUNCHD_PLIST="${HOME}/Library/LaunchAgents/com.sleepycode.watchdog.plist"
CRON_MARKER="# sleepycode-watchdog"

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
info()  { echo "[install] $*"; }
warn()  { echo "[install] WARNING: $*" >&2; }
error() { echo "[install] ERROR: $*" >&2; exit 1; }

# -----------------------------------------------------------------------------
# Pre-flight checks
# -----------------------------------------------------------------------------
[[ -f "${WATCHDOG_PATH}" ]] || error "watchdog.py not found at ${WATCHDOG_PATH}. Run install.sh from the project root."
command -v python3 &>/dev/null   || error "python3 is required but not installed."

mkdir -p "${STATE_DIR}"

# -----------------------------------------------------------------------------
# Platform detection
# -----------------------------------------------------------------------------
detect_scheduler() {
    local os
    os="$(uname -s)"

    if [[ "${os}" == "Darwin" ]]; then
        echo "launchd"
    elif [[ "${os}" == "Linux" ]]; then
        if command -v systemctl &>/dev/null && systemctl --user show-environment &>/dev/null 2>&1; then
            echo "systemd"
        else
            echo "cron"
        fi
    else
        # FreeBSD, etc. — fall back to cron
        echo "cron"
    fi
}

SCHEDULER="$(detect_scheduler)"
info "Detected scheduler: ${SCHEDULER}"

# =============================================================================
# systemd (Linux with user-level systemd)
# =============================================================================
install_systemd() {
    info "Installing systemd user units..."
    mkdir -p "${SYSTEMD_SERVICE_DIR}"

    # --- service unit (oneshot — runs watchdog.py and exits) -----------------
    cat > "${SYSTEMD_SERVICE}" <<EOF
[Unit]
Description=SleepyCode Watchdog
After=network.target

[Service]
Type=oneshot
WorkingDirectory=${SCRIPT_DIR}
ExecStart=python3 ${WATCHDOG_PATH}
StandardOutput=append:${STATE_DIR}/watchdog.log
StandardError=append:${STATE_DIR}/watchdog.log
EOF

    # Inject DEEPSEEK_API_KEY if it's set in the current environment so the
    # systemd unit inherits it.  Users can also set it via:
    #   systemctl --user set-environment DEEPSEEK_API_KEY=sk-...
    if [[ -n "${DEEPSEEK_API_KEY:-}" ]]; then
        echo "Environment=DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY}" >> "${SYSTEMD_SERVICE}"
    else
        warn "DEEPSEEK_API_KEY is not set in your environment."
        warn "Set it with:  systemctl --user set-environment DEEPSEEK_API_KEY=<your-key>"
    fi

    # --- timer unit (fires every 30 s) ----------------------------------------
    cat > "${SYSTEMD_TIMER}" <<EOF
[Unit]
Description=SleepyCode Watchdog Timer

[Timer]
OnBootSec=60
OnUnitActiveSec=30s

[Install]
WantedBy=timers.target
EOF

    info "Reloading systemd user daemon..."
    systemctl --user daemon-reload

    info "Enabling and starting timer..."
    systemctl --user enable --now sleepycode-watchdog.timer

    echo ""
    echo "Installation complete (systemd)."
    echo "Timer status:"
    systemctl --user status sleepycode-watchdog.timer --no-pager || true
    echo ""
    echo "Logs:  tail -f ${STATE_DIR}/watchdog.log"
    echo "Stop:  systemctl --user stop sleepycode-watchdog.timer"
}

# =============================================================================
# launchd (macOS)
# =============================================================================
install_launchd() {
    info "Installing launchd agent..."
    mkdir -p "$(dirname "${LAUNCHD_PLIST}")"

    cat > "${LAUNCHD_PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.sleepycode.watchdog</string>

    <key>ProgramArguments</key>
    <array>
        <string>python3</string>
        <string>${WATCHDOG_PATH}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${SCRIPT_DIR}</string>

    <key>StartInterval</key>
    <integer>30</integer>

    <key>StandardOutPath</key>
    <string>${STATE_DIR}/watchdog.log</string>

    <key>StandardErrorPath</key>
    <string>${STATE_DIR}/watchdog.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>DEEPSEEK_API_KEY</key>
        <string>${DEEPSEEK_API_KEY:-}</string>
    </dict>

    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
EOF

    info "Loading launchd agent..."
    launchctl load "${LAUNCHD_PLIST}"

    echo ""
    echo "Installation complete (launchd)."
    echo "Plist: ${LAUNCHD_PLIST}"
    echo "Logs:  tail -f ${STATE_DIR}/watchdog.log"
    echo "Stop:  launchctl unload ${LAUNCHD_PLIST}"
}

# =============================================================================
# cron (fallback)
# =============================================================================
install_cron() {
    info "Installing cron job (fallback — minimum interval is 1 minute)..."

    # Note: cron cannot fire more often than every 1 minute.  The watchdog's
    # own poll_interval (from config.json) controls finer-grained checks once
    # it is running, but the entry point fires at most once per minute.
    CRON_LINE="*/1 * * * * cd ${SCRIPT_DIR} && python3 ${WATCHDOG_PATH} >> ${STATE_DIR}/watchdog.log 2>&1 ${CRON_MARKER}"

    # Check whether the entry is already present
    if crontab -l 2>/dev/null | grep -qF "${CRON_MARKER}"; then
        warn "Cron entry already exists. Skipping. Run ./uninstall.sh first to reinstall."
        return 0
    fi

    # Append to existing crontab (preserve existing entries)
    ( crontab -l 2>/dev/null; echo "${CRON_LINE}" ) | crontab -

    echo ""
    echo "Installation complete (cron)."
    echo ""
    echo "Added cron entry:"
    echo "  ${CRON_LINE}"
    echo ""
    echo "NOTE: cron fires at most once per minute, not every 30 s."
    echo "      The watchdog polls internally at the interval in config.json."
    echo "Logs: tail -f ${STATE_DIR}/watchdog.log"
    echo "Remove with: ./uninstall.sh"
}

# =============================================================================
# Dispatch
# =============================================================================
case "${SCHEDULER}" in
    systemd) install_systemd ;;
    launchd) install_launchd ;;
    cron)    install_cron    ;;
    *) error "Unknown scheduler '${SCHEDULER}'" ;;
esac

# Record which scheduler was used so uninstall.sh knows what to undo
echo "${SCHEDULER}" > "${STATE_DIR}/scheduler"
info "Scheduler type saved to ${STATE_DIR}/scheduler"
