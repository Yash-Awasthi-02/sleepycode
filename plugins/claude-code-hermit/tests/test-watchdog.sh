#!/usr/bin/env bash
# Tests for hermit-watchdog.py — single-shot watchdog decision flow.
# Uses a fake tmux + fake pgrep on PATH to drive each branch without live sessions.
# Usage: bash tests/test-watchdog.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

echo "=== hermit-watchdog.py ==="
echo ""

WATCHDOG="$REPO_ROOT/scripts/hermit-watchdog.py"

# Helper: create a standard hermit project fixture under $workdir.
# Sets CONFIG, STATE, RUNTIME vars.
setup_hermit() {
  workdir="$(mktemp -d)"
  mkdir -p "$workdir/.claude-code-hermit/state"
  mkdir -p "$workdir/.claude-code-hermit/bin"

  # Minimal runtime.json: in_progress always-on session
  cat > "$workdir/.claude-code-hermit/state/runtime.json" <<'RTEOF'
{
  "version": 1,
  "session_state": "in_progress",
  "runtime_mode": "tmux",
  "tmux_session": "hermit-test",
  "shutdown_requested_at": null,
  "shutdown_completed_at": null,
  "last_error": null,
  "updated_at": "2026-01-01T00:00:00+0000"
}
RTEOF

  # Stub hermit-start: writes a marker so we can detect invocation
  cat > "$workdir/.claude-code-hermit/bin/hermit-start" <<STARTEOF
#!/usr/bin/env bash
echo "hermit-start called" > "$workdir/hermit-start-called"
STARTEOF
  chmod +x "$workdir/.claude-code-hermit/bin/hermit-start"

  # Stub bin dir on PATH for fake tmux + pgrep
  FAKE_BIN="$workdir/fake-bin"
  mkdir -p "$FAKE_BIN"
  echo "$workdir"
}

write_config() {
  local workdir="$1"
  local extra="${2:-}"
  cat > "$workdir/.claude-code-hermit/config.json" <<CFEOF
{
  "watchdog": {
    "enabled": true,
    "stale_factor": 2,
    "escalate_after": 3,
    "operator_grace": "15m"
  },
  "heartbeat": {
    "enabled": true,
    "every": "2h",
    "active_hours": {"start": "00:00", "end": "23:59"},
    "stale_threshold": "2h"
  }
  ${extra}
}
CFEOF
}

write_fake_tmux() {
  local bin_dir="$1"
  local session_alive="$2"   # 0 = alive, 1 = dead
  local pane_content="${3:-tmux pane content}"
  cat > "$bin_dir/tmux" <<TMUXEOF
#!/usr/bin/env bash
case "\$1" in
  has-session) exit $session_alive ;;
  capture-pane) echo "$pane_content" ;;
  send-keys) echo "send-keys \$@" >> "$bin_dir/../tmux-calls.log" ;;
  kill-session) echo "kill-session \$@" >> "$bin_dir/../tmux-calls.log" ;;
esac
TMUXEOF
  chmod +x "$bin_dir/tmux"
}

write_fake_pgrep() {
  local bin_dir="$1"
  local found="$2"   # 0 = found, 1 = not found
  cat > "$bin_dir/pgrep" <<PGREPEOF
#!/usr/bin/env bash
exit $found
PGREPEOF
  chmod +x "$bin_dir/pgrep"
}

# -------------------------------------------------------
# 1. Config gate: watchdog.enabled false → no-op
# -------------------------------------------------------
workdir="$(setup_hermit)"
cat > "$workdir/.claude-code-hermit/config.json" <<'CFEOF'
{"watchdog": {"enabled": false}}
CFEOF
write_fake_tmux "$workdir/fake-bin" 0
write_fake_pgrep "$workdir/fake-bin" 1
run_test "watchdog disabled → exit 0, no events" bash -c \
  "cd '$workdir' && PATH='$workdir/fake-bin:$PATH' python3 '$WATCHDOG' run && \
   [ ! -f '$workdir/.claude-code-hermit/state/watchdog-events.jsonl' ]"
cleanup

