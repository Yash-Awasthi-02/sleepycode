// bun test port of tests/test-evolve-plan.sh — drives scripts/evolve-plan.ts
// (issue #211, the read-only pre-pass analyzer for hermit-evolve) against
// fixture project trees. Covers version gap, bounded CHANGELOG slice, deep
// config-key diff, template/bin byte-compare, separator-aware CLAUDE-APPEND
// diff, the no_config vs 0.0.0 distinction, and operator-value preservation.
//
// Usage: bun test tests/evolve-plan.test.ts   (from the plugin root)

import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript } from './helpers/run';

const MARKER = '<!-- claude-code-hermit: Session Discipline -->';

// Fake plugin root with plugin version 1.1.7 (shared, read-only across tests).
let PR: string;

beforeAll(() => {
  PR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-evolve-pr-'));
  fs.mkdirSync(path.join(PR, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(PR, 'state-templates', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(PR, '.claude-plugin', 'plugin.json'), '{"version":"1.1.7"}\n');
  fs.writeFileSync(path.join(PR, 'CHANGELOG.md'), `# Changelog

## [1.1.7] - 2026-05-31
### Fixed
- newest change

### Upgrade Instructions
Run the evolve skill.

## [1.1.6] - 2026-05-28
### Added
- middle change

## [1.1.5] - 2026-05-25
### Added
- oldest change
`);
  fs.writeFileSync(path.join(PR, 'state-templates', 'config.json.template'), `{
  "_hermit_versions": {},
  "model": "sonnet",
  "routines": [{"id": "x"}],
  "quality_gate": {"tier": "budget"},
  "heartbeat": {"enabled": true, "waiting_timeout": null}
}
`);
  fs.writeFileSync(path.join(PR, 'state-templates', 'CLAUDE-APPEND.md'),
    `---\n\n${MARKER}\n## Session Discipline\n\nbody line\n`);
  fs.writeFileSync(path.join(PR, 'state-templates', 'SHELL.md.template'), 'SHELL TEMPLATE V1\n');
  fs.writeFileSync(path.join(PR, 'state-templates', 'SESSION-REPORT.md.template'), 'REPORT TEMPLATE\n');
  fs.writeFileSync(path.join(PR, 'state-templates', 'PROPOSAL.md.template'), 'PROPOSAL TEMPLATE\n');
  fs.writeFileSync(path.join(PR, 'state-templates', 'bin', 'hermit-run'), '#!/bin/sh\necho run\n');
});

afterAll(() => {
  try { fs.rmSync(PR, { recursive: true, force: true }); } catch {}
});

/** Run a test body against a throwaway project tree, always cleaning up. */
function withProj(fn: (proj: string) => Promise<void> | void) {
  return async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-evolve-proj-'));
    fs.mkdirSync(path.join(proj, '.claude-code-hermit'), { recursive: true });
    try { await fn(proj); } finally {
      try { fs.rmSync(proj, { recursive: true, force: true }); } catch {}
    }
  };
}

const hermitDir = (proj: string) => path.join(proj, '.claude-code-hermit');
const writeConfig = (proj: string, content: string) =>
  fs.writeFileSync(path.join(hermitDir(proj), 'config.json'), content);

/** Run evolve-plan and return the parsed plan. Omit hatchTarget to drop the flag. */
async function runPlan(proj: string, hatchTarget?: string): Promise<any> {
  const args = [hermitDir(proj)];
  if (hatchTarget !== undefined) args.push(`--hatch-target=${hatchTarget}`);
  const r = await runScript('evolve-plan.ts', { args, env: { CLAUDE_PLUGIN_ROOT: PR } });
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout);
}

// -------------------------------------------------------
// 1. Version gap + bounded changelog slice
// -------------------------------------------------------

test('version gap: from 1.1.6 -> to 1.1.7, not up_to_date', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  const d = await runPlan(proj, 'local');
  expect(d.from).toBe('1.1.6');
  expect(d.to).toBe('1.1.7');
  expect(d.up_to_date).toBe(false);
  expect(d.errors).toEqual([]);
}));

