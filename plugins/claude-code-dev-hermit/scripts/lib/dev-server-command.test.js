'use strict';

// Tests for dev-server-command.js — run with: node scripts/lib/dev-server-command.test.js

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildDevServerCommand,
  DEFAULT_ERROR_PATTERN,
} = require('./dev-server-command');

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

console.log('\nbuildDevServerCommand — input validation:');
{
  let threw = false;
  try {
    buildDevServerCommand({ devStart: '', logPath: 'x', errorPattern: 'x' });
  } catch (e) {
    threw = e.message.includes('devStart');
  }
  ok('throws on empty devStart', threw);
}
{
  let threw = false;
  try {
    buildDevServerCommand({ devStart: 'x', logPath: '', errorPattern: 'x' });
  } catch (e) {
    threw = e.message.includes('logPath');
  }
  ok('throws on empty logPath', threw);
}

console.log('\nbuildDevServerCommand — defaulting:');
{
  const r = buildDevServerCommand({
    devStart: 'npm run dev',
    logPath: '.claude-code-hermit/state/dev-server.log',
  });
  ok('omitted errorPattern → uses default', r.pattern === DEFAULT_ERROR_PATTERN);
  ok('omitted errorPattern → usedDefault: true', r.usedDefault === true);
}
{
  const r = buildDevServerCommand({
    devStart: 'npm run dev',
    logPath: 'log',
    errorPattern: '   ',
  });
  ok('whitespace errorPattern → uses default', r.pattern === DEFAULT_ERROR_PATTERN);
}
{
  const r = buildDevServerCommand({
    devStart: 'npm run dev',
    logPath: 'log',
    errorPattern: 'CUSTOM',
  });
  ok('explicit errorPattern → preserved', r.pattern === 'CUSTOM');
  ok('explicit errorPattern → usedDefault: false', r.usedDefault === false);
}

console.log('\nbuildDevServerCommand — shape:');
{
  const r = buildDevServerCommand({
    devStart: 'npm run dev',
    logPath: '.claude-code-hermit/state/dev-server.log',
    errorPattern: 'PAT',
  });
  ok("starts with 'bash -c '", r.command.startsWith('bash -c '));
  ok('contains tee', /\| tee /.test(r.command));
  ok('contains grep --line-buffered -E', /\| grep --line-buffered -E /.test(r.command));
  ok('terminates with || true (inside the inner script)', / \|\| true'$/.test(r.command));
  ok('redirects 2>&1 inside braces', /\{ npm run dev; \} 2>&1/.test(r.command));
}

console.log('\nbuildDevServerCommand — shell-escaping safety:');
{
  // dev_start with embedded single quote (e.g. `bash -c 'cd app && npm run dev'`)
  const r = buildDevServerCommand({
    devStart: "bash -c 'cd app && npm run dev'",
    logPath: 'log',
    errorPattern: 'PAT',
  });
  // Round-trip through bash -n: must parse cleanly even though dev_start has quotes.
  const out = execFileSync('bash', ['-n', '-c', stripBashC(r.command)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ok('dev_start with single quote → bash -n parses', true);
}
{
  // error_pattern with quotes and shell metacharacters
  const r = buildDevServerCommand({
    devStart: 'npm run dev',
    logPath: 'log',
    errorPattern: 'EADDRINUSE|"port in use"|`oops`',
  });
  execFileSync('bash', ['-n', '-c', stripBashC(r.command)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ok('error_pattern with quotes/backticks → bash -n parses', true);
}
{
  // log_path with a space
  const r = buildDevServerCommand({
    devStart: 'npm run dev',
    logPath: 'state dir/dev server.log',
    errorPattern: 'PAT',
  });
  execFileSync('bash', ['-n', '-c', stripBashC(r.command)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ok('log_path with space → bash -n parses', true);
}

console.log('\nbuildDevServerCommand — runtime smoke:');
{
  // Run the assembled command in a real shell. Use a fake dev_start that
  // emits 1 matching error line + 1 noise line, then exits. Verify the log
  // file gets both lines and the pipeline exits cleanly even when grep
  // matches some lines.
  const tmpLog = path.join(os.tmpdir(), `dev-server-test-${process.pid}.log`);
  try { fs.unlinkSync(tmpLog); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const r = buildDevServerCommand({
    devStart: "printf 'startup ok\\nEADDRINUSE: port 3000\\nshutting down\\n'",
    logPath: tmpLog,
    errorPattern: 'EADDRINUSE',
  });
  const stdout = execFileSync('bash', ['-c', stripBashC(r.command)], {
    encoding: 'utf8',
  });
  const log = fs.readFileSync(tmpLog, 'utf8');
  ok('full output captured to log file', /startup ok/.test(log) && /EADDRINUSE/.test(log));
  ok('only matched lines reach stdout', /EADDRINUSE/.test(stdout) && !/startup ok/.test(stdout));
  fs.unlinkSync(tmpLog);
}
{
  // Healthy server (zero error matches) must still exit 0 thanks to `|| true`.
  const tmpLog = path.join(os.tmpdir(), `dev-server-test-healthy-${process.pid}.log`);
  try { fs.unlinkSync(tmpLog); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const r = buildDevServerCommand({
    devStart: "printf 'all good\\nlistening on :3000\\n'",
    logPath: tmpLog,
    errorPattern: 'WILL_NEVER_MATCH',
  });
  let exit = null;
  try {
    execFileSync('bash', ['-c', stripBashC(r.command)], { encoding: 'utf8' });
    exit = 0;
  } catch (e) {
    exit = e.status;
  }
  ok('zero matches → pipeline still exits 0 (|| true guard)', exit === 0);
  fs.unlinkSync(tmpLog);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

// Strip the outer `bash -c '...'` wrapper so we can re-feed the inner script
// directly to a fresh bash process without double-evaluating quotes.
function stripBashC(cmd) {
  const m = cmd.match(/^bash -c '([\s\S]*)'$/);
  if (!m) throw new Error('command does not match `bash -c ...` shape');
  // Reverse the shellQuote escaping: `'\''` → `'`
  return m[1].replace(/'\\''/g, "'");
}
