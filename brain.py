"""
brain.py — DeepSeek integration module for SleepyCode orchestrator.

Imported by watchdog.py. Provides roadmap loading and DeepSeek API calls
using only Python stdlib (urllib.request). No pip packages required.
"""

import json
import logging
import os
import urllib.error
import urllib.request

logger = logging.getLogger("sleepycode.brain")


# ---------------------------------------------------------------------------
# Roadmap loading
# ---------------------------------------------------------------------------

ROADMAP_CANDIDATES = [
    "progress.md",
    "ROADMAP.md",
    "roadmap.md",
    "TODO.md",
    "plan.md",
]


def load_roadmap(project_dir: str = ".") -> str:
    """
    Search for a roadmap / progress file in project_dir.

    Checks candidates in priority order: progress.md, ROADMAP.md, roadmap.md,
    TODO.md, plan.md. Returns the content of the first file found, or an empty
    string if none exist.
    """
    for filename in ROADMAP_CANDIDATES:
        candidate = os.path.join(project_dir, filename)
        if os.path.isfile(candidate):
            try:
                with open(candidate, "r", encoding="utf-8", errors="replace") as fh:
                    content = fh.read()
                logger.debug("Loaded roadmap from %s (%d bytes)", candidate, len(content))
                return content
            except OSError as exc:
                logger.warning("Could not read %s: %s", candidate, exc)
    return ""


# ---------------------------------------------------------------------------
# Internal HTTP helper
# ---------------------------------------------------------------------------

def _post_json(url: str, headers: dict, payload: dict, timeout: int = 30) -> dict:
    """
    POST a JSON payload to url and return the parsed response dict.
    Raises urllib.error.URLError / ValueError on failure.
    """
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    return json.loads(raw.decode("utf-8"))


# ---------------------------------------------------------------------------
# Core DeepSeek call
# ---------------------------------------------------------------------------

def ask_deepseek(
    context: str,
    question: str,
    roadmap: str = "",
    api_key: str | None = None,
    model: str = "deepseek-chat",
) -> str:
    """
    Ask DeepSeek what Claude Code should respond with.

    Parameters
    ----------
    context:   Last N lines of tmux pane output (string).
    question:  The specific question or prompt Claude Code is waiting on.
    roadmap:   Contents of the project roadmap file (optional).
    api_key:   DeepSeek API key. Falls back to DEEPSEEK_API_KEY env var.
    model:     DeepSeek model name (default: deepseek-chat).

    Returns
    -------
    A concise response string suitable for injecting directly into the tmux
    pane. Falls back to "y" on any API error so Claude Code is never blocked.
    """
    resolved_key = api_key or os.environ.get("DEEPSEEK_API_KEY", "")
    if not resolved_key:
        logger.error("ask_deepseek: no API key available, returning fallback 'y'")
        return "y"

    # Build system prompt — inject roadmap when available
    system_parts = [
        "You are orchestrating a Claude Code autonomous session. "
        "Claude Code has paused and needs a response. "
        "Given the context and project roadmap, provide the most appropriate "
        "concise response. "
        "If options are numbered reply with just the number. "
        "If yes/no reply y or n. "
        "If asking what to do next give a brief instruction matching roadmap priorities. "
        "Never explain - just the response.",
    ]
    if roadmap.strip():
        system_parts.append(f"\n\nProject roadmap:\n{roadmap.strip()}")
    system_prompt = "".join(system_parts)

    # Build user message
    user_content = f"Terminal context:\n{context}\n\nQuestion/prompt requiring response:\n{question}"

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "max_tokens": 150,
        "temperature": 0.2,
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {resolved_key}",
    }

    try:
        data = _post_json(
            "https://api.deepseek.com/chat/completions",
            headers=headers,
            payload=payload,
        )
        response_text = data["choices"][0]["message"]["content"].strip()
        logger.info("ask_deepseek response: %r", response_text)
        return response_text
    except (urllib.error.URLError, urllib.error.HTTPError, KeyError, json.JSONDecodeError) as exc:
        logger.error("ask_deepseek failed (%s), returning fallback 'y'", exc)
        return "y"


# ---------------------------------------------------------------------------
# Compact-or-clear decision
# ---------------------------------------------------------------------------

def ask_compact_or_clear(
    context: str,
    api_key: str | None = None,
    model: str = "deepseek-chat",
) -> str:
    """
    Ask DeepSeek whether Claude Code should run /compact or /clear next.

    Returns "compact" if the session should be compacted (long ongoing work
    with history worth keeping), or "clear" if a clean slate is better.
    Falls back to "compact" on any error (safer default — preserves history).
    """
    resolved_key = api_key or os.environ.get("DEEPSEEK_API_KEY", "")
    if not resolved_key:
        logger.error("ask_compact_or_clear: no API key, defaulting to 'compact'")
        return "compact"

    system_prompt = (
        "You are deciding whether a Claude Code session should run /compact or /clear. "
        "/compact: keeps conversation history but summarises it — use for long ongoing work. "
        "/clear: wipes history entirely — use for a genuinely fresh task. "
        "Reply with exactly one word: compact OR clear. No explanation."
    )

    user_content = (
        f"Here is the recent terminal output from the Claude Code session:\n\n{context}\n\n"
        "Should the next step be /compact or /clear?"
    )

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "max_tokens": 10,
        "temperature": 0.1,
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {resolved_key}",
    }

    try:
        data = _post_json(
            "https://api.deepseek.com/chat/completions",
            headers=headers,
            payload=payload,
        )
        raw = data["choices"][0]["message"]["content"].strip().lower()
        # Be permissive: accept any response that contains the keyword
        if "clear" in raw:
            result = "clear"
        else:
            result = "compact"
        logger.info("ask_compact_or_clear => %s (raw: %r)", result, raw)
        return result
    except (urllib.error.URLError, urllib.error.HTTPError, KeyError, json.JSONDecodeError) as exc:
        logger.error("ask_compact_or_clear failed (%s), defaulting to 'compact'", exc)
        return "compact"
