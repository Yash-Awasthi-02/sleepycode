---
name: dev-down
description: Stop the session-scoped dev server registered by /dev-up. Runs commands.dev_stop if configured (e.g., docker compose down); otherwise stops the Monitor entry directly. Verifies ports return to free-or-allowlisted state.
---

# /dev-down

Stop the dev-server Monitor entry that `/dev-up` registered. Use at task close, or before switching to work that doesn't need the server.

## Prerequisites

- Verify `.claude-code-hermit/sessions/` exists.
- Read `.claude-code-hermit/config.json` once. Cache `claude-code-dev-hermit.commands.dev_stop`, `dev_required_ports`, and `dev_expected_listeners`.

## Plan

### Gate 0 — dev-server registered

Read `.claude-code-hermit/state/monitors.runtime.json`. If no entry with `id: "dev-server"`:

```
dev-down
  monitor:  no dev-server registered
  status:   already down
```

PASS-with-noop, exit.

### Gate 1 — stop

Before stopping `dev-server`, stop any watchdog monitors so they don't fire a spurious `health-degraded` alert as the dev server tears down. Iterate `monitors.runtime.json` and find all entries where `id.startsWith("dev-watchdog-")`. For each:

1. Call `TaskStop` with the entry's `task_id`.
2. Remove the entry from `monitors.runtime.json`.
3. Update SHELL.md `## Monitoring`: change `[ACTIVE] <id>` → `[STOPPED] <id> (HH:MM)`.

If no `dev-watchdog-*` entries exist, skip silently. If `TaskStop` errors (watchdog already exited), remove the entry anyway.

After watchdog teardown, stop `dev-server`:

If `commands.dev_stop` is set (e.g., `docker compose down`, `bin/dev stop`, `supervisorctl stop devstack`):

1. Run via `bash -c "$dev_stop"` and capture exit code.
2. On non-zero exit, FAIL with stdout+stderr tail and the recovery hint:

   ```
   commands.dev_stop exited <code>: <tail>
     recovery: investigate the failed teardown; the Monitor registry entry was NOT cleared
   ```

3. On success, also remove the `dev-server` entry from `state/monitors.runtime.json` (do not call TaskStop — the dev_stop command teardown supersedes the Monitor lifecycle for this case).

Otherwise (no `commands.dev_stop`):

1. Look up the `task_id` for the `dev-server` entry in `state/monitors.runtime.json`.
2. Call `TaskStop` with that `task_id`. The Monitor tool's contract is SIGTERM → 10s drain → SIGKILL.
3. Remove the `dev-server` entry from the registry. Per `watch` SKILL.md:108–110, if `TaskStop` returns an error (the watch already died), remove the entry anyway — a stale entry is worse than no entry.
4. Update SHELL.md `## Monitoring`: change `[ACTIVE] dev-server` → `[STOPPED] dev-server (HH:MM)`.

We invoke `TaskStop` directly rather than `/claude-code-hermit:watch stop dev-server` because the watch skill's stop path is functionally identical (steps 99–110 of its plan) and saves the round-trip through another skill.

### Gate 2 — ports clear

If `dev_required_ports` is empty: skip with `PASS  ports: not configured`.

Otherwise, re-probe via the same helper as `/dev-up` Gate 3:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/port-check.js" "$(jq -nc --argjson ports "$ports_json" --argjson exp "$expected_json" '{ports:$ports,expected:$exp}')"
```

For each port:

- `free` → expected, record.
- `allowed` → also expected (e.g., Encore daemon still owns 4000), record.
- `held` → WARN (do not FAIL — the dev server has stopped from our side, but a different process now holds the port; surface so the operator can investigate):

  ```
  WARN  port <port> still held by <process> (pid <pid>) — was something else listening?
  ```

## Output

```
dev-down
  watchdog: stopped (health, errors)
  monitor:  dev-server stopped (after 1850ms)
  ports:    3000 free, 4000 held by encore (allowed)
  status:   down
```

`watchdog:` values: `stopped (health, errors)` / `stopped (health)` / `stopped (errors)` / `not registered`.

On Gate 0 short-circuit:

```
dev-down
  monitor:  no dev-server registered
  status:   already down
```

## Rules

- **Never `--force` or SIGKILL ad-hoc.** Defer to the watch skill's drain+kill semantics. If those fail, surface to the operator with the registry entry intact.
- **Custom `commands.dev_stop` supersedes Monitor signals.** docker-compose, supervisord, foreman all manage their own process trees — the Monitor only knows about the parent. Trust the configured stop command.
- **Stale registry entries** (where the Monitor process already exited externally) are removed even if `watch stop` returns an error. A dead entry is worse than no entry.
