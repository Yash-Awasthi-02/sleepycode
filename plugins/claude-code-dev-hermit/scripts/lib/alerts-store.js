'use strict';

// Shared atomic read/write helpers for .claude-code-hermit/state/alerts.json.
//
// Used by watchdog-health.js, watchdog-errors.js, and /dev-status.
// All mutations go through atomicAppendAlert so concurrent writers (two watchdog
// processes) never corrupt the file — each uses read-modify-write with a rename.

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const ALERTS_FILE = 'alerts.json';
const MAX_ALERTS = 50;

function alertsPath(stateDir) {
  return path.join(stateDir, ALERTS_FILE);
}

// Returns an Alert[]. Missing or malformed file → returns [].
function readAlerts(stateDir) {
  const p = alertsPath(stateDir);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    return []; // malformed — treat as empty
  }
}

// Appends one alert to alerts.json, prunes to MAX_ALERTS, writes atomically.
function atomicAppendAlert(stateDir, alert) {
  const p = alertsPath(stateDir);
  const tmp = p + '.tmp.' + randomBytes(4).toString('hex');
  // Ensure the state dir exists (first boot before /dev-up creates it).
  fs.mkdirSync(stateDir, { recursive: true });

  const existing = readAlerts(stateDir);
  existing.push(alert);
  // Keep only the most recent MAX_ALERTS entries (oldest are at the front).
  const pruned = existing.length > MAX_ALERTS
    ? existing.slice(existing.length - MAX_ALERTS)
    : existing;

  fs.writeFileSync(tmp, JSON.stringify(pruned, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p); // atomic on POSIX
}

// Returns true if an alert of the same kind+binding was emitted within intervalSecs * 4.
function isDuped(stateDir, kind, binding, intervalSecs) {
  const windowMs = intervalSecs * 4 * 1000;
  const alerts = readAlerts(stateDir);
  const last = [...alerts].reverse().find((a) => a.kind === kind && a.binding === binding);
  if (!last) return false;
  return Date.now() - new Date(last.created_at).getTime() < windowMs;
}

// Appends an alert unless a same-kind+binding event was emitted within the dedup window.
function emitAlert(stateDir, kind, binding, details, intervalSecs) {
  if (isDuped(stateDir, kind, binding, intervalSecs)) return;
  atomicAppendAlert(stateDir, {
    id: `evt-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(2).toString('hex')}`,
    kind,
    binding,
    created_at: new Date().toISOString(),
    details,
    acknowledged: false,
  });
}

// Sets acknowledged: true for the given alertId. No-op if not found.
function markAcknowledged(stateDir, alertId) {
  const p = alertsPath(stateDir);
  const tmp = p + '.tmp.' + randomBytes(4).toString('hex');
  const alerts = readAlerts(stateDir);
  let changed = false;
  for (const a of alerts) {
    if (a.id === alertId && !a.acknowledged) {
      a.acknowledged = true;
      changed = true;
    }
  }
  if (!changed) return;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(alerts, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

module.exports = { readAlerts, atomicAppendAlert, markAcknowledged, isDuped, emitAlert };