# -------------------------------------------------------
# 2. Shutdown gate: session_state idle → no-op
# -------------------------------------------------------
workdir="$(setup_hermit)"
write_config "$workdir"
jq '.session_state = "idle"' \
  "$workdir/.claude-code-hermit/state/runtime.json" > /tmp/rt.json && \
  mv /tmp/rt.json "$workdir/.claude-code-hermit/state/runtime.json"
write_fake_tmux "$workdir/fake-bin" 0
write_fake_pgrep "$workdir/fake-bin" 1
run_test "idle session → exit 0, no events" bash -c \
  "cd '$workdir' && PATH='$workdir/fake-bin:$PATH' python3 '$WATCHDOG' run && \
   [ ! -f '$workdir/.claude-code-hermit/state/watchdog-events.jsonl' ]"
cleanup

# -------------------------------------------------------
# 3. Shutdown gate: shutdown_completed_at set → no-op
# -------------------------------------------------------
workdir="$(setup_hermit)"
write_config "$workdir"
jq '.shutdown_completed_at = "2026-06-10T04:00:00Z"' \
  "$workdir/.claude-code-hermit/state/runtime.json" > /tmp/rt.json && \
  mv /tmp/rt.json "$workdir/.claude-code-hermit/state/runtime.json"
write_fake_tmux "$workdir/fake-bin" 0
write_fake_pgrep "$workdir/fake-bin" 1
run_test "shutdown_completed_at set → exit 0, no events" bash -c \
  "cd '$workdir' && PATH='$workdir/fake-bin:$PATH' python3 '$WATCHDOG' run && \
   [ ! -f '$workdir/.claude-code-hermit/state/watchdog-events.jsonl' ]"
cleanup

# -------------------------------------------------------
# 4. Interactive mode → skip
# -------------------------------------------------------
workdir="$(setup_hermit)"
write_config "$workdir"
jq '.runtime_mode = "interactive"' \
  "$workdir/.claude-code-hermit/state/runtime.json" > /tmp/rt.json && \
  mv /tmp/rt.json "$workdir/.claude-code-hermit/state/runtime.json"
write_fake_tmux "$workdir/fake-bin" 0
write_fake_pgrep "$workdir/fake-bin" 1
run_test "interactive mode → exit 0, no events" bash -c \
  "cd '$workdir' && PATH='$workdir/fake-bin:$PATH' python3 '$WATCHDOG' run && \
   [ ! -f '$workdir/.claude-code-hermit/state/watchdog-events.jsonl' ]"
cleanup

# -------------------------------------------------------
# 5. Dead session → restart
# -------------------------------------------------------
workdir="$(setup_hermit)"
write_config "$workdir"
# tmux has-session returns 1 (dead)
write_fake_tmux "$workdir/fake-bin" 1
write_fake_pgrep "$workdir/fake-bin" 1
run_test "dead session → restart event written" bash -c \
  "cd '$workdir' && PATH='$workdir/fake-bin:$PATH' python3 '$WATCHDOG' run && \
   grep -q 'restart' '$workdir/.claude-code-hermit/state/watchdog-events.jsonl'"
run_test "dead session → restart reason dead-process" bash -c \
  "grep -q 'dead-process' '$workdir/.claude-code-hermit/state/watchdog-events.jsonl'"
run_test "dead session → runtime.json last_error set" bash -c \
  "python3 -c \"
import json
d=json.load(open('$workdir/.claude-code-hermit/state/runtime.json'))
assert d.get('last_error')=='unclean_shutdown', 'last_error: '+repr(d.get('last_error'))
assert d.get('watchdog_restart_reason')=='dead-process', 'reason: '+repr(d.get('watchdog_restart_reason'))
\""
cleanup

