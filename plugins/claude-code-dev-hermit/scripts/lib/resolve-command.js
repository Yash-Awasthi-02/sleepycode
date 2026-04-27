'use strict';

// resolve-command.js
// Decides whether a configured command's binary resolves on PATH.
// Used by dev-doctor checks #5 (commands.test) and #15 (commands.dev_start).
//
// Library API:
//   const { resolveCommand } = require('./resolve-command');
//   resolveCommand('NODE_ENV=test pnpm test')
//   // → { resolved: true, binary: 'pnpm', reason: 'pnpm found in PATH' }
//
// CLI:
//   node scripts/lib/resolve-command.js "pnpm test"
//   prints JSON to stdout; exit 0 if resolved, 1 otherwise.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { shellQuote } = require('./shell-utils');

const WRAPPERS = new Set(['npx', 'bunx']);
const MULTI_WORD_WRAPPERS = [['pnpm', 'dlx'], ['yarn', 'dlx'], ['bun', 'x']];

function stripEnvAssignments(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
    i += 1;
  }
  return tokens.slice(i);
}

function tokenize(cmd) {
  // Conservative shell tokenizer: splits on whitespace, respects single/double quotes.
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i += 1) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else {
        cur += c;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/\s/.test(c)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function firstSegment(cmd) {
  // Split on `&&`, `||`, `;`, `|` and take the first non-empty segment.
  const re = /(\|\||&&|;|\|)/;
  const parts = cmd.split(re);
  for (const part of parts) {
    if (re.test(part)) continue;
    const trimmed = part.trim();
    if (trimmed) return trimmed;
  }
  return cmd.trim();
}

function effectiveBinary(tokens) {
  if (tokens.length === 0) return null;
  const first = tokens[0];
  if (WRAPPERS.has(first) && tokens.length >= 2) {
    return tokens[1];
  }
  for (const [a, b] of MULTI_WORD_WRAPPERS) {
    if (first === a && tokens[1] === b && tokens.length >= 3) {
      return tokens[2];
    }
  }
  return first;
}

function isOnDisk(token) {
  if (!token.includes('/')) return false;
  try {
    const stat = fs.statSync(path.resolve(token));
    return stat.isFile();
  } catch (_) {
    return false;
  }
}

function commandV(token) {
  // subprocess required: `command -v` is a shell builtin, not an executable.
  const result = spawnSync('bash', ['-c', `command -v -- ${shellQuote(token)}`], {
    encoding: 'utf-8',
  });
  return result.status === 0;
}

function resolveCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) {
    return { resolved: false, binary: null, reason: 'command is empty or non-string' };
  }

  const head = firstSegment(cmd);
  const tokens = stripEnvAssignments(tokenize(head));
  const binary = effectiveBinary(tokens);

  if (!binary) {
    return { resolved: false, binary: null, reason: 'no executable token after stripping env assignments' };
  }

  if (isOnDisk(binary)) {
    return { resolved: true, binary, reason: `${binary} resolves to an on-disk file` };
  }

  if (commandV(binary)) {
    return { resolved: true, binary, reason: `${binary} found in PATH` };
  }

  return { resolved: false, binary, reason: `${binary} not found in PATH and not an on-disk file` };
}

module.exports = { resolveCommand, tokenize, firstSegment, stripEnvAssignments, effectiveBinary };

if (require.main === module) {
  const cmd = process.argv.slice(2).join(' ');
  const result = resolveCommand(cmd);
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.resolved ? 0 : 1);
}
