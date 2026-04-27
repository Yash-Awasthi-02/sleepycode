'use strict';

const { shellQuote } = require('./shell-utils');

// log-watch-builder.js
// Builds the canonical bash one-liner for a Monitor entry that tails a log
// for error patterns. Handles two cases:
//   1. Date-templated path (e.g., logs/app-$(date +%Y-%m-%d).log) →
//      while-loop wrapper with midnight rollover (verbatim from
//      docs/DEV-LOG-WATCH.md).
//   2. Fixed path (e.g., log/development.log) → plain `tail -F`, no wrapper.
//
// Library API:
//   const { buildLogWatchCommand } = require('./log-watch-builder');
//   buildLogWatchCommand({
//     logPathPattern: 'logs/app-$(date +%Y-%m-%d).log',
//     errorPattern: '"level":"error"|^ERROR',
//     noisePattern: '0 errors|deprecation',
//   })
//   // → { command: '<bash one-liner>', shape: 'rotating' }
//
// CLI:
//   node scripts/lib/log-watch-builder.js '{"logPathPattern":"...","errorPattern":"..."}'

function isRotatingPattern(pattern) {
  return /\$\(date\b/.test(pattern);
}

function buildRotating({ logPathPattern, errArg, noiseStage }) {
  // `$(date ...)` in logPathPattern must remain literal so the shell re-evaluates
  // it each loop iteration — embed as-is rather than single-quoting.
  return [
    'while true; do',
    `  LOG="${logPathPattern}"`,
    "  NEXT_MIDNIGHT=$(date -d 'tomorrow 00:00:00' +%s 2>/dev/null \\",
    '    || date -v+1d -v0H -v0M -v0S +%s)',
    '  NOW=$(date +%s)',
    '  SECS=$(( NEXT_MIDNIGHT - NOW ))',
    '  [ "$SECS" -le 0 ] && SECS=60',
    '  timeout "${SECS}s" \\',
    '    stdbuf -oL tail -F "$LOG" 2>/dev/null \\',
    `    | stdbuf -oL grep -E ${errArg}${noiseStage}`,
    'done',
  ].join('\n');
}

function buildFixed({ logPathPattern, errArg, noiseStage }) {
  return [
    `stdbuf -oL tail -F ${shellQuote(logPathPattern)} 2>/dev/null \\`,
    `  | stdbuf -oL grep -E ${errArg}${noiseStage}`,
  ].join('\n');
}

function buildLogWatchCommand({ logPathPattern, errorPattern, noisePattern }) {
  if (typeof logPathPattern !== 'string' || !logPathPattern.trim()) {
    throw new Error('logPathPattern is required');
  }
  if (typeof errorPattern !== 'string' || !errorPattern.trim()) {
    throw new Error('errorPattern is required');
  }
  const rotating = isRotatingPattern(logPathPattern);
  const errArg = shellQuote(errorPattern);
  const noiseStage = noisePattern
    ? ` | stdbuf -oL grep -Ev ${shellQuote(noisePattern)}`
    : '';
  const command = rotating
    ? buildRotating({ logPathPattern, errArg, noiseStage })
    : buildFixed({ logPathPattern, errArg, noiseStage });
  return { command, shape: rotating ? 'rotating' : 'fixed' };
}

module.exports = { buildLogWatchCommand, isRotatingPattern };

if (require.main === module) {
  const arg = process.argv[2];
  if (!arg) {
    process.stderr.write(
      'usage: log-watch-builder.js \'{"logPathPattern":"...","errorPattern":"...","noisePattern":"..."}\'\n',
    );
    process.exit(2);
  }
  let input;
  try {
    input = JSON.parse(arg);
  } catch (e) {
    process.stderr.write(`invalid JSON: ${e.message}\n`);
    process.exit(2);
  }
  const result = buildLogWatchCommand(input);
  process.stdout.write(JSON.stringify(result) + '\n');
}
