'use strict';

const { shellQuote } = require('./shell-utils');

// Builds the bash pipeline that /dev-up Gate 5 hands to the Monitor tool:
//
//   { <dev_start>; } 2>&1 | tee <log_path> | grep --line-buffered -E <pattern> || true
//
// All three substitutions (dev_start, log_path, error_pattern) are passed
// through shellQuote / safe composition so operator-controlled config can
// never break out of the wrapper.
//
// `|| true` is on the grep stage so a healthy server (zero error matches)
// doesn't return exit 1 and tear down the pipeline.
//
// CLI: node scripts/lib/dev-server-command.js '<json>'

const DEFAULT_ERROR_PATTERN = [
  '^\\s*(Error|TypeError|ReferenceError|SyntaxError):',
  'EADDRINUSE',
  'Uncaught',
  'UnhandledPromiseRejection',
  'Cannot find module',
  '[Cc]ompilation failed',
  '[Bb]uild failed',
  '\\b[Ff]atal\\b',
  '\\bcrashed\\b',
  '\\bexception\\b',
].join('|');

function buildDevServerCommand({ devStart, logPath, errorPattern, cwd }) {
  if (typeof devStart !== 'string' || !devStart.trim()) {
    throw new Error('devStart is required');
  }
  if (typeof logPath !== 'string' || !logPath.trim()) {
    throw new Error('logPath is required');
  }
  const pattern =
    typeof errorPattern === 'string' && errorPattern.trim()
      ? errorPattern
      : DEFAULT_ERROR_PATTERN;
  const usedDefault = pattern === DEFAULT_ERROR_PATTERN;

  // When cwd is set, cd into it before launching the dev server so the process
  // reflects the agent's worktree branch rather than the operator's main checkout.
  //
  // The error-echo shape matters: bare `exit 1` would silently succeed because
  // tee and grep keep running over an empty stream and the pipeline exits 0 via
  // `|| true`. The `echo >&2` lands in the merged stdout (via 2>&1) so grep
  // catches the message and Monitor surfaces a visible failure notification.
  const hasCwd = typeof cwd === 'string' && cwd.trim();
  const cwdPart = hasCwd
    ? `cd ${shellQuote(cwd)} || { echo ${shellQuote(`[dev-up] Fatal: cd ${cwd} failed — worktree not found or inaccessible`)} >&2 ; exit 1 ; } ; `
    : '';

  // The cd-failed echo only surfaces if the operator's error pattern matches it.
  // DEFAULT_ERROR_PATTERN matches via \b[Ff]atal\b, but a custom pattern (e.g.
  // "EADDRINUSE|Build failed") might not. When cwd is set, OR an internal
  // sentinel onto the pattern so cd failures are always grep'd regardless of
  // the operator's choice. Otherwise the silent-failure mode this fix exists
  // to prevent reappears for anyone with a custom pattern.
  const effectivePattern = hasCwd
    ? `(${pattern})|\\[dev-up\\] Fatal: cd`
    : pattern;

  // dev_start runs inside `bash -c` so we don't quote it — operators write
  // shell there (e.g. `cd app && npm run dev`). We wrap it in `{ ...; }` so
  // 2>&1 redirects the whole compound, not just the last command.
  const inner =
    `{ ${cwdPart}${devStart}; } 2>&1` +
    ` | tee ${shellQuote(logPath)}` +
    ` | grep --line-buffered -E ${shellQuote(effectivePattern)} || true`;

  // Wrap in `bash -c` so callers can pass `command` as a single argument
  // without re-escaping the pipeline.
  const command = `bash -c ${shellQuote(inner)}`;

  return { command, pattern, usedDefault };
}

module.exports = { buildDevServerCommand, DEFAULT_ERROR_PATTERN };

if (require.main === module) {
  const arg = process.argv[2];
  if (!arg) {
    process.stderr.write(
      'usage: dev-server-command.js \'{"devStart":"...","logPath":"...","errorPattern":"..."}\'\n',
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
  const result = buildDevServerCommand(input);
  process.stdout.write(JSON.stringify(result) + '\n');
}
