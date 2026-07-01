#!/usr/bin/env bash
# =============================================================================
# install.sh — SleepyCode watchdog OS-level scheduler installer
#
# Installs watchdog.py as a persistent background daemon.
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
LOG_PATH="${SCRIPT_DIR}/watchdog.log"

# Scheduler-specific artifact paths
SYSTEMD_SERVICE_DIR="${HOME}/.config/systemd/user"
SYSTEMD_SERVICE="${SYSTEMD_SERVICE_DIR}/sleepycode-watchdog.service"
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
        echo "cron"
    fi
}

SCHEDULER="$(detect_scheduler)"
info "Detected scheduler: ${SCHEDULER}"

# =============================================================================
# systemd (Linux with user-level systemd)
# =============================================================================
install_systemd() {
    info "Installing systemd user service (persistent daemon)..."
    mkdir -p "${SYSTEMD_SERVICE_DIR}"

    # Long-running daemon: systemd restarts it on failure automatically
    cat > "${SYSTEMD_SERVICE}" <<EOF
[Unit]
Description=SleepyCode Watchdog
After=network.target

[Service]
Type=simple
WorkingDirectory=${SCRIPT_DIR}
ExecStart=python3 ${WATCHDOG_PATH}
Restart=on-failure
RestartSec=10
StandardOutput=append:${LOG_PATH}
StandardError=append:${LOG_PATH}

[Install]
WantedBy=default.target
EOF

    # Inject API keys if present in current environment.
    # Can also be set later with: systemctl --user set-environment DEEPSEEK_API_KEY=sk-...
    if [[ -n "${DEEPSEEK_API_KEY:-}" ]]; then
        echo "Environment=DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY}" >> "${SYSTEMD_SERVICE}"
    else
        warn "DEEPSEEK_API_KEY is not set in your environment."
        warn "Set it with:  systemctl --user set-environment DEEPSEEK_API_KEY=<your-key>"
    fi
    if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
        echo "Environment=ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}" >> "${SYSTEMD_SERVICE}"
    fi

    info "Reloading systemd user daemon..."
    systemctl --user daemon-reload

    info "Enabling and starting service..."
    systemctl --user enable --now sleepycode-watchdog

    echo ""
    echo "Installation complete (systemd)."
    echo "Service status:"
    systemctl --user status sleepycode-watchdog --no-pager || true
    echo ""
    echo "Logs:  tail -f ${LOG_PATH}"
    echo "Stop:  systemctl --user stop sleepycode-watchdog"
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
    <string>${LOG_PATH}</string>

    <key>StandardErrorPath</key>
    <string>${LOG_PATH}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>DEEPSEEK_API_KEY</key>
        <string>${DEEPSEEK_API_KEY:-}</string>
        <key>ANTHROPIC_API_KEY</key>
        <string>${ANTHROPIC_API_KEY:-}</string>
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
    echo "Logs:  tail -f ${LOG_PATH}"
    echo "Stop:  launchctl unload ${LAUNCHD_PLIST}"
}

# =============================================================================
# cron (fallback)
# =============================================================================
install_cron() {
    info "Installing cron job (fallback — minimum interval is 1 minute)..."

    CRON_LINE="*/1 * * * * cd ${SCRIPT_DIR} && python3 ${WATCHDOG_PATH} >> ${LOG_PATH} 2>&1 ${CRON_MARKER}"

    if crontab -l 2>/dev/null | grep -qF "${CRON_MARKER}"; then
        warn "Cron entry already exists. Skipping. Run ./uninstall.sh first to reinstall."
        return 0
    fi

    ( crontab -l 2>/dev/null; echo "${CRON_LINE}" ) | crontab -

    echo ""
    echo "Installation complete (cron)."
    echo ""
    echo "Added cron entry:"
    echo "  ${CRON_LINE}"
    echo ""
    echo "NOTE: cron fires at most once per minute."
    echo "      The watchdog polls internally at the interval in config.json."
    echo "Logs: tail -f ${LOG_PATH}"
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

echo "${SCHEDULER}" > "${STATE_DIR}/scheduler"
info "Scheduler type saved to ${STATE_DIR}/scheduler"
