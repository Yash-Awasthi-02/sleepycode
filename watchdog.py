"""
watchdog.py — External daemon for SleepyCode autonomous Claude Code orchestration.

Runs as an independent process alongside a tmux session running Claude Code.
Polls the tmux pane every N seconds, detects state transitions, and injects
the appropriate response so Claude Code never gets stuck unattended.

Architecture
------------
- Reads terminal output via:    tmux capture-pane -p -t {SESSION}
- Injects input via:            tmux send-keys -t {SESSION} "text" Enter
- Persistent state:             .sleepycode/state.json
- Lock file (PID-based):        .sleepycode/watchdog.lock
- Config:                       config.json  (same directory as this script)
- Log file:                     watchdog.log (same directory as this script)

State detection priority (highest → lowest)
-------------------------------------------
1. credit_exhausted  — billing / quota keywords
2. api_error         — 5xx / rate-limit / network keywords
3. work_done         — completion phrases
4. needs_input       — output ends with a question or prompt
5. running           — default; do nothing

Dependencies: Python 3.8+ stdlib only. No pip packages required.
"""

import hashlib
import json
import logging
import os
import signal
import subprocess
import sys
import time

# ---------------------------------------------------------------------------
# Script-level paths
# ---------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.json")
LOG_PATH = os.path.join(SCRIPT_DIR, "watchdog.log")

# Ensure brain.py is importable regardless of where watchdog is invoked from
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)
STATE_DIR = os.path.join(os.getcwd(), ".sleepycode")
STATE_PATH = os.path.join(STATE_DIR, "state.json")
LOCK_PATH = os.path.join(STATE_DIR, "watchdog.lock")

# ---------------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.FileHandler(LOG_PATH, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("sleepycode.watchdog")

# ---------------------------------------------------------------------------
# State detection keyword sets (all lowercase for case-insensitive matching)
# ---------------------------------------------------------------------------

# Defaults — overridden at runtime by config.json values in load_config()
CREDIT_EXHAUSTED_KEYWORDS: frozenset = frozenset([
    "credit", "billing", "insufficient fund", "payment required",
    "quota exceeded", "usage limit", "top up", "topup",
    "out of credits", "balance",
])

API_ERROR_KEYWORDS: frozenset = frozenset([
    "error 500", "error 503", "error 529", "error 502", "error 429",
    "rate limit", "overloaded", "server error", "bad gateway",
    "connection refused", "timeout", "api error",
])

WORK_DONE_PHRASES: frozenset = frozenset([
    "all tasks complete", "all done", "work is complete",
    "implementation complete", "everything is done", "finished everything",
    "completed all", "nothing left to do",
])

# Lines that end with these strings indicate Claude Code is waiting for input
NEEDS_INPUT_SUFFIXES = ("?", "[y/n]", "(y/n)", "choose", "select", "proceed?", "continue?")

# Prompt sent to Claude Code when work_done is detected
WRAP_PROMPT = (
    "Before we wrap this session: "
    "1) Create or update progress.md with what was completed, current state, "
    "roadmap with [ ] checkboxes, and exact next steps. "
    "2) Then tell me: should we use /compact (ongoing work) or /clear (fresh start)?"
)

# ---------------------------------------------------------------------------
# Config loading
# ---------------------------------------------------------------------------

