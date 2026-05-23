#!/usr/bin/env bash
# Contract: the totals line emitted by /claude-code-hermit:simplify must match
# verbatim the format that /dev-quality (in the sibling dev-hermit plugin) parses.
#
# Both skills are markdown prompts read by the LLM at runtime, so the only way
# to keep them in sync is a grep-based string check. If the canonical totals
# format is ever changed in one SKILL.md, this test fails until the other is
# updated — otherwise /dev-quality silently falls into the "totals unavailable"
# branch and Gate 1's report goes blank.
#
# Runs from inside plugins/claude-code-hermit/ (REPO_ROOT = that directory).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

echo "=== simplify ↔ dev-quality totals-line contract ==="
echo ""

SIMPLIFY="$REPO_ROOT/skills/simplify/SKILL.md"
DEV_QUALITY="$REPO_ROOT/../claude-code-dev-hermit/skills/dev-quality/SKILL.md"

# Canonical totals line as authored in simplify/SKILL.md Phase 3e.
# Keep this in sync with simplify/SKILL.md if the format ever evolves.
CANONICAL="Totals: applied N · deduped M · principle-rejected K · stale-anchor skips L · parse failures P"

run_test "simplify SKILL.md exists" test -f "$SIMPLIFY"
run_test "dev-quality SKILL.md exists" test -f "$DEV_QUALITY"

run_test "simplify SKILL.md emits canonical totals line" \
  grep -qF "$CANONICAL" "$SIMPLIFY"

run_test "dev-quality SKILL.md references same canonical totals line" \
  grep -qF "$CANONICAL" "$DEV_QUALITY"

# Spot-check the parser hook: dev-quality must describe capturing content after
# the `Totals:` label. Guards against the parser drifting away from a `Totals:`
# prefix while the emitter still uses one.
run_test "dev-quality references the Totals: label as the parse anchor" \
  bash -c "grep -qE 'after the .?Totals:.? label' \"$DEV_QUALITY\""

print_results
