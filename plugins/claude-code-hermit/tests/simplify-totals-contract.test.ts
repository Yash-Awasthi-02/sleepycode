// Contract: the totals line emitted by /claude-code-hermit:simplify must match
// verbatim the format that /dev-quality (in the sibling dev-hermit plugin) parses.
// (bun test port of test-simplify-totals-contract.sh)
//
// Both skills are markdown prompts read by the LLM at runtime, so the only way
// to keep them in sync is a string check. If the canonical totals format is
// ever changed in one SKILL.md, this test fails until the other is updated —
// otherwise /dev-quality silently falls into the "totals unavailable" branch
// and Gate 1's report goes blank.
//
// Usage: bun test tests/simplify-totals-contract.test.ts   (from the plugin root)

import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const SIMPLIFY_PATH = path.join(PLUGIN_ROOT, 'skills', 'simplify', 'SKILL.md');
const DEV_QUALITY_PATH = path.join(
  PLUGIN_ROOT, '..', 'claude-code-dev-hermit', 'skills', 'dev-quality', 'SKILL.md');

// Canonical totals line as authored in simplify/SKILL.md Phase 3e.
// Keep this in sync with simplify/SKILL.md if the format ever evolves.
const CANONICAL =
  'Totals: applied N · deduped M · principle-rejected K · stale-anchor skips L · parse failures P';

test('simplify SKILL.md exists', () => {
  expect(fs.existsSync(SIMPLIFY_PATH)).toBe(true);
});

test('dev-quality SKILL.md exists', () => {
  expect(fs.existsSync(DEV_QUALITY_PATH)).toBe(true);
});

test('simplify SKILL.md emits canonical totals line', () => {
  expect(fs.readFileSync(SIMPLIFY_PATH, 'utf-8')).toContain(CANONICAL);
});

test('dev-quality SKILL.md references same canonical totals line', () => {
  expect(fs.readFileSync(DEV_QUALITY_PATH, 'utf-8')).toContain(CANONICAL);
});

// Spot-check the parser hook: dev-quality must describe capturing content after
// the `Totals:` label. Guards against the parser drifting away from a `Totals:`
// prefix while the emitter still uses one.
test('dev-quality references the Totals: label as the parse anchor', () => {
  expect(fs.readFileSync(DEV_QUALITY_PATH, 'utf-8')).toMatch(/after the .?Totals:.? label/);
});
