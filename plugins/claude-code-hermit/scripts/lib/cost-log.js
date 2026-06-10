'use strict';

// Hermit-owned cost-log index: incremental byte-offset tracking + corrupt-line counting.
// cc-compat.js owns the cost-log PATH only; this module owns the record shape and the index.
//
// Index schema (cost-index.json):
//   version               — schema version (bump on breaking changes)
//   byte_offset           — position in cost-log.jsonl after last processed line
//   total_cost_usd        — all-time cumulative cost
//   total_tokens          — all-time cumulative tokens
//   total_sessions        — count of unique hermit sessions ever seen
//   sessions_seen         — deduplicated array of all session_id values (drives total_sessions)
//   by_source             — {[source]: {cost, tokens}} buckets
//   by_date               — {[YYYY-MM-DD]: {cost, tokens, session_ids[]}} per-day aggregates
//   skipped_corrupt_lines — count of JSONL lines that failed JSON.parse (Known Limitation #3)
//   updated_at            — ISO timestamp of last index write
//
// Sole writer: cost-tracker.js (calls updateCostIndex after every log append).
// Readers: cost-tracker.js (writeCostSummary, getCumulativeCost fallback), doctor-check.js.

const fs = require('fs');
const path = require('path');

const INDEX_VERSION = 1;

function costIndexPath(hermitRoot) {
  return path.join(path.resolve(hermitRoot), 'cost-index.json');
}

function readCostIndex(indexPath) {
  try {
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    if (data && data.version === INDEX_VERSION) return data;
    return null;
  } catch {
    return null;
  }
}

function _emptyIndex() {
  return {
    version: INDEX_VERSION,
    byte_offset: 0,
    total_cost_usd: 0,
    total_tokens: 0,
    total_sessions: 0,
    sessions_seen: [],
    by_source: {},
    by_date: {},
    skipped_corrupt_lines: 0,
    updated_at: new Date().toISOString(),
  };
}

function _writeIndex(indexPath, index) {
  const tmp = indexPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, indexPath);
  return index;
}

// Process one log line into the index in-place.
// seenSet mirrors index.sessions_seen for O(1) dedup during a batch.
function _processLine(index, line, seenSet) {
  try {
    const entry = JSON.parse(line);
    const cost = entry.estimated_cost_usd || 0;
    const tokens = entry.total_tokens || 0;
    const sid = entry.session_id || null;
    const source = entry.source || 'other';
    const date = (entry.timestamp || '').slice(0, 10);

    index.total_cost_usd += cost;
    index.total_tokens += tokens;

    if (!index.by_source[source]) index.by_source[source] = { cost: 0, tokens: 0 };
    index.by_source[source].cost += cost;
    index.by_source[source].tokens += tokens;

    if (date) {
      if (!index.by_date[date]) index.by_date[date] = { cost: 0, tokens: 0, session_ids: [] };
      index.by_date[date].cost += cost;
      index.by_date[date].tokens += tokens;
      if (sid && !index.by_date[date].session_ids.includes(sid)) {
        index.by_date[date].session_ids.push(sid);
      }
    }

    if (sid && !seenSet.has(sid)) {
      seenSet.add(sid);
      index.sessions_seen.push(sid);
    }
  } catch {
    index.skipped_corrupt_lines++;
  }
}

// Full O(n) rebuild from scratch. Only called: first run, version mismatch, or log truncation.
function rebuildCostIndex(logPath, indexPath) {
  const index = _emptyIndex();
  const seenSet = new Set();

  let fileSize = 0;
  try {
    fileSize = fs.statSync(logPath).size;
  } catch {
    return _writeIndex(indexPath, index);
  }

  try {
    const content = fs.readFileSync(logPath, 'utf-8').trim();
    if (content) {
      for (const line of content.split('\n')) {
        if (line.trim()) _processLine(index, line, seenSet);
      }
    }
  } catch {
    // Non-fatal — partial read still gives partial totals
  }

  index.byte_offset = fileSize;
  index.total_sessions = index.sessions_seen.length;
  index.updated_at = new Date().toISOString();
  return _writeIndex(indexPath, index);
}

// Incremental update: read only bytes appended since last call. O(1) in the common case.
// Falls back to rebuildCostIndex when the index is missing, version-mismatched, or the log
// appears truncated (byte_offset > fileSize).
function updateCostIndex(logPath, indexPath) {
  let fileSize = 0;
  try {
    fileSize = fs.statSync(logPath).size;
  } catch {
    // Log absent — ensure an empty index exists and return it
    const existing = readCostIndex(indexPath);
    if (existing) return existing;
    const empty = _emptyIndex();
    empty.updated_at = new Date().toISOString();
    return _writeIndex(indexPath, empty);
  }

  const index = readCostIndex(indexPath);

  // Rebuild triggers
  if (!index || index.byte_offset > fileSize) {
    return rebuildCostIndex(logPath, indexPath);
  }

  // No new bytes
  if (index.byte_offset === fileSize) return index;

  // Read only the new bytes
  const newByteCount = fileSize - index.byte_offset;
  let text = '';
  try {
    const buf = Buffer.alloc(newByteCount);
    const fd = fs.openSync(logPath, 'r');
    fs.readSync(fd, buf, 0, newByteCount, index.byte_offset);
    fs.closeSync(fd);
    text = buf.toString('utf-8');
  } catch {
    // Non-fatal — skip this increment, try again next call
    return index;
  }

  const seenSet = new Set(index.sessions_seen);
  for (const line of text.split('\n')) {
    if (line.trim()) _processLine(index, line, seenSet);
  }

  index.byte_offset = fileSize;
  index.total_sessions = index.sessions_seen.length;
  index.updated_at = new Date().toISOString();
  return _writeIndex(indexPath, index);
}

module.exports = { costIndexPath, readCostIndex, updateCostIndex, rebuildCostIndex };
