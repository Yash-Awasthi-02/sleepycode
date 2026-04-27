'use strict';

// Tests for port-check.js — run with: node scripts/lib/port-check.test.js

const { checkPorts, matchesAllowlist } = require('./port-check');

let passed = 0;
let failed = 0;

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✓ ${name}`);
    passed += 1;
  } else {
    console.error(`  ✗ ${name}\n      expected ${e}\n      got      ${a}`);
    failed += 1;
  }
}

function ok(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed += 1;
  } else {
    console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    failed += 1;
  }
}

// Build a fake probe over a fixture map: { port: [{ pid, process }] }
function fakeProbe(fixture) {
  return (port) => ({ listeners: fixture[port] || [] });
}

console.log('\nmatchesAllowlist:');
ok(
  'plain match',
  matchesAllowlist({ pid: 1, process: 'encore' }, { port: 4000, process_match: 'encore' }),
);
ok(
  'regex match',
  matchesAllowlist({ pid: 1, process: 'encore-daemon' }, { port: 4000, process_match: '^encore' }),
);
ok(
  'no expected entry → no match',
  !matchesAllowlist({ pid: 1, process: 'encore' }, undefined),
);
ok(
  'null process → no match',
  !matchesAllowlist({ pid: 1, process: null }, { port: 4000, process_match: 'encore' }),
);
ok(
  'invalid regex → no match (not a throw)',
  !matchesAllowlist({ pid: 1, process: 'encore' }, { port: 4000, process_match: '[invalid' }),
);

console.log('\ncheckPorts (mocked probe):');

eq(
  'all ports free',
  checkPorts({
    ports: [3000, 4000],
    expected: [],
    _probe: fakeProbe({}),
  }),
  {
    tool: 'lsof',
    results: [
      { port: 3000, status: 'free' },
      { port: 4000, status: 'free' },
    ],
  },
);

eq(
  'port 3000 held by python3',
  checkPorts({
    ports: [3000],
    expected: [],
    _probe: fakeProbe({ 3000: [{ pid: 99, process: 'python3' }] }),
  }),
  {
    tool: 'lsof',
    results: [{ port: 3000, status: 'held', process: 'python3', pid: 99 }],
  },
);

eq(
  'port 4000 held by encore (allowed)',
  checkPorts({
    ports: [4000],
    expected: [{ port: 4000, process_match: 'encore' }],
    _probe: fakeProbe({ 4000: [{ pid: 12345, process: 'encore' }] }),
  }),
  {
    tool: 'lsof',
    results: [
      { port: 4000, status: 'allowed', process: 'encore', pid: 12345, match: 'encore' },
    ],
  },
);

eq(
  'mixed: 3000 free, 4000 allowed, 5000 held',
  checkPorts({
    ports: [3000, 4000, 5000],
    expected: [{ port: 4000, process_match: 'encore' }],
    _probe: fakeProbe({
      4000: [{ pid: 12345, process: 'encore' }],
      5000: [{ pid: 999, process: 'something-else' }],
    }),
  }),
  {
    tool: 'lsof',
    results: [
      { port: 3000, status: 'free' },
      { port: 4000, status: 'allowed', process: 'encore', pid: 12345, match: 'encore' },
      { port: 5000, status: 'held', process: 'something-else', pid: 999 },
    ],
  },
);

eq(
  'expected for wrong port → falls through',
  checkPorts({
    ports: [3000],
    expected: [{ port: 4000, process_match: 'encore' }],
    _probe: fakeProbe({ 3000: [{ pid: 99, process: 'encore' }] }),
  }),
  {
    tool: 'lsof',
    results: [{ port: 3000, status: 'held', process: 'encore', pid: 99 }],
  },
);

eq(
  'allowed by regex match',
  checkPorts({
    ports: [4000],
    expected: [{ port: 4000, process_match: '^encore' }],
    _probe: fakeProbe({ 4000: [{ pid: 12345, process: 'encore-daemon' }] }),
  }),
  {
    tool: 'lsof',
    results: [
      { port: 4000, status: 'allowed', process: 'encore-daemon', pid: 12345, match: '^encore' },
    ],
  },
);

eq(
  'SO_REUSEPORT: allowed if ANY listener matches',
  checkPorts({
    ports: [8080],
    expected: [{ port: 8080, process_match: '^worker$' }],
    _probe: fakeProbe({
      // Three workers behind SO_REUSEPORT — any one matching is enough.
      8080: [
        { pid: 100, process: 'something-else' },
        { pid: 101, process: 'worker' },
        { pid: 102, process: 'something-else' },
      ],
    }),
  }),
  {
    tool: 'lsof',
    results: [
      { port: 8080, status: 'allowed', process: 'worker', pid: 101, match: '^worker$' },
    ],
  },
);

eq(
  'SO_REUSEPORT: held if NO listener matches',
  checkPorts({
    ports: [8080],
    expected: [{ port: 8080, process_match: 'worker' }],
    _probe: fakeProbe({
      8080: [
        { pid: 100, process: 'nginx' },
        { pid: 101, process: 'haproxy' },
      ],
    }),
  }),
  {
    tool: 'lsof',
    results: [
      // First listener is the human-readable witness.
      { port: 8080, status: 'held', process: 'nginx', pid: 100 },
    ],
  },
);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