def load_config() -> dict:
    """
    Load config.json from the script directory.

    Required keys:
        session_name      — tmux session/pane target (e.g. "work" or "work:0.0")
        deepseek_api_key  — DeepSeek API key

    Optional keys:
        poll_interval     — seconds between checks (default: 10)
        roadmap_files     — list of filenames to check for roadmap (overrides brain defaults)
        project_dir       — project root to look for roadmap files (default: cwd)
    """
    if not os.path.isfile(CONFIG_PATH):
        logger.error("Config file not found: %s", CONFIG_PATH)
        sys.exit(1)
    with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)

    required = ("session_name",)
    missing = [k for k in required if not cfg.get(k)]
    if missing:
        logger.error("Config missing required keys: %s", missing)
        sys.exit(1)

    # Resolve DeepSeek API key: env var takes priority, config is fallback
    cfg["deepseek_api_key"] = (
        os.environ.get("DEEPSEEK_API_KEY", "")
        or cfg.get("deepseek_api_key", "")
    )
    if not cfg["deepseek_api_key"]:
        logger.warning(
            "DEEPSEEK_API_KEY not set and not in config.json — "
            "AI responses will fall back to 'y'"
        )

    cfg.setdefault("poll_interval", 10)
    cfg.setdefault("project_dir", os.getcwd())

    # Override module-level keyword sets with config.json values if present
    global CREDIT_EXHAUSTED_KEYWORDS, API_ERROR_KEYWORDS, WORK_DONE_PHRASES
    if cfg.get("credit_signals"):
        CREDIT_EXHAUSTED_KEYWORDS = frozenset(cfg["credit_signals"])
    if cfg.get("api_error_signals"):
        API_ERROR_KEYWORDS = frozenset(cfg["api_error_signals"])
    if cfg.get("work_done_signals"):
        WORK_DONE_PHRASES = frozenset(cfg["work_done_signals"])

    return cfg


# ---------------------------------------------------------------------------
# Persistent state helpers
# ---------------------------------------------------------------------------

def ensure_state_dir() -> None:
    os.makedirs(STATE_DIR, exist_ok=True)