# -------------------------------------------------------
# 6. Alive + operator recent → back off (no events)
# -------------------------------------------------------
workdir="$(setup_hermit)"
write_config "$workdir"
# Touch .heartbeat with mtime 6h ago (stale — threshold is 2h*2=4h)
python3 -c "
import os, time
p = '$workdir/.claude-code-hermit/state/.heartbeat'
open(p,'w').close()
t = time.time() - 6*3600
os.utime(p, (t, t))
"
# operator action 5 minutes ago (within 15m grace)
python3 -c "
import json, datetime, pathlib
p = pathlib.Path('$workdir/.claude-code-hermit/state/last-operator-action.json')
at = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=5)).isoformat()
p.write_text(json.dumps({'at': at})+'\n')
"
write_fake_tmux "$workdir/fake-bin" 0
write_fake_pgrep "$workdir/fake-bin" 1
run_test "stale + operator recent → no events" bash -c \
  "cd '$workdir' && PATH='$workdir/fake-bin:$PATH' python3 '$WATCHDOG' run && \
   [ ! -f '$workdir/.claude-code-hermit/state/watchdog-events.jsonl' ]"
run_test "stale + operator recent → consecutive reset to 0" bash -c \
  "python3 -c \"
import json
d=json.load(open('$workdir/.claude-code-hermit/state/watchdog-state.json'))
assert d.get('consecutive_stale')==0, repr(d.get('consecutive_stale'))
\""
cleanup

# -------------------------------------------------------
# 7. Alive + stale + operator silent → nudge on cycle 1
# -------------------------------------------------------
workdir="$(setup_hermit)"
write_config "$workdir"
python3 -c "
import os, time
p = '$workdir/.claude-code-hermit/state/.heartbeat'
open(p,'w').close()
t = time.time() - 6*3600
os.utime(p, (t, t))
"
# No last-operator-action.json (operator silent)
write_fake_tmux "$workdir/fake-bin" 0 "some pane content"
# pgrep returns 1 = monitor not running (wedge signal)
write_fake_pgrep "$workdir/fake-bin" 1
run_test "stale + operator silent → nudge event written" bash -c \
  "cd '$workdir' && PATH='$workdir/fake-bin:$PATH' python3 '$WATCHDOG' run && \
   grep -q 'nudge' '$workdir/.claude-code-hermit/state/watchdog-events.jsonl'"
run_test "nudge cycle 1 → consecutive_stale = 1" bash -c \
  "python3 -c \"
import json
d=json.load(open('$workdir/.claude-code-hermit/state/watchdog-state.json'))
assert d.get('consecutive_stale')==1, repr(d.get('consecutive_stale'))
\""
run_test "nudge cycle 1 → send-keys called" bash -c \
  "grep -q 'send-keys' '$workdir/tmux-calls.log'"
cleanup

# -------------------------------------------------------
# 8. Escalation after escalate_after cycles (pane frozen + monitor dead)
# -------------------------------------------------------
workdir="$(setup_hermit)"
write_config "$workdir"
python3 -c "
import os, time
p = '$workdir/.claude-code-hermit/state/.heartbeat'
open(p,'w').close()
t = time.time() - 6*3600
os.utime(p, (t, t))
"
# Fake tmux pane content — echo adds a trailing newline, so hash must match that
PANE_CONTENT="frozen pane"
# echo "frozen pane" outputs "frozen pane\n"; hash must include the newline
FROZEN_HASH="$(python3 -c "import hashlib; print(hashlib.sha256(b'${PANE_CONTENT}\n').hexdigest())")"
python3 -c "
import json, pathlib
p = pathlib.Path('$workdir/.claude-code-hermit/state/watchdog-state.json')
p.write_text(json.dumps({'consecutive_stale': 2, 'last_pane_hash': '$FROZEN_HASH', 'last_nudge_at': '2026-01-01T00:00:00Z'})+'\n')
"
# Fake tmux: session alive, pane returns same content → same hash
write_fake_tmux "$workdir/fake-bin" 0 "$PANE_CONTENT"
# pgrep returns 1 = monitor not running
write_fake_pgrep "$workdir/fake-bin" 1
run_test "escalation at cycle 3 (pane frozen + monitor dead) → restart" bash -c \
  "cd '$workdir' && PATH='$workdir/fake-bin:$PATH' python3 '$WATCHDOG' run && \
   grep -q 'restart' '$workdir/.claude-code-hermit/state/watchdog-events.jsonl'"
run_test "escalation reason is pane-frozen" bash -c \
  "grep -q 'pane-frozen' '$workdir/.claude-code-hermit/state/watchdog-events.jsonl'"
