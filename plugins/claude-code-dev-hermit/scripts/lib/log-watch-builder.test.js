'use strict';

// Tests for log-watch-builder.js — run with: node scripts/lib/log-watch-builder.test.js

const { buildLogWatchCommand, isRotatingPattern } = require('./log-watch-builder');

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

console.log('\nisRotatingPattern:');
ok('detects $(date +...)', isRotatingPattern('logs/app-$(date +%Y-%m-%d).log'));
ok('detects $(date)', isRotatingPattern('logs/$(date).log'));
ok('fixed path → false', !isRotatingPattern('log/development.log'));
ok('fixed path with dots → false', !isRotatingPattern('logs/app.2026-04-27.log'));

console.log('\nbuildLogWatchCommand — rotating:');
{
  const r = buildLogWatchCommand({
    logPathPattern: 'logs/app-$(date +%Y-%m-%d).log',
    errorPattern: '"level":"error"|^ERROR',
    noisePattern: '0 errors',
  });
  ok('shape=rotating', r.shape === 'rotating');
  ok('contains while loop', r.command.includes('while true; do'));
  ok('contains midnight calc', r.command.includes('NEXT_MIDNIGHT'));
  ok('contains GNU date branch', r.command.includes("date -d 'tomorrow 00:00:00'"));
  ok('contains BSD fallback', r.command.includes('date -v+1d'));
  ok('contains stdbuf -oL tail', r.command.includes('stdbuf -oL tail -F'));
  ok('contains stdbuf -oL grep -E', r.command.includes('stdbuf -oL grep -E'));
  ok('contains noise grep -Ev', r.command.includes('stdbuf -oL grep -Ev'));
  ok('embeds raw $(date) (not escaped)', r.command.includes('$(date +%Y-%m-%d)'));
  ok('error pattern single-quoted', /grep -E '"level":"error"\|\^ERROR'/.test(r.command), r.command);
}

console.log('\nbuildLogWatchCommand — rotating with no noise pattern:');
{
  const r = buildLogWatchCommand({
    logPathPattern: 'logs/app-$(date +%F).log',
    errorPattern: 'ERROR',
  });
  ok('shape=rotating', r.shape === 'rotating');
  ok('omits grep -Ev when noisePattern absent', !r.command.includes('grep -Ev'));
}

console.log('\nbuildLogWatchCommand — fixed:');
{
  const r = buildLogWatchCommand({
    logPathPattern: 'log/development.log',
    errorPattern: 'ERROR',
    noisePattern: 'deprecation',
  });
  ok('shape=fixed', r.shape === 'fixed');
  ok('NO while loop', !r.command.includes('while true'));
  ok('NO midnight calc', !r.command.includes('NEXT_MIDNIGHT'));
  ok('plain tail -F', r.command.includes('stdbuf -oL tail -F'));
  ok('quotes log path', r.command.includes("'log/development.log'"));
  ok('error pattern present', r.command.includes("'ERROR'"));
  ok('noise pattern present', r.command.includes("'deprecation'"));
}

console.log('\nbuildLogWatchCommand — escaping:');
{
  const r = buildLogWatchCommand({
    logPathPattern: 'log/app.log',
    errorPattern: "it's an error",
    noisePattern: undefined,
  });
  // Single quotes in the pattern must be escaped as '\'' to survive shell parsing.
  ok('escapes single quotes in error pattern', r.command.includes("'it'\\''s an error'"), r.command);
}

console.log('\nbuildLogWatchCommand — input validation:');
{
  let threw = false;
  try { buildLogWatchCommand({ logPathPattern: '', errorPattern: 'ERROR' }); }
  catch (_) { threw = true; }
  ok('throws on empty logPathPattern', threw);
}
{
  let threw = false;
  try { buildLogWatchCommand({ logPathPattern: 'x.log', errorPattern: '' }); }
  catch (_) { threw = true; }
  ok('throws on empty errorPattern', threw);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