test('changelog slice: only (1.1.6, 1.1.7], excludes older', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  const d = await runPlan(proj, 'local');
  expect(d.changelog_versions).toEqual(['1.1.7']);
  const s = d.changelog_slice;
  expect(s).toContain('newest change');
  expect(s).toContain('Upgrade Instructions');
  expect(s).not.toContain('middle change');
  expect(s).not.toContain('oldest change');
}));

// -------------------------------------------------------
// 2. Up to date
// -------------------------------------------------------

test('up_to_date true when config == plugin version', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.7"}}');
  const d = await runPlan(proj, 'local');
  expect(d.up_to_date).toBe(true);
  expect(d.changelog_versions).toEqual([]);
}));

// -------------------------------------------------------
// 3. New config keys: top-level + nested leaf reported, present omitted
// -------------------------------------------------------

test('new_config_keys: reports quality_gate + heartbeat.waiting_timeout, omits present', withProj(async (proj) => {
  writeConfig(proj, `{
  "_hermit_versions": {"claude-code-hermit": "1.1.6"},
  "model": "sonnet",
  "routines": [{"id": "x"}],
  "heartbeat": {"enabled": true}
}
`);
  const d = await runPlan(proj, 'local');
  const keys: Record<string, any> = {};
  for (const k of d.new_config_keys) keys[k.path] = k.default;
  expect(Object.keys(keys)).toContain('quality_gate');
  expect(keys['quality_gate']).toEqual({ tier: 'budget' });
  expect(Object.keys(keys)).toContain('heartbeat.waiting_timeout');
  expect(keys['heartbeat.waiting_timeout']).toBeNull();
  expect(Object.keys(keys)).not.toContain('model');
  expect(Object.keys(keys)).not.toContain('heartbeat.enabled');
}));

// -------------------------------------------------------
// 4. templates_changed / bin_changed: only differing/absent files
// -------------------------------------------------------

test('templates/bin changed: detects diff + absent, skips identical', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  fs.mkdirSync(path.join(hermitDir(proj), 'templates'), { recursive: true });
  fs.mkdirSync(path.join(hermitDir(proj), 'bin'), { recursive: true });
  fs.writeFileSync(path.join(hermitDir(proj), 'templates', 'SHELL.md.template'), 'DIFFERENT CONTENT\n');
  fs.writeFileSync(path.join(hermitDir(proj), 'templates', 'SESSION-REPORT.md.template'), 'REPORT TEMPLATE\n'); // identical
  // PROPOSAL.md.template absent -> needs copy
  fs.writeFileSync(path.join(hermitDir(proj), 'bin', 'hermit-run'), '#!/bin/sh\necho CHANGED\n'); // differs
  const d = await runPlan(proj, 'local');
  expect(d.templates_changed).toContain('SHELL.md.template');
  expect(d.templates_changed).toContain('PROPOSAL.md.template');
  expect(d.templates_changed).not.toContain('SESSION-REPORT.md.template');
  expect(d.bin_changed).toEqual(['hermit-run']);
}));

// -------------------------------------------------------
// 5a. CLAUDE-APPEND identical (target has leading ---) -> not changed
// -------------------------------------------------------

test('CLAUDE-APPEND identical (modulo leading ---) -> changed=false, no old_block', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  fs.writeFileSync(path.join(proj, 'CLAUDE.local.md'),
    `# My Project\n\nstuff\n\n---\n\n${MARKER}\n## Session Discipline\n\nbody line\n`);
  const d = await runPlan(proj, 'local');
  expect(d.claude_append_changed).toBe(false);
  // should omit old_block when unchanged
  expect('claude_append_old_block' in d).toBe(false);
}));

// -------------------------------------------------------
// 5b. CLAUDE-APPEND different -> changed + exact old_block
// -------------------------------------------------------