cleanup

# -------------------------------------------------------
# 9. Alive + pane changed → nudge (not restart), even at escalate_after cycles
# -------------------------------------------------------
workdir="$(setup_hermit)"
write_config "$workdir"
python3 -c "
import os, time
p = '$workdir/.claude-code-hermit/state/.heartbeat'
open(p,'w').close()
t = time.time() - 6*3600
os.utime(p, (t, t))
"
# State shows 2 prior stale cycles with old hash
python3 -c "
import json, pathlib
p = pathlib.Path('$workdir/.claude-code-hermit/state/watchdog-state.json')
p.write_text(json.dumps({'consecutive_stale': 2, 'last_pane_hash': 'old-hash-abc', 'last_nudge_at': '2026-01-01T00:00:00Z'})+'\n')
"
# Fake tmux returns DIFFERENT pane content → different hash
write_fake_tmux "$workdir/fake-bin" 0 "new pane content different from old"
write_fake_pgrep "$workdir/fake-bin" 1
run_test "pane changed at cycle 3 → nudge (not restart)" bash -c \
  "cd '$workdir' && PATH='$workdir/fake-bin:$PATH' python3 '$WATCHDOG' run && \
   grep -q 'nudge' '$workdir/.claude-code-hermit/state/watchdog-events.jsonl' && \
   ! grep -q 'restart' '$workdir/.claude-code-hermit/state/watchdog-events.jsonl'"
cleanup

# -------------------------------------------------------
# 10. Re-arm fallback: heartbeat-restart not fired in > 26h
# -------------------------------------------------------
workdir="$(setup_hermit)"
write_config "$workdir"
# Recent .heartbeat so wedge detection is skipped
python3 -c "
import os, time
p = '$workdir/.claude-code-hermit/state/.heartbeat'
open(p,'w').close()
# 30 minutes ago — well within 4h stale_factor threshold
t = time.time() - 1800
os.utime(p, (t, t))
"
# routine-metrics.jsonl: heartbeat-restart fired 28h ago
python3 -c "
import json, datetime, pathlib
p = pathlib.Path('$workdir/.claude-code-hermit/state/routine-metrics.jsonl')
ts = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=28)).strftime('%Y-%m-%dT%H:%M:%SZ')
p.write_text(json.dumps({'ts': ts, 'routine_id': 'heartbeat-restart', 'event': 'fired', 'delivery': 'cron-create'})+'\n')
"
write_fake_tmux "$workdir/fake-bin" 0
write_fake_pgrep "$workdir/fake-bin" 0
run_test "heartbeat-restart missed > 26h → re-arm-fallback event" bash -c \
  "cd '$workdir' && PATH='$workdir/fake-bin:$PATH' python3 '$WATCHDOG' run && \
   grep -q 're-arm-fallback' '$workdir/.claude-code-hermit/state/watchdog-events.jsonl'"
cleanup

# -------------------------------------------------------
# 11. Re-arm suppressed: heartbeat-restart fired < 26h ago
# -------------------------------------------------------
workdir="$(setup_hermit)"
write_config "$workdir"
python3 -c "
import os, time
p = '$workdir/.claude-code-hermit/state/.heartbeat'
open(p,'w').close()
t = time.time() - 1800
os.utime(p, (t, t))
"
# fired 2h ago — within the 26h window
python3 -c "
import json, datetime, pathlib
p = pathlib.Path('$workdir/.claude-code-hermit/state/routine-metrics.jsonl')
ts = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%SZ')
p.write_text(json.dumps({'ts': ts, 'routine_id': 'heartbeat-restart', 'event': 'fired', 'delivery': 'cron-create'})+'\n')
"
write_fake_tmux "$workdir/fake-bin" 0
write_fake_pgrep "$workdir/fake-bin" 0
run_test "heartbeat-restart fired < 26h → no re-arm" bash -c \
  "cd '$workdir' && PATH='$workdir/fake-bin:$PATH' python3 '$WATCHDOG' run && \
   [ ! -f '$workdir/.claude-code-hermit/state/watchdog-events.jsonl' ]"
