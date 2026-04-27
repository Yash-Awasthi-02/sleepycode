'use strict';

// health-poll.js
// Polls an HTTP(S) URL until it returns a 2xx response or a timeout elapses.
// Used by /dev-up Gate 6.
//
// Library API:
//   const { pollHealth } = require('./health-poll');
//   await pollHealth({ url, timeoutSecs: 30, intervalMs: 1000 });
//   // → { ok: true, status: 200, elapsedMs: 4123 }
//
// CLI:
//   node scripts/lib/health-poll.js <url> <timeoutSecs>
//   prints JSON to stdout; exit 0 on 2xx, 1 on timeout.

const http = require('http');
const https = require('https');
const { URL } = require('url');

function probeOnce(urlStr, perRequestTimeoutMs) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      resolve({ ok: false, status: null, error: `invalid url: ${e.message}` });
      return;
    }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      { method: 'GET', timeout: perRequestTimeoutMs, headers: { 'User-Agent': 'dev-hermit/health-poll' } },
      (res) => {
        // Drain body so the socket can close cleanly.
        res.resume();
        const status = res.statusCode || 0;
        resolve({ ok: status >= 200 && status < 300, status });
      },
    );
    req.on('error', (err) => {
      resolve({ ok: false, status: null, error: err.code || err.message });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: null, error: 'request_timeout' });
    });
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollHealth({ url, timeoutSecs = 30, intervalMs = 1000, perRequestTimeoutMs = 2000, _probe }) {
  const start = Date.now();
  const deadline = start + timeoutSecs * 1000;
  const probe = _probe || probeOnce;
  let last = { ok: false, status: null, error: 'no probe attempted' };

  while (Date.now() < deadline) {
    last = await probe(url, perRequestTimeoutMs);
    if (last.ok) {
      return { ok: true, status: last.status, elapsedMs: Date.now() - start };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  return {
    ok: false,
    status: last.status,
    elapsedMs: Date.now() - start,
    error: last.error || `last status ${last.status}`,
  };
}

module.exports = { pollHealth, probeOnce };

if (require.main === module) {
  const url = process.argv[2];
  const timeoutSecs = Number(process.argv[3] || 30);
  if (!url) {
    process.stderr.write('usage: health-poll.js <url> [timeoutSecs=30]\n');
    process.exit(2);
  }
  pollHealth({ url, timeoutSecs }).then((result) => {
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(result.ok ? 0 : 1);
  });
}
