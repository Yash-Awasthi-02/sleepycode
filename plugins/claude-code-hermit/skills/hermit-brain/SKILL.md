---
name: hermit-brain
description: "Show fragile zones, stale accepted proposals, and recent learnings drawn from session history, proposals, and reflect output. Activates on messages like 'what's stuck', 'any fragile zones', 'show me what's blocked', 'recent learnings', 'hermit brain', 'what have you learned lately', 'where are the weak spots'."
---
# Hermit Brain

Synthesize a compact analytical snapshot of the hermit's current knowledge state: where things are fragile, which accepted proposals have stalled, and what has been recently learned.

## Step 0 — Channel reply

If this skill was invoked from a channel-arrived message (the inbound prompt contains a `<channel source="...">` tag), reply via that channel's reply tool. Otherwise emit to conversation.

## Step 1 — Dispatch the eval runner

Dispatch `claude-code-hermit:skill-eval-runner` pointed at `${CLAUDE_PLUGIN_ROOT}/skills/hermit-brain/reference.md`. The runner reads the session reports, proposals, SHELL.md, and reflection state in an isolated context and returns the assembled snapshot — keeping those full-body reads off this session's inherited context.

**Eval runner return schema** — the runner's return value is a JSON object conforming to this block. The schema is byte-identical in `reference.md` (producer) and here (consumer); a contract test asserts this.

<!-- hermit-brain-eval-schema:start -->
```json
{
  "report": "<assembled ≤1500-char report, section structure above>"
}
```
<!-- hermit-brain-eval-schema:end -->

**Failure policy:** if the runner returns null or malformed JSON, fail-open — deliver a one-line "hermit-brain: snapshot unavailable (analysis-runner failed)" via the Step 0 target and stop.

## Step 2 — Deliver

Deliver the runner's `report` verbatim (≤1500 chars) via the Step 0 target. The runner already omits empty sections; do not re-synthesize. For reference, the report uses this section structure:

```
### Fragile zones
- [tag or theme]: [one-line reason]
(or: No fragile zones detected — no blocked/partial sessions yet.)

### Stale proposals
- PROP-NNN: [title] (accepted N days ago)
(or: No accepted proposals awaiting resolution.)

### Recent learnings
- [learning]
(or: No recent learnings — reflect hasn't run yet.)
```
