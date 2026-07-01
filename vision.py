"""
vision.py — AI-powered terminal state classifier for SleepyCode.

Replaces keyword matching with actual AI understanding of what's happening
in the Claude Code terminal session.

Modes (set via config.json vision.mode):
    screenshot      — Capture terminal screenshot → Claude vision API
    text_deepseek   — Send terminal text → DeepSeek (default, headless-safe)
    text_claude     — Send terminal text → Claude claude-3-5-haiku

Each mode falls back to the next if unavailable (missing key / headless / error).

Returns a dict with:
    state               — credit_exhausted | api_error | work_done |
                          needs_input | running | post_done_wait | unknown
    confidence          — float 0.0-1.0
    question            — the question Claude is asking (needs_input) or None
    suggested_response  — what to send back (needs_input) or None
    method              — which detection method was used
    reasoning           — one-sentence explanation
"""

import base64
import json
import logging
import os
import subprocess
import tempfile
import urllib.error
import urllib.request
from typing import Optional

logger = logging.getLogger("sleepycode.vision")

# ---------------------------------------------------------------------------
# Shared classification prompt
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """\
You are a terminal state classifier for an autonomous Claude Code orchestration system.

Given terminal output from a Claude Code session, classify the current state into exactly
one of these states:

1. credit_exhausted — Anthropic API credits are gone. Look for: "insufficient funds",
   "payment required", "quota exceeded", "out of credits", "usage limit reached", billing
   messages. FALSE POSITIVES to avoid: "give credit to the author", code variables named
   'credit', comments crediting someone — those are NOT credit_exhausted.

2. api_error — API / network error. Look for: HTTP 500/502/503/529/429 errors,
   "rate limit", "overloaded", "server error", "bad gateway", "connection refused".
   Do NOT classify on "timeout" alone — that often appears in test output.

3. work_done — Claude has finished the task. Look for: "all tasks complete",
   "implementation complete", "all done", "nothing left to do", "everything is done",
   "finished everything". Must be a genuine completion statement.

4. needs_input — Claude is waiting for a human response. Look for: a question mark at
   the end of the last meaningful line, [y/n] or (y/n) prompts, "choose:", "select:",
   "proceed?", "continue?", numbered menu options awaiting selection.

5. running — Claude Code is actively working. Most common state. No action needed.

6. post_done_wait — The orchestrator already sent the wrap-up prompt and is waiting
   for Claude's response about /compact vs /clear.

If none clearly applies, return state "unknown" so the system falls back to keyword matching.

Respond with ONLY valid JSON — no markdown, no explanation outside the JSON:
{
  "state": "<one of the 7 values above>",
  "confidence": <0.0-1.0>,
  "question": "<if needs_input: exact question being asked, else null>",
  "suggested_response": "<if needs_input: best response to inject, else null>",
  "reasoning": "<one sentence explaining your classification>"
}"""

VALID_STATES = frozenset([
    "credit_exhausted", "api_error", "work_done",
    "needs_input", "running", "post_done_wait", "unknown",
])

_FALLBACK: dict = {
    "state": "unknown",
    "confidence": 0.0,
    "question": None,
    "suggested_response": None,
    "method": "fallback",
    "reasoning": "All classification methods failed or were unavailable",
}


# ---------------------------------------------------------------------------
# Screenshot capture
# ---------------------------------------------------------------------------

def capture_screenshot() -> Optional[bytes]:
    """
    Capture a screenshot of the current display.

    Tries in order:
      macOS  — screencapture -x
      Linux  — scrot, then import (ImageMagick), then gnome-screenshot

    Returns raw PNG bytes, or None if headless / no tool available.
    """
    tmp = os.path.join(tempfile.gettempdir(), "sc_snap.png")

    _tools = [
        ["screencapture", "-x", tmp],          # macOS
        ["scrot", tmp],                         # Linux
        ["import", "-window", "root", tmp],     # ImageMagick
        ["gnome-screenshot", "-f", tmp],        # GNOME
    ]

    for cmd in _tools:
        try:
            res = subprocess.run(cmd, capture_output=True, timeout=10)
            if res.returncode == 0 and os.path.isfile(tmp):
                with open(tmp, "rb") as fh:
                    data = fh.read()
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                logger.debug("Screenshot captured via %s (%d bytes)", cmd[0], len(data))
                return data
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            continue

    logger.warning("Screenshot capture failed — no suitable tool found or headless environment")
    return None


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _post_json(url: str, headers: dict, payload: dict, timeout: int = 30) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    return json.loads(raw.decode("utf-8"))


def _strip_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        inner = lines[1:]
        if inner and inner[-1].strip() == "```":
            inner = inner[:-1]
        text = "\n".join(inner).strip()
    return text


def _validate(result: dict, method: str) -> dict:
    result.setdefault("confidence", 0.5)
    result.setdefault("question", None)
    result.setdefault("suggested_response", None)
    result.setdefault("reasoning", "")
    result["method"] = method
    if result.get("state") not in VALID_STATES:
        result["state"] = "unknown"
    return result


# ---------------------------------------------------------------------------
# Claude vision API (screenshot mode)
# ---------------------------------------------------------------------------

def _classify_screenshot(image_bytes: bytes, anthropic_key: str, model: str) -> dict:
    b64 = base64.b64encode(image_bytes).decode("ascii")
    payload = {
        "model": model,
        "max_tokens": 400,
        "system": _SYSTEM_PROMPT,
        "messages": [{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": "image/png", "data": b64},
                },
                {
                    "type": "text",
                    "text": "Classify the terminal state shown in this screenshot. Reply ONLY with valid JSON.",
                },
            ],
        }],
    }
    headers = {
        "Content-Type": "application/json",
        "x-api-key": anthropic_key,
        "anthropic-version": "2023-06-01",
    }
    data = _post_json("https://api.anthropic.com/v1/messages", headers, payload)
    text = _strip_fences(data["content"][0]["text"])
    return _validate(json.loads(text), "screenshot")


