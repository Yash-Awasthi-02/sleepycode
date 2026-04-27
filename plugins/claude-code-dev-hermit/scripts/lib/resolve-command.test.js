'use strict';

// Tests for resolve-command.js — run with: node scripts/lib/resolve-command.test.js

const { spawnSync } = require('child_process');
const path = require('path');
const {
  resolveCommand,
  tokenize,
  firstSegment,
  stripEnvAssignments,
  effectiveBinary,
} = require('./resolve-command');

const SCRIPT = path.join(__dirname, 'resolve-command.js');

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

console.log('\ntokenize:');
eq('plain words', tokenize('pnpm test'), ['pnpm', 'test']);
eq('respects single quotes', tokenize("echo 'hello world'"), ['echo', 'hello world']);
eq('respects double quotes', tokenize('echo "hello world"'), ['echo', 'hello world']);
eq('collapses whitespace', tokenize('a   b\tc'), ['a', 'b', 'c']);

console.log('\nfirstSegment:');
eq('no operator', firstSegment('pnpm test'), 'pnpm test');
eq('splits on &&', firstSegment('pnpm build && pnpm test'), 'pnpm build');
eq('splits on ;', firstSegment('cd app; pnpm test'), 'cd app');
eq('splits on |', firstSegment('cat foo | grep bar'), 'cat foo');
eq('splits on ||', firstSegment('first || second'), 'first');

console.log('\nstripEnvAssignments:');
eq('no env', stripEnvAssignments(['pnpm', 'test']), ['pnpm', 'test']);
eq('one env', stripEnvAssignments(['NODE_ENV=test', 'pnpm', 'test']), ['pnpm', 'test']);
eq('multiple env', stripEnvAssignments(['A=1', 'B=2', 'pnpm', 'test']), ['pnpm', 'test']);
eq('= elsewhere preserved', stripEnvAssignments(['pnpm', 'test', '--filter=app']), ['pnpm', 'test', '--filter=app']);

console.log('\neffectiveBinary:');
eq('plain command', effectiveBinary(['pnpm', 'test']), 'pnpm');
eq('npx wrapper', effectiveBinary(['npx', 'jest']), 'jest');
eq('bunx wrapper', effectiveBinary(['bunx', 'vitest']), 'vitest');
eq('pnpm dlx', effectiveBinary(['pnpm', 'dlx', 'jest']), 'jest');
eq('yarn dlx', effectiveBinary(['yarn', 'dlx', 'jest']), 'jest');
eq('bun x', effectiveBinary(['bun', 'x', 'vitest']), 'vitest');
eq('pnpm test (NOT pnpm dlx)', effectiveBinary(['pnpm', 'test']), 'pnpm');
eq('lone npx', effectiveBinary(['npx']), 'npx');

console.log('\nresolveCommand (live PATH probes):');
const nodeRes = resolveCommand('node --version');
ok('node resolves on PATH', nodeRes.resolved && nodeRes.binary === 'node', JSON.stringify(nodeRes));

const stripped = resolveCommand('NODE_ENV=test node --version');
ok('strips env, resolves node', stripped.resolved && stripped.binary === 'node', JSON.stringify(stripped));

const compound = resolveCommand('node --version && echo done');
ok('compound, first segment', compound.resolved && compound.binary === 'node', JSON.stringify(compound));

const missing = resolveCommand('definitely-not-a-real-binary-x9k7q');
ok('missing binary fails', !missing.resolved && /not found/.test(missing.reason), JSON.stringify(missing));

const empty = resolveCommand('');
ok('empty fails', !empty.resolved && /empty/.test(empty.reason), JSON.stringify(empty));

const onlyEnv = resolveCommand('FOO=bar BAZ=qux');
ok('only env assignments fails', !onlyEnv.resolved, JSON.stringify(onlyEnv));

console.log('\nCLI shape:');
const cliPass = spawnSync(process.execPath, [SCRIPT, 'node', '--version'], { encoding: 'utf-8' });
ok('CLI exits 0 on resolved', cliPass.status === 0, `status=${cliPass.status}, stdout=${cliPass.stdout}`);
ok('CLI emits JSON on stdout', /\{"resolved":true/.test(cliPass.stdout), cliPass.stdout);

const cliFail = spawnSync(process.execPath, [SCRIPT, 'definitely-not-a-real-binary-x9k7q'], { encoding: 'utf-8' });
ok('CLI exits 1 on unresolved', cliFail.status === 1, `status=${cliFail.status}`);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
