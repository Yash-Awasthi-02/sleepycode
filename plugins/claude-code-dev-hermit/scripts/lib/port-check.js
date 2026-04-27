'use strict';

// port-check.js
// Probes whether configured ports are free, or held by an allowlisted process.
// Linux primary (lsof), with `ss` fallback for slim containers without lsof.
//
// Library API:
//   const { checkPorts } = require('./port-check');
//   checkPorts({ ports: [3000, 4000], expected: [{ port: 4000, process_match: 'encore' }] })
//   // → { tool: 'lsof', results: [
//   //      { port: 3000, status: 'free' },
//   //      { port: 4000, status: 'allowed', process: 'encore', pid: 12345 },
//   //    ] }
//
// CLI:
//   node scripts/lib/port-check.js '{"ports":[3000],"expected":[]}'
//   prints JSON to stdout; exit 0 if all free-or-allowed, 1 if any held by an
//   unexpected process, 2 if no probing tool available.

const { spawnSync } = require('child_process');

function detectTool() {
  const lsof = spawnSync('bash', ['-c', 'command -v lsof'], { encoding: 'utf-8' });
  if (lsof.status === 0) return 'lsof';
  const ss = spawnSync('bash', ['-c', 'command -v ss'], { encoding: 'utf-8' });
  if (ss.status === 0) return 'ss';
  return null;
}

function probeWithLsof(port) {
  // lsof -nP : numeric, no DNS / port name resolution.
  // -i :PORT -sTCP:LISTEN : LISTENing sockets bound to PORT.
  // +c0 : do not truncate COMMAND column.
  // -F pc : field-marker output: p=PID, c=COMMAND.
  const out = spawnSync('lsof', ['-nP', '-i', `:${port}`, '-sTCP:LISTEN', '+c0', '-F', 'pc'], {
    encoding: 'utf-8',
  });
  if (out.status !== 0 || !out.stdout) {
    return { listeners: [] };
  }
  // Field-marker output is line-oriented; each line starts with a single-char
  // field key followed by the value. Records start at lines beginning with `p`.
  const listeners = [];
  let cur = null;
  for (const line of out.stdout.split('\n')) {
    if (!line) continue;
    const key = line[0];
    const value = line.slice(1);
    if (key === 'p') {
      if (cur) listeners.push(cur);
      cur = { pid: Number(value), process: null };
    } else if (key === 'c' && cur) {
      cur.process = value;
    }
  }
  if (cur) listeners.push(cur);
  return { listeners };
}

function probeWithSs(port) {
  // ss -ltnpH : -l listening, -t tcp, -n numeric, -p show process, -H no header.
  // Filter on local port equal to PORT.
  const out = spawnSync('ss', ['-ltnpH', `( sport = :${port} )`], {
    encoding: 'utf-8',
  });
  if (out.status !== 0 || !out.stdout) {
    return { listeners: [] };
  }
  // Line shape (after -H): State Recv-Q Send-Q Local Remote Process
  // Process column looks like: users:(("encore",pid=12345,fd=8))
  const listeners = [];
  for (const line of out.stdout.split('\n')) {
    if (!line.trim()) continue;
    const userMatch = line.match(/users:\(\("([^"]+)",pid=(\d+),fd=\d+\)/);
    if (userMatch) {
      listeners.push({ pid: Number(userMatch[2]), process: userMatch[1] });
    } else {
      // Listener present but without process info (insufficient privilege).
      listeners.push({ pid: null, process: null });
    }
  }
  return { listeners };
}

function matchesAllowlist(listener, expectedForPort) {
  if (!expectedForPort || !listener.process) return false;
  let re;
  try {
    re = new RegExp(expectedForPort.process_match);
  } catch (_) {
    return false;
  }
  return re.test(listener.process);
}

function checkPorts({ ports, expected, tool, _probe }) {
  const probeFn = _probe || (tool === 'ss' ? probeWithSs : probeWithLsof);
  const expectedByPort = new Map();
  for (const e of expected || []) {
    expectedByPort.set(e.port, e);
  }
  const results = [];
  for (const port of ports || []) {
    const { listeners } = probeFn(port);
    if (listeners.length === 0) {
      results.push({ port, status: 'free' });
      continue;
    }
    const exp = expectedByPort.get(port);
    // SO_REUSEPORT can produce multiple listeners on one port. Treat the port
    // as allowed if ANY listener matches the allowlist regex; otherwise report
    // it as held with the first listener as the human-readable witness.
    const matched = listeners.find((l) => matchesAllowlist(l, exp));
    if (matched) {
      results.push({
        port,
        status: 'allowed',
        process: matched.process,
        pid: matched.pid,
        match: exp.process_match,
      });
    } else {
      const first = listeners[0];
      results.push({ port, status: 'held', process: first.process, pid: first.pid });
    }
  }
  return { tool: tool || (probeFn === probeWithSs ? 'ss' : 'lsof'), results };
}

module.exports = {
  checkPorts,
  probeWithLsof,
  probeWithSs,
  matchesAllowlist,
  detectTool,
};

if (require.main === module) {
  const arg = process.argv[2];
  if (!arg) {
    process.stderr.write('usage: port-check.js \'{"ports":[3000],"expected":[]}\'\n');
    process.exit(2);
  }
  const tool = detectTool();
  if (!tool) {
    process.stdout.write(JSON.stringify({ error: 'no probing tool available (need lsof or ss)' }) + '\n');
    process.exit(2);
  }
  let input;
  try {
    input = JSON.parse(arg);
  } catch (e) {
    process.stderr.write(`invalid JSON: ${e.message}\n`);
    process.exit(2);
  }
  const result = checkPorts({ ports: input.ports, expected: input.expected, tool });
  process.stdout.write(JSON.stringify(result) + '\n');
  const anyHeld = result.results.some((r) => r.status === 'held');
  process.exit(anyHeld ? 1 : 0);
}