def load_state() -> dict:
    ensure_state_dir()
    if os.path.isfile(STATE_PATH):
        try:
            with open(STATE_PATH, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("Could not read state file (%s), starting fresh", exc)
    return {
        "post_done": False,       # True after work_done handler fires; waiting for compact/clear
        "retry_count": 0,         # consecutive api_error retries
        "last_hash": "",          # SHA-256 of last pane snapshot
        "post_done_ts": 0.0,      # epoch time when post_done was set
    }


def save_state(state: dict) -> None:
    ensure_state_dir()
    with open(STATE_PATH, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)


# ---------------------------------------------------------------------------
# Lock file helpers (PID-based)
# ---------------------------------------------------------------------------

def acquire_lock() -> bool:
    """
    Try to acquire the watchdog lock.

    Writes the current PID to LOCK_PATH. If a lock file already exists and its
    PID corresponds to a running process, returns False (another instance is
    alive). Stale locks (process dead) are removed automatically.

    Returns True if the lock was acquired, False otherwise.
    """
    ensure_state_dir()
    if os.path.isfile(LOCK_PATH):
        try:
            with open(LOCK_PATH, "r") as fh:
                existing_pid = int(fh.read().strip())
            # Check if that process is still alive
            os.kill(existing_pid, 0)  # raises OSError if dead
            logger.warning(
                "Another watchdog instance is running (PID %d). Exiting.", existing_pid
            )
            return False
        except (OSError, ValueError):
            logger.info("Stale lock file found (PID gone), removing.")
            os.remove(LOCK_PATH)

    with open(LOCK_PATH, "w") as fh:
        fh.write(str(os.getpid()))
    return True


def release_lock() -> None:
    try:
        os.remove(LOCK_PATH)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# tmux interface
# ---------------------------------------------------------------------------

def tmux_capture(session: str, lines: int = 60) -> str:
    """
    Capture the last `lines` lines from the tmux pane.
    Returns the output as a string (empty string on failure).
    """
    try:
        result = subprocess.run(
            ["tmux", "capture-pane", "-p", "-t", session],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            logger.warning("tmux capture-pane exited %d: %s", result.returncode, result.stderr.strip())
            return ""
        # Return only the last N lines
        captured = result.stdout
        output_lines = captured.splitlines()
        return "\n".join(output_lines[-lines:])
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        logger.error("tmux capture failed: %s", exc)
        return ""


def tmux_send(session: str, text: str) -> None:
    """
    Send `text` to the tmux pane followed by Enter.
    """
    try:
        subprocess.run(
            ["tmux", "send-keys", "-t", session, text, "Enter"],
            check=True,
            timeout=5,
        )
        logger.info("tmux_send -> %r", text[:120])  # truncate long prompts in log
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        logger.error("tmux send-keys failed: %s", exc)


# ---------------------------------------------------------------------------
# State detection
# ---------------------------------------------------------------------------

def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def detect_state(output: str, post_done: bool) -> str:
    """
    Classify the current pane output into one of:
        credit_exhausted | api_error | work_done | needs_input | running

    If post_done is True (we already sent the wrap prompt), we check for
    compact/clear response instead — returns "post_done_wait" so the caller
    handles it separately.
    """
    lower = output.lower()

    # Special case: we're waiting for Claude to tell us compact vs clear
    if post_done:
        return "post_done_wait"

    # 1. Credit exhausted (highest priority — must rotate key first)
    if any(kw in lower for kw in CREDIT_EXHAUSTED_KEYWORDS):
        return "credit_exhausted"

    # 2. API / infrastructure error
    if any(kw in lower for kw in API_ERROR_KEYWORDS):
        return "api_error"

    # 3. Work done
    if any(phrase in lower for phrase in WORK_DONE_PHRASES):
        return "work_done"

    # 4. Waiting for input — check last non-empty line
    last_line = ""
    for line in reversed(output.splitlines()):
        stripped = line.strip()
        if stripped:
            last_line = stripped.lower()
            break

    if last_line and any(last_line.endswith(sfx.lower()) for sfx in NEEDS_INPUT_SUFFIXES):
        return "needs_input"

    return "running"


# ---------------------------------------------------------------------------
# Action handlers
# ---------------------------------------------------------------------------

def handle_credit_exhausted(session: str, state: dict) -> None:
    """Rotate API key via 'kr rotate', confirm with 'y', then pause for recovery."""
    logger.info("STATE: credit_exhausted — rotating API key")
    tmux_send(session, "kr rotate")
    time.sleep(3)
    tmux_send(session, "y")
    logger.info("Key rotation initiated.")
    # Extra sleep handled by the caller (post-action delay)
    time.sleep(10)


def handle_api_error(session: str, state: dict, cfg: dict) -> None:
    """
    Wait briefly then send retry/resume. Back off heavily after max_retries consecutive errors.
    """
    retry_wait     = cfg.get("retry_wait", 8)
    max_retries    = cfg.get("max_retries", 5)
    rate_limit_wait = cfg.get("rate_limit_wait", 300)

    state["retry_count"] = state.get("retry_count", 0) + 1
    retry_count = state["retry_count"]
    logger.info("STATE: api_error (retry #%d)", retry_count)

    if retry_count > max_retries:
        logger.warning(
            "Too many consecutive API errors (%d). Backing off %ds.", retry_count, rate_limit_wait
        )
        time.sleep(rate_limit_wait)
        state["retry_count"] = 0
    else:
        time.sleep(retry_wait)
        tmux_send(session, "retry")
        time.sleep(2)
        tmux_send(session, "resume")

    save_state(state)


def handle_work_done(session: str, state: dict) -> None:
    """
    Send the wrap-up prompt asking Claude to write progress.md and decide
    on /compact vs /clear. Sets post_done=True so next poll checks for response.
    """
    logger.info("STATE: work_done — sending wrap-up prompt")
    tmux_send(session, WRAP_PROMPT)
    state["post_done"] = True
    state["post_done_ts"] = time.time()
    save_state(state)


def handle_post_done_wait(session: str, state: dict, output: str, cfg: dict) -> None:
    """
    We sent the wrap-up prompt; now we're waiting for Claude to respond.
    After 30 seconds we check for compact/clear keywords in the output.
    If not found, ask DeepSeek to decide. Then send the command and continue.
    """
    elapsed = time.time() - state.get("post_done_ts", 0.0)
    if elapsed < 30:
        logger.debug("post_done_wait: only %.1fs elapsed, waiting for Claude response", elapsed)
        return

    logger.info("post_done_wait: 30s elapsed, checking for compact/clear in output")
    lower = output.lower()

    if "compact" in lower and "clear" not in lower:
        decision = "compact"
    elif "clear" in lower and "compact" not in lower:
        decision = "clear"
    else:
        logger.info("post_done_wait: ambiguous output, consulting DeepSeek")
        from brain import ask_compact_or_clear  # noqa: PLC0415
        decision = ask_compact_or_clear(
            output,
            api_key=cfg.get("deepseek_api_key", ""),
            model=cfg.get("deepseek_model", "deepseek-chat"),
        )

    logger.info("post_done_wait: sending /%s", decision)
    tmux_send(session, f"/{decision}")
    time.sleep(3)
    tmux_send(session, "continue")

    # Clear the post_done flag — session management complete
    state["post_done"] = False
    state["post_done_ts"] = 0.0
    state["retry_count"] = 0
    save_state(state)


def handle_needs_input(session: str, state: dict, output: str, cfg: dict) -> None:
    """
    Ask DeepSeek what to respond to the prompt Claude Code is showing.
    Injects the response back into the tmux pane.
    """
    logger.info("STATE: needs_input — consulting DeepSeek brain")
    from brain import ask_deepseek, load_roadmap  # noqa: PLC0415

    api_key      = cfg.get("deepseek_api_key", "")
    model        = cfg.get("deepseek_model", "deepseek-chat")
    project_dir  = cfg.get("project_dir", os.getcwd())
    roadmap      = load_roadmap(project_dir)

    # Extract the specific question from the last non-empty line
    question = ""
    for line in reversed(output.splitlines()):
        stripped = line.strip()
        if stripped:
            question = stripped
            break

    response = ask_deepseek(
        context=output,
        question=question,
        roadmap=roadmap,
        api_key=api_key,
        model=model,
    )
    logger.info("needs_input: sending response %r", response)
    tmux_send(session, response)
    state["retry_count"] = 0
    save_state(state)


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def run_watchdog(config: dict) -> None:
    """
    Main polling loop. Runs until interrupted (SIGINT / SIGTERM).
    """
    session       = config["session_name"]
    poll_interval = config["poll_interval"]

    state = load_state()
    logger.info(
        "Watchdog started. Session=%r poll_interval=%ds PID=%d",
        session, poll_interval, os.getpid(),
    )

    def _shutdown(signum, frame):  # noqa: ANN001
        logger.info("Received signal %d, shutting down.", signum)
        release_lock()
        sys.exit(0)

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    while True:
        try:
            output = tmux_capture(session)

            if not output:
                logger.debug("Empty pane capture, skipping.")
                time.sleep(poll_interval)
                continue

            current_hash = sha256(output)
            content_changed = current_hash != state.get("last_hash", "")

            # Always act if content changed or if we're in a special waiting state
            if not content_changed and not state.get("post_done", False):
                logger.debug("No change in pane output, skipping.")
                time.sleep(poll_interval)
                continue

            # Update hash before acting to avoid re-acting on same content
            state["last_hash"] = current_hash

            detected = detect_state(output, state.get("post_done", False))
            logger.info("Detected state: %s (changed=%s)", detected, content_changed)

            if detected == "credit_exhausted":
                handle_credit_exhausted(session, state)
                # credit_exhausted resets retry counter — it's a different failure class
                state["retry_count"] = 0
                save_state(state)

            elif detected == "api_error":
                handle_api_error(session, state, config)

            elif detected == "work_done":
                handle_work_done(session, state)

            elif detected == "post_done_wait":
                handle_post_done_wait(session, state, output, config)

            elif detected == "needs_input":
                handle_needs_input(session, state, output, config)

            elif detected == "running":
                # Claude Code is actively working — reset error counter, do nothing
                if state.get("retry_count", 0) > 0:
                    logger.debug("Back to running, resetting retry_count.")
                    state["retry_count"] = 0
                    save_state(state)
                logger.debug("Running normally.")

            else:
                logger.warning("Unknown state %r — ignoring.", detected)

        except Exception as exc:  # noqa: BLE001
            # Never crash the daemon; log and keep polling
            logger.exception("Unhandled exception in main loop: %s", exc)

        time.sleep(poll_interval)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    if not acquire_lock():
        sys.exit(1)

    try:
        config = load_config()
        run_watchdog(config)
    finally:
        release_lock()


if __name__ == "__main__":
    main()
