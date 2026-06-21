// Append-only JSONL helper — appends one line and exits.
// Zero npm dependencies, Node stdlib only.
//
// Usage (argv):  bun append-metrics.ts <jsonl-file-path> '<json-event>'
//   — argv[3] is reserved for enum/id/count/slug/numeric values only.
//     Apostrophes cannot appear in those payloads, so single-quoting is safe.
//
// Usage (stdin): bun append-metrics.ts <jsonl-file-path> <<'HERMIT_METRICS_JSON'
//                <json-event>
//                HERMIT_METRICS_JSON
//   — required for free-text payloads (question, pattern labels, prose values)
//     where apostrophes in single-quoted argv would corrupt the shell command.

import fs from 'node:fs';

const filePath = process.argv[2];

if (!filePath) {
  console.error("Usage: bun append-metrics.ts <jsonl-file-path> '<json-event>'");
  process.exit(1);
}

function append(eventJson: string): void {
  if (!eventJson) {
    console.error('Error: event payload is empty');
    process.exit(1);
  }
  // Validate JSON before appending
  try {
    JSON.parse(eventJson);
  } catch (err: any) {
    console.error(`Invalid JSON: ${err.message}`);
    process.exit(1);
  }
  fs.appendFileSync(filePath!, eventJson + '\n', 'utf-8');
}

if (process.argv[3] !== undefined) {
  // Argv mode — synchronous, for enum/id/count/slug/numeric payloads.
  append(process.argv[3]);
} else {
  // Stdin mode — for free-text payloads that may contain apostrophes.
  // Deliver via quoted heredoc: <<'HERMIT_METRICS_JSON' ... HERMIT_METRICS_JSON
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { buf += chunk; });
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => { append(buf.trim()); });
}
