# Hermit Brain — Evaluation Reference

This file is the instruction spec for the isolated-context subagent dispatched by SKILL.md.
The subagent reads only files (no inherited session context) and returns a single structured JSON
value. The calling main session decides where to deliver it (channel reply vs conversation) — this
spec produces the report text, it does not send anything.

## Inputs (read fresh — do not reuse cached values)

Gracefully skip any file that doesn't exist. The four sources are independent — read them concurrently.

1. `.claude-code-hermit/sessions/SHELL.md` — current session context, tags, blockers
2. `.claude-code-hermit/sessions/S-*-REPORT.md` — glob all, sort descending by filename, read the 5
   most recent; parse `status`, `tags`, `proposals_created` frontmatter
3. `.claude-code-hermit/proposals/PROP-*.md` — glob all; for each read `id`, `title`, `status`,
   `accepted_date`, `resolved_date`, `tags` from frontmatter
4. `.claude-code-hermit/state/reflection-state.json` — `last_reflection`, `queue` (pending
   micro-proposals and reflect candidates)

## Analysis

**Fragile zones:** From the last 5 session reports, gather the `tags` array from sessions with
`status: partial` or `status: blocked`. Also gather `tags` from proposals with `status: dismissed`
or `status: blocked`. Surface the top 2–3 tag clusters that appear repeatedly across fragile
outcomes. If no blocked/partial sessions exist: "No fragile zones detected."

**Stale proposals:** From proposals, find those with `status: accepted` and `resolved_date` absent
or `null`. Sort by `accepted_date` ascending (oldest first). Show up to 3. Compute days open =
today minus `accepted_date`. If none: "No accepted proposals awaiting resolution."

**Recent learnings:** From `reflection-state.json`, read `queue` entries with `status: accepted` or
`status: pending` and surface the most recent 3 question/observation fields. If the queue is empty
or absent, scan the current SHELL.md Progress Log for notable Findings entries (lines beginning with
`-` under `## Findings`). Surface top 3. If nothing: "No recent learnings — reflect hasn't run yet."

## Return Value

Assemble the report as a single `report` string, ≤1500 chars, using exactly this section
structure (omit sections that have no data rather than showing a heading with an empty body; keep
each bullet to one line):

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

Return a single JSON object — no prose, no markdown wrapping. The field is required.

<!-- hermit-brain-eval-schema:start -->
```json
{
  "report": "<assembled ≤1500-char report, section structure above>"
}
```
<!-- hermit-brain-eval-schema:end -->
