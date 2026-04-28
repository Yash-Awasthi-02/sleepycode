'use strict';

// Tests for alerts-store.js — run with: node scripts/lib/alerts-store.test.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readAlerts, atomicAppendAlert, markAcknowledged } = require('./alerts-store');

let passed = 0;
let failed = 0;

function ok(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed += 1;
  } else {
    console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    failed += 1;
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-store-test-'));
}

function makeAlert(id, kind, binding) {
  return {
    id,
    kind,
    binding,
    created_at: new Date().toISOString(),
    details: {},
    acknowledged: false,
  };
}

// ── readAlerts ──────────────────────────────────────────────────────────────

console.log('\nreadAlerts — missing file:');
{
  const dir = tmpDir();
  const result = readAlerts(dir);
  ok('returns empty array for missing file', Array.isArray(result) && result.length === 0);
}

console.log('\nreadAlerts — malformed JSON:');
{
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'alerts.json'), '{not valid json', 'utf8');
  const result = readAlerts(dir);
  ok('returns empty array for malformed file', Array.isArray(result) && result.length === 0);
}

console.log('\nreadAlerts — non-array JSON:');
{
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'alerts.json'), '{"not":"array"}', 'utf8');
  const result = readAlerts(dir);
  ok('returns empty array for non-array JSON', Array.isArray(result) && result.length === 0);
}

// ── atomicAppendAlert ───────────────────────────────────────────────────────

console.log('\natomicAppendAlert — basic append:');
{
  const dir = tmpDir();
  const a1 = makeAlert('evt-001', 'health-degraded', 'feature/foo');
  atomicAppendAlert(dir, a1);
  const result = readAlerts(dir);
  ok('one entry after first append', result.length === 1);
  ok('entry matches what was written', result[0].id === 'evt-001');
  ok('no tmp file left behind', !fs.existsSync(path.join(dir, 'alerts.json.tmp')));
}

console.log('\natomicAppendAlert — multiple appends:');
{
  const dir = tmpDir();
  for (let i = 1; i <= 5; i++) {
    atomicAppendAlert(dir, makeAlert(`evt-${String(i).padStart(3, '0')}`, 'health-degraded', 'main'));
  }
  const result = readAlerts(dir);
  ok('five entries after five appends', result.length === 5);
  ok('order preserved (oldest first)', result[0].id === 'evt-001' && result[4].id === 'evt-005');
}

console.log('\natomicAppendAlert — prune to 50:');
{
  const dir = tmpDir();
  for (let i = 1; i <= 55; i++) {
    atomicAppendAlert(dir, makeAlert(`evt-${String(i).padStart(3, '0')}`, 'error-spike', 'branch'));
  }
  const result = readAlerts(dir);
  ok('capped at 50 entries', result.length === 50);
  ok('oldest entries dropped (evt-001 through evt-005 gone)', result[0].id === 'evt-006');
  ok('newest entry present (evt-055)', result[49].id === 'evt-055');
}

console.log('\natomicAppendAlert — creates stateDir if missing:');
{
  const base = tmpDir();
  const nested = path.join(base, 'does', 'not', 'exist');
  // should not throw
  let threw = false;
  try {
    atomicAppendAlert(nested, makeAlert('evt-x', 'health-recovered', 'branch'));
  } catch (e) {
    threw = true;
  }
  ok('no throw when stateDir missing', !threw);
  ok('file created in nested dir', fs.existsSync(path.join(nested, 'alerts.json')));
}

// ── markAcknowledged ────────────────────────────────────────────────────────

console.log('\nmarkAcknowledged:');
{
  const dir = tmpDir();
  const a1 = makeAlert('evt-A', 'health-degraded', 'feature/foo');
  const a2 = makeAlert('evt-B', 'error-spike', 'feature/foo');
  atomicAppendAlert(dir, a1);
  atomicAppendAlert(dir, a2);

  markAcknowledged(dir, 'evt-A');
  const result = readAlerts(dir);
  ok('target alert acknowledged', result.find(a => a.id === 'evt-A').acknowledged === true);
  ok('other alert untouched', result.find(a => a.id === 'evt-B').acknowledged === false);
}

{
  const dir = tmpDir();
  atomicAppendAlert(dir, makeAlert('evt-C', 'health-degraded', 'main'));
  const before = readAlerts(dir);
  markAcknowledged(dir, 'evt-NONEXISTENT');
  const after = readAlerts(dir);
  ok('no-op for unknown alertId', JSON.stringify(before) === JSON.stringify(after));
}

// ── summary ─────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
