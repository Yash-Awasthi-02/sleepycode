/**
 * Shared tmux helpers for the lifecycle scripts
 * (hermit-start, hermit-stop, hermit-watchdog).
 */

import path from 'node:path';
import { spawnSync } from 'node:child_process';

type Json = any;

/** Return true when the named tmux session exists. */
export function tmuxSessionAlive(name: string): boolean {
  return spawnSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' }).status === 0;
}

/** Derive the tmux session name from config (CWD-relative project name). */
export function getSessionName(config: Json): string {
  const name = config.tmux_session_name ?? 'hermit-{project_name}';
  return String(name).replaceAll('{project_name}', path.basename(process.cwd()));
}