# ---------------------------------------------------------------------------
# DeepSeek text API
# ---------------------------------------------------------------------------

def _classify_text_deepseek(terminal_text: str, deepseek_key: str, model: str) -> dict:
    user_msg = (
        "Here is the recent output from a Claude Code terminal session:\n\n"
        f"```\n{terminal_text[-4000:]}\n```\n\n"
        "Classify the terminal state. Reply ONLY with valid JSON."
    )
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ],
        "max_tokens": 400,
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {deepseek_key}",
    }
    data = _post_json("https://api.deepseek.com/chat/completions", headers, payload)
    text = data["choices"][0]["message"]["content"].strip()
    return _validate(json.loads(text), "text_deepseek")


# ---------------------------------------------------------------------------
# Claude text API
# ---------------------------------------------------------------------------

def _classify_text_claude(terminal_text: str, anthropic_key: str, model: str) -> dict:
    user_msg = (
        "Here is the recent output from a Claude Code terminal session:\n\n"
        f"```\n{terminal_text[-4000:]}\n```\n\n"
        "Classify the terminal state. Reply ONLY with valid JSON."
    )
    payload = {
        "model": model,
        "max_tokens": 400,
        "system": _SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_msg}],
    }
    headers = {
        "Content-Type": "application/json",
        "x-api-key": anthropic_key,
        "anthropic-version": "2023-06-01",
    }
    data = _post_json("https://api.anthropic.com/v1/messages", headers, payload)
    text = _strip_fences(data["content"][0]["text"])
    return _validate(json.loads(text), "text_claude")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def classify_state_smart(
    terminal_text: str,
    cfg: dict,
    post_done: bool = False,
) -> dict:
    """
    Classify the Claude Code terminal state using AI.

    Parameters
    ----------
    terminal_text : str
        Recent tmux pane output.
    cfg : dict
        Full config dict from config.json.
    post_done : bool
        If True, short-circuit and return post_done_wait without any API call.

    Returns
    -------
    dict with keys: state, confidence, question, suggested_response, method, reasoning
    """
    if post_done:
        return {
            "state": "post_done_wait",
            "confidence": 1.0,
            "question": None,
            "suggested_response": None,
            "method": "shortcut",
            "reasoning": "post_done flag is set — waiting for compact/clear response",
        }

    vision_cfg = cfg.get("vision", {})
    mode = vision_cfg.get("mode", "text_deepseek")

    # --- screenshot (Claude vision) ---
    if mode == "screenshot":
        anthropic_key = (
            os.environ.get("ANTHROPIC_API_KEY", "")
            or vision_cfg.get("anthropic_api_key", "")
        )
        model = vision_cfg.get("model", "claude-3-5-haiku-20241022")
        if not anthropic_key:
            logger.warning("screenshot mode: ANTHROPIC_API_KEY not set, falling back to text_deepseek")
            mode = "text_deepseek"
        else:
            image_bytes = capture_screenshot()
            if image_bytes is None:
                logger.warning("screenshot mode: capture failed, falling back to text_deepseek")
                mode = "text_deepseek"
            else:
                try:
                    result = _classify_screenshot(image_bytes, anthropic_key, model)
                    logger.info("vision[screenshot] state=%s confidence=%.2f",
                                result.get("state"), result.get("confidence", 0))
                    return result
                except (urllib.error.URLError, urllib.error.HTTPError,
                        KeyError, json.JSONDecodeError, OSError) as exc:
                    logger.error("screenshot classification failed (%s), falling back", exc)
                    mode = "text_deepseek"

    # --- text_deepseek (default) ---
    if mode == "text_deepseek":
        deepseek_key = (
            os.environ.get("DEEPSEEK_API_KEY", "")
            or cfg.get("deepseek_api_key", "")
        )
        deepseek_model = cfg.get("deepseek_model", "deepseek-chat")
        if not deepseek_key:
            logger.warning("text_deepseek mode: DEEPSEEK_API_KEY not set, falling back to text_claude")
            mode = "text_claude"
        else:
            try:
                result = _classify_text_deepseek(terminal_text, deepseek_key, deepseek_model)
                logger.info("vision[text_deepseek] state=%s confidence=%.2f",
                            result.get("state"), result.get("confidence", 0))
                return result
            except (urllib.error.URLError, urllib.error.HTTPError,
                    KeyError, json.JSONDecodeError, OSError) as exc:
                logger.error("text_deepseek classification failed (%s), falling back", exc)
                mode = "text_claude"

    # --- text_claude ---
    if mode == "text_claude":
        anthropic_key = (
            os.environ.get("ANTHROPIC_API_KEY", "")
            or vision_cfg.get("anthropic_api_key", "")
        )
        model = vision_cfg.get("model", "claude-3-5-haiku-20241022")
        if not anthropic_key:
            logger.warning("text_claude mode: ANTHROPIC_API_KEY not set, returning unknown")
        else:
            try:
                result = _classify_text_claude(terminal_text, anthropic_key, model)
                logger.info("vision[text_claude] state=%s confidence=%.2f",
                            result.get("state"), result.get("confidence", 0))
                return result
            except (urllib.error.URLError, urllib.error.HTTPError,
                    KeyError, json.JSONDecodeError, OSError) as exc:
                logger.error("text_claude classification failed (%s)", exc)

    return dict(_FALLBACK)
