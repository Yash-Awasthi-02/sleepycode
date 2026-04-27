'use strict';

// Tests for health-poll.js — run with: node scripts/lib/health-poll.test.js

const { pollHealth } = require('./health-poll');

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

// Sequence-driven fake probe: returns the next response per call, then sticks on the last.
function makeFakeProbe(sequence) {
  let i = 0;
  return async (_url, _timeoutMs) => {
    const idx = Math.min(i, sequence.length - 1);
    i += 1;
    return sequence[idx];
  };
}

async function run() {
  console.log('\npollHealth:');

  {
    const probe = makeFakeProbe([{ ok: true, status: 200 }]);
    const result = await pollHealth({ url: 'http://x', timeoutSecs: 5, intervalMs: 10, _probe: probe });
    ok('first probe 200 → success fast', result.ok && result.status === 200, JSON.stringify(result));
  }

  {
    const probe = makeFakeProbe([
      { ok: false, status: null, error: 'ECONNREFUSED' },
      { ok: false, status: null, error: 'ECONNREFUSED' },
      { ok: true, status: 200 },
    ]);
    const result = await pollHealth({ url: 'http://x', timeoutSecs: 5, intervalMs: 10, _probe: probe });
    ok('eventual success after retries', result.ok && result.status === 200, JSON.stringify(result));
  }

  {
    const probe = makeFakeProbe([{ ok: false, status: null, error: 'ECONNREFUSED' }]);
    const result = await pollHealth({ url: 'http://x', timeoutSecs: 0.2, intervalMs: 50, _probe: probe });
    ok('timeout returns ok=false', !result.ok, JSON.stringify(result));
    ok('timeout reports error', /ECONNREFUSED/.test(result.error), result.error);
    ok('timeout reports elapsedMs', typeof result.elapsedMs === 'number' && result.elapsedMs > 0, String(result.elapsedMs));
  }

  {
    const probe = makeFakeProbe([{ ok: false, status: 503 }]);
    const result = await pollHealth({ url: 'http://x', timeoutSecs: 0.2, intervalMs: 50, _probe: probe });
    ok('5xx never satisfies health', !result.ok, JSON.stringify(result));
  }

  {
    const probe = makeFakeProbe([{ ok: false, status: 404 }]);
    const result = await pollHealth({ url: 'http://x', timeoutSecs: 0.2, intervalMs: 50, _probe: probe });
    ok('4xx never satisfies health', !result.ok && result.status === 404, JSON.stringify(result));
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