cleanup

# -------------------------------------------------------
# 12. checkWatchdog in doctor-check.js: disabled → ok
# -------------------------------------------------------
workdir="$(setup_hermit)"
cat > "$workdir/.claude-code-hermit/config.json" <<'CFEOF'
{
  "watchdog": {"enabled": false},
  "agent_name": null,
  "language": null,
  "timezone": null,
  "escalation": "balanced",
  "channels": {},
  "env": {},
  "heartbeat": {"enabled": true, "every": "2h"},
  "routines": [],
  "quality_gate": {"tier": "budget"}
}
CFEOF
run_test "doctor checkWatchdog: disabled → ok" bash -c "
cd '$workdir' && node '$REPO_ROOT/scripts/doctor-check.js' 2>/dev/null | \
  python3 -c \"
import json,sys
d=json.load(sys.stdin)
w=[c for c in d.get('checks',[]) if c['id']=='watchdog']
assert w, 'watchdog check missing'
assert w[0]['status']=='ok', 'status: '+w[0]['status']
assert 'disabled' in w[0]['detail'], 'detail: '+w[0]['detail']
\""
cleanup

# -------------------------------------------------------
# 13. checkWatchdog: enabled + recent restart → warn
# -------------------------------------------------------
workdir="$(setup_hermit)"
cat > "$workdir/.claude-code-hermit/config.json" <<'CFEOF'
{
  "watchdog": {"enabled": true, "stale_factor": 2, "escalate_after": 3, "operator_grace": "15m"},
  "agent_name": null,
  "language": null,
  "timezone": null,
  "escalation": "balanced",
  "channels": {},
  "env": {},
  "heartbeat": {"enabled": true, "every": "2h"},
  "routines": [],
  "quality_gate": {"tier": "budget"}
}
CFEOF
python3 -c "
import json, datetime, pathlib
p = pathlib.Path('$workdir/.claude-code-hermit/state/watchdog-events.jsonl')
ts = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
p.write_text(json.dumps({'ts': ts, 'action': 'restart', 'reason': 'dead-process'})+'\n')
"
run_test "doctor checkWatchdog: restart in last 7d → warn" bash -c "
cd '$workdir' && node '$REPO_ROOT/scripts/doctor-check.js' 2>/dev/null | \
  python3 -c \"
import json,sys
d=json.load(sys.stdin)
w=[c for c in d.get('checks',[]) if c['id']=='watchdog']
assert w, 'watchdog check missing'
assert w[0]['status']=='warn', 'status: '+w[0]['status']
\""
cleanup

# -------------------------------------------------------
# install / uninstall without systemctl (Linux-only path)
# -------------------------------------------------------
if [ "$(uname -s)" = "Linux" ]; then

workdir="$(setup_hermit)"
write_config "$workdir"
# fake-bin has tmux/pgrep stubs but no systemctl — simulates systemd-less host
write_fake_tmux "$workdir/fake-bin" 0
write_fake_pgrep "$workdir/fake-bin" 1
run_test "install without systemctl → exit 0, prints crontab, no traceback" bash -c "
  cd '$workdir'
  out=\$(PATH='$workdir/fake-bin' '$(command -v python3)' '$WATCHDOG' install 2>&1)
  echo \"\$out\"
  echo \"\$out\" | grep -q 'crontab' || { echo 'FAIL: expected crontab guidance'; exit 1; }
  echo \"\$out\" | grep -q 'Traceback' && { echo 'FAIL: got traceback'; exit 1; }
  true"
cleanup

workdir="$(setup_hermit)"
write_config "$workdir"
write_fake_tmux "$workdir/fake-bin" 0
write_fake_pgrep "$workdir/fake-bin" 1
run_test "uninstall without systemctl → exit 0, no traceback" bash -c "
  cd '$workdir'
  out=\$(PATH='$workdir/fake-bin' '$(command -v python3)' '$WATCHDOG' uninstall 2>&1)
  echo \"\$out\"
  echo \"\$out\" | grep -q 'Traceback' && { echo 'FAIL: got traceback'; exit 1; }
  true"
cleanup

fi  # Linux-only

print_results
