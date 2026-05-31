---
name: weekly-coaching-patterns
description: Interval scheduled check — detects multi-session cardiac-drift trends across recent compiled activity notes. Runs weekly via the scheduled-checks routine; findings are routed through the proposal pipeline as Evidence Source: scheduled-check/weekly-coaching-patterns.
---

# Weekly Coaching Patterns

Scheduled-check skill: reads the last 4 `compiled/activity-*.md` artifacts for steady sessions and detects whether cardiac drift is trending upward over time. Returns a fixed findings block for `reflect-scheduled-checks` to classify and route.

**Contract:** idempotent, read-only, no self-scheduling, short-running. Returns findings or silence — never creates proposals itself.

## Steps

1. **Glob activity notes.** Use `Glob` on `.claude-code-hermit/compiled/activity-*.md`. If no files match, output the zero-findings block (Step 5, no-trend path) and stop.

2. **Read and filter.** For each matched file, Read it. Keep only entries where the YAML frontmatter has `type: activity-note` AND `session_kind: steady`. Sort by `created` date descending (most recent first). Take the 4 most recent steady sessions.

   If fewer than 4 steady sessions exist across all artifacts, output the zero-findings block and stop. This is expected on weeks with predominantly interval or strength training — insufficient data is not an error.

3. **Extract cardiac-drift values.** Working oldest-to-newest (reverse the most-recent-first list), for each of the 4 steady sessions parse the body for a line starting with `Cardiac drift:`. Extract the integer bpm value (the number after `+` or `-`). Treat a missing line as no data and exclude that session from the series.

   If fewer than 4 values are extractable after exclusions, output the zero-findings block and stop.

4. **Evaluate the drift trend.** A trend **holds** when ≥3 of the 4 values are strictly increasing left-to-right (each value greater than the one before it, oldest to newest).

   **Anti-duplication guard:** emit a finding ONLY for a quantitative upward numeric trend across the 4-session bpm series. Do NOT emit on label recurrence alone.

5. **Output the findings block.** Always output a plain-text findings block to stdout, regardless of outcome. `reflect-scheduled-checks` classifies the result from this block.

   **Trend holds (≥3 of 4 values rising):**
   ```
   weekly-coaching-patterns findings — <YYYY-MM-DD>
   Coaching patterns: 1
   - Coaching pattern detected [cardiac-drift-high]: cardiac drift trending upward across recent steady sessions (+<V1>→+<V4> bpm, <N>/4 sessions) — check pacing strategy and hydration; consider an easy recovery run next session
   ```
   Replace `<V1>` with the oldest drift value, `<V4>` with the most recent, `<N>` with the count of sessions where drift rose vs the prior session (number of rising adjacent pairs), and `<YYYY-MM-DD>` with today's date.

   **No trend (including insufficient data):**
   ```
   weekly-coaching-patterns findings — <YYYY-MM-DD>
   No actionable findings.
   ```

   The `[cardiac-drift-high]` label reuses the seed vocabulary from `activity-deep-dive` step 7b — no new label is introduced.

## Extend-if-useful (not in v1)

The following metrics follow the same steady-session pattern and would add items to the Coaching patterns list. NOT implemented in v1 — cardiac drift alone proves the mechanism end-to-end.

- **Z2 pace/HR efficiency slope** — extract `Pace/HR efficiency: X.XX min·km⁻¹·bpm⁻¹` from each artifact; detect declining trend across ≥3 of 4 steady sessions. Label: `efficiency-regression`.
- **Recovery-score trend** — extract `Recovery: N/5` from each artifact (applies to both steady and interval sessions); detect hardening trend across ≥3 of 4 sessions. Label: `recovery-insufficient`.

## Notes

- **This skill writes no artifact.** All output goes to stdout for `reflect-scheduled-checks` to classify and route. Runtime state (`last_run`, `consecutive_empty`, etc.) is written by `reflect-scheduled-checks` to `state/reflection-state.json → scheduled_checks.weekly-coaching-patterns` — not by this skill.
- **Registered by `/claude-code-fitness-hermit:hatch`** step 8c via a `scheduled_checks` config entry (`interval_days: 7`). The core daily `scheduled-checks` routine fires `reflect-scheduled-checks`, which picks it up once 7+ days have elapsed since `last_run`.
