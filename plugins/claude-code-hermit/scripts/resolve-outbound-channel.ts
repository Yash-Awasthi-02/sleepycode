#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';

type Json = any;

function eligible(ch: Json): boolean {
  if (!ch || typeof ch !== 'object') return false;
  if (ch.enabled === false) return false;
  if (Array.isArray(ch.allowed_users) && ch.allowed_users.length === 0) return false;
  return !!ch.dm_channel_id;
}

function resolve(channels: Json): { id: string; chat_id: string } | null {
  channels = channels || {};
  const primary = typeof channels.primary === 'string' ? channels.primary : null;
  if (primary && eligible(channels[primary])) {
    return { id: primary, chat_id: channels[primary].dm_channel_id };
  }
  // Fall back to first eligible channel in operator's config order.
  // No hardcoded slug list: a freshly installed channel plugin becomes
  // eligible the moment its config block lands in config.json.
  for (const [id, ch] of Object.entries(channels) as [string, Json][]) {
    if (id === 'primary') continue;
    if (eligible(ch)) {
      return { id, chat_id: ch.dm_channel_id };
    }
  }
  return null;
}

export { eligible, resolve };

if (import.meta.main) {
  const hermitDir = process.argv[2] || '.claude-code-hermit';
  const configPath = path.join(hermitDir, 'config.json');

  let config: Json;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e: any) {
    process.stderr.write(`resolve-outbound-channel: cannot read ${configPath}: ${e.message}\n`);
    process.stdout.write(JSON.stringify({ error: 'config_read_failed', detail: e.message, path: configPath }) + '\n');
    process.exit(1);
  }

  const result = resolve(config.channels);
  if (result) {
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  } else {
    process.stdout.write(JSON.stringify({ error: 'no_reachable_channel' }) + '\n');
    process.exit(1);
  }
}
