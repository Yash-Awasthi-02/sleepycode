---
name: dev-log-watch
description: Generate a Monitor entry that tails the project's dev log file for error patterns. Handles date-rotating logs (Winston, Pino, structlog) with a midnight wrapper, and fixed-path logs (Rails log/development.log) with plain tail. Reads dev_log_path_pattern, dev_error_pattern, dev_noise_pattern from config. Run once per project during onboarding.
---

# /dev-log-watch

Register a Monitor that surfaces errors from the project's dev log file as conversation notifications. Per-project, not per-task — invoke once during onboarding; the entry persists in `config.json` `monitors[]` and auto-registers each session via `/claude-code-hermit:watch start`.

This skill applies to projects whose dev server logs to a **file**. For stdout/journald/Docker stacks, use the alternatives documented in `docs/DEV-LOG-WATCH.md` `## Use instead`.

## Prerequisites

- Verify `.claude-code-hermit/sessions/` exists.
- Read `.claude-code-hermit/config.json`. Cache `claude-code-dev-hermit.dev_log_path_pattern`, `dev_error_pattern`, `dev_noise_pattern`.

## Plan

### Gate 0 — log-watch config present

If `dev_log_path_pattern` and `dev_error_pattern` are both unset or empty:

```
dev_log_path_pattern and dev_error_pattern not configured

  if your dev server logs to a file (Winston/Pino daily, Rails log/development.log,
  structlog TimedRotatingFileHandler): run /claude-code-dev-hermit:dev-adapt to
  detect and persist the patterns.

  if it logs to stdout / journald / Docker: this skill does not apply — see
  docs/DEV-LOG-WATCH.md `## Use instead` for the right primitive (Monitor on
  the start command, journalctl follow, docker logs -f).
```

FAIL with the message above. Don't blindly say "run /dev-adapt" — for stdout-only stacks, it won't find anything.

If only one of the two is set: WARN that the other should also be set, and exit without registering.

### Gate 1 — build the Monitor command

Invoke the helper:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/log-watch-builder.js" "$(jq -nc \
  --arg path "$dev_log_path_pattern" \
  --arg err "$dev_error_pattern" \
  --arg noise "${dev_noise_pattern:-}" \
  '{logPathPattern:$path, errorPattern:$err, noisePattern: ($noise | select(length > 0))}')"
```

Helper returns `{ command, shape }` where `shape` is `rotating` (date-templated path → midnight while-loop wrapper) or `fixed` (plain `tail -F`). The bash one-liner is taken verbatim from `docs/DEV-LOG-WATCH.md` lines 44–56 and refined for fixed paths; do not re-derive.

### Gate 2 — parent directory exists

Resolve the current log path:

- **Rotating:** evaluate `$(date ...)` substitutions to compute today's expected path. Use the same fallback the wrapper uses: `date -d 'tomorrow 00:00:00' 2>/dev/null` (GNU) → falls through to `date -v...` (BSD). For dev-adapt's purposes, only check whether the resolved string's `dirname` exists on disk.
- **Fixed:** use the path verbatim.

Run `[ -d "$(dirname "$resolved_path")" ]`. If absent, WARN — the file may be created later when the dev server first writes:

```
WARN  parent directory <dir> does not exist yet — log file may not appear until the dev server writes
```

Do not FAIL — proceed to register the monitor; the watch will start tailing once the file appears.

### Gate 3 — register or persist

Ask the operator (`AskUserQuestion`) which scope they want, **unless** an entry with `id: "dev-log-errors"` already exists in `config.json` `monitors[]` (idempotency — skip the question on re-runs):

```
{
  header: "Persistence",
  question: "Register dev-log-errors monitor?",
  options: [
    { label: "Persist", description: "Save to config.monitors[] — auto-registers every session" },
    { label: "Ad-hoc", description: "Register for this session only; do not save to config" },
    { label: "Cancel", description: "Skip" }
  ]
}
```

Default: `Persist` for first runs, no question on re-runs (already in config → just call `/watch stop dev-log-errors` then `/watch start` to refresh; or do nothing if the command unchanged).

**Persist path:**

1. Read `.claude-code-hermit/config.json` `monitors[]` array (create if missing).
2. If an entry with `id: "dev-log-errors"` exists, replace it; otherwise append:

   ```json
   {
     "id": "dev-log-errors",
     "description": "errors in dev server log",
     "command": "<built command from Gate 1>",
     "class": "stream",
     "persistent": true,
     "enabled": true
   }
   ```

3. Write `config.json` back. The next session-start auto-registers the entry; subsequent sessions need no operator action.
4. Register immediately for the current session via `/claude-code-hermit:watch start dev-log-errors "<command>"` so the operator gets feedback now rather than at next session-start. (Per `claude-code-hermit:watch` SKILL.md, config monitors do not hot-reload during a session — without this step, persisting alone is a silent no-op until session-start.)

**Ad-hoc path:**

1. Invoke `/claude-code-hermit:watch start dev-log-errors "<command>"` directly.
2. Skip config write.

## Output

```
dev-log-watch
  shape:    rotating (date-templated)
  pattern:  logs/app-$(date +%Y-%m-%d).log
  errors:   "level":"error"|^ERROR
  noise:    deprecation|0 errors
  scope:    persisted to config.monitors[]
  status:   registered (now active for this session)
```

On Gate 0 FAIL, emit the multi-line message above.

## Rules

- **File-log only.** stdout/journald/Docker stacks have native primitives (Monitor on start command, `journalctl -f`, `docker logs -f`); do not wedge them through this skill. `docs/DEV-LOG-WATCH.md` documents the alternatives.
- **Idempotent across runs.** Re-invoking should detect an existing config entry and offer to refresh, not silently double-register.
- **Helper module owns the bash construction.** SKILL prose describes intent; `scripts/lib/log-watch-builder.js` builds the command. Bug fixes (e.g., a new shell escaping issue) go in the helper.
- **Per-project, not per-task.** The persisted entry survives across sessions. Operators do not need to re-run on every task.