test('CLAUDE-APPEND different -> changed=true, old_block is exact marker-onward', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  const target = path.join(proj, 'CLAUDE.local.md');
  fs.writeFileSync(target,
    `# My Project\n\nstuff\n\n---\n\n${MARKER}\n## Session Discipline\n\nOLD body line\n`);
  const d = await runPlan(proj, 'local');
  expect(d.claude_append_changed).toBe(true);
  const ob: string = d.claude_append_old_block;
  expect(ob.startsWith(MARKER)).toBe(true);
  expect(ob).toContain('OLD body line');
  // must be an exact substring of the target file (so a targeted Edit will match)
  expect(fs.readFileSync(target, 'utf-8')).toContain(ob);
}));

// -------------------------------------------------------
// 5c. CLAUDE-APPEND marker absent -> changed (append case), no old_block
// -------------------------------------------------------

test('CLAUDE-APPEND marker absent -> changed=true (append), no old_block', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  fs.writeFileSync(path.join(proj, 'CLAUDE.local.md'), '# My Project\n\nno hermit block here\n');
  const d = await runPlan(proj, 'local');
  expect(d.claude_append_changed).toBe(true);
  // append case must omit old_block
  expect('claude_append_old_block' in d).toBe(false);
}));

// -------------------------------------------------------
// 6. no_config: missing config.json -> errors[no_config], no top-level error key
// -------------------------------------------------------

test('no_config: missing config.json -> errors[no_config], single contract', withProj(async (proj) => {
  const d = await runPlan(proj, 'local');
  const codes = d.errors.map((e: any) => e.code);
  expect(codes).toContain('no_config');
  // must not use a top-level error key
  expect('error' in d).toBe(false);
  // should not report a version when there is no config
  expect('from' in d).toBe(false);
}));

// -------------------------------------------------------
// 7. malformed config.json -> errors[config_json_invalid], not no_config
// -------------------------------------------------------

test('malformed config.json -> errors[config_json_invalid], not no_config', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":');
  const d = await runPlan(proj, 'local');
  const codes = d.errors.map((e: any) => e.code);
  expect(codes).toContain('config_json_invalid');
  expect(codes).not.toContain('no_config');
  // should not report a version when config is invalid
  expect('from' in d).toBe(false);
}));

// -------------------------------------------------------
// 8. missing _hermit_versions only -> from 0.0.0, clean errors
// -------------------------------------------------------

test('missing _hermit_versions -> from 0.0.0, errors empty', withProj(async (proj) => {
  writeConfig(proj, '{"model":"sonnet"}');
  const d = await runPlan(proj, 'local');
  expect(d.from).toBe('0.0.0');
  expect(d.errors).toEqual([]);
}));

// -------------------------------------------------------
// 9. Operator value preserved: present nested key (non-default) omitted
//    (script-level guard for idempotent Step 9 — never re-lists a set key)
// -------------------------------------------------------

test('operator value preserved: set quality_gate.tier not re-listed', withProj(async (proj) => {
  writeConfig(proj, `{
  "_hermit_versions": {"claude-code-hermit": "1.1.6"},
  "model": "sonnet",
  "routines": [{"id": "x"}],
  "quality_gate": {"tier": "balanced"},
  "heartbeat": {"enabled": true, "waiting_timeout": "30m"}
}
`);
  const d = await runPlan(proj, 'local');
  const paths = d.new_config_keys.map((k: any) => k.path);
  expect(paths).not.toContain('quality_gate');
  expect(paths).not.toContain('heartbeat.waiting_timeout');
}));

// -------------------------------------------------------
// 10. no_hatch_target: required flag missing -> errors[no_hatch_target]
// -------------------------------------------------------

test('no_hatch_target: missing flag -> errors[no_hatch_target], exit 0', withProj(async (proj) => {
  writeConfig(proj, '{"_hermit_versions":{"claude-code-hermit":"1.1.6"}}');
  const d = await runPlan(proj); // no --hatch-target flag (runPlan asserts exit 0)
  const codes = d.errors.map((e: any) => e.code);
  expect(codes).toContain('no_hatch_target');
}));
