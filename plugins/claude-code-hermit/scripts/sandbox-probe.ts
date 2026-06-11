#!/usr/bin/env bun
/**
 * Sandbox capability probe for hermit.
 *
 * Checks whether the Claude Code sandbox can run on this machine:
 * - macOS: PASS unconditionally (sandbox-exec is built in, no extra binaries needed)
 * - Linux/WSL2: checks bwrap + socat presence and user-namespace availability
 *
 * Prints a single JSON object to stdout:
 *   {"status": "pass"|"warn"|"fail", "message": "...", "install_hint": "..."|null}
 *
 * Always exits 0 — callers inspect .status, not the exit code.
 */

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

type ProbeResult = { status: 'pass' | 'warn' | 'fail'; message: string; install_hint: string | null };

// Return the install one-liner for bubblewrap+socat on this distro.
function detectPkgManager(osReleaseText?: string): string {
  let text: string;
  if (osReleaseText !== undefined) {
    text = osReleaseText;
  } else {
    try {
      text = fs.readFileSync('/etc/os-release', 'utf-8');
    } catch {
      return 'install bubblewrap socat (check your package manager)';
    }
  }

  const info: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i === -1) continue;
    info[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
  }

  const distroId = (info['ID'] || '').toLowerCase();
  const distroLike = (info['ID_LIKE'] || '').toLowerCase();

  if (distroId.includes('debian') || distroId.includes('ubuntu') || distroLike.includes('debian')) {
    return 'apt-get install -y bubblewrap socat';
  }
  if (distroId.includes('fedora') || distroId.includes('rhel') || distroId.includes('centos') || distroLike.includes('rhel')) {
    return 'dnf install -y bubblewrap socat';
  }
  if (distroId.includes('arch')) {
    return 'pacman -S --noconfirm bubblewrap socat';
  }
  if (distroId.includes('alpine')) {
    return 'apk add bubblewrap socat';
  }
  return 'install bubblewrap socat (check your package manager)';
}

// Return true if cmd exits 0 within 5 s.
function runOk(cmd: string[]): boolean {
  try {
    const r = spawnSync(cmd[0], cmd.slice(1), { timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

function probe(): ProbeResult {
  // macOS: sandbox-exec is built in.
  if (process.platform === 'darwin') {
    return {
      status: 'pass',
      message: 'macOS: sandbox-exec is built in, no extra binaries needed.',
      install_hint: null,
    };
  }

  // Linux / WSL2: check bwrap and socat.
  const missing = ['bwrap', 'socat'].filter((b) => !Bun.which(b));
  if (missing.length > 0) {
    return {
      status: 'fail',
      message: `Missing: ${missing.join(', ')}. Sandbox will silently degrade.`,
      install_hint: detectPkgManager(),
    };
  }

  // Check unprivileged user-namespace access (required by bwrap on most Linux kernels).
  if (!runOk(['unshare', '--user', '--pid', 'true'])) {
    return {
      status: 'warn',
      message:
        'bwrap and socat found, but unprivileged user-namespaces appear disabled. ' +
        'Sandbox may not start. ' +
        'On Ubuntu 24.04+ the cause is the AppArmor restriction on bwrap (install ' +
        'the bwrap AppArmor profile per the Claude Code sandbox docs). ' +
        'On older kernels the cause is `kernel.unprivileged_userns_clone=0` ' +
        '(enable with `sysctl -w kernel.unprivileged_userns_clone=1`).',
      install_hint:
        'Ubuntu 24.04+: install /etc/apparmor.d/bwrap (see ' +
        'https://code.claude.com/docs/en/sandboxing#set-up-linux-and-wsl2). ' +
        'Older kernels: sysctl -w kernel.unprivileged_userns_clone=1.',
    };
  }

  return {
    status: 'pass',
    message: 'bwrap, socat, and user-namespaces OK.',
    install_hint: null,
  };
}

export { probe, detectPkgManager };

if (import.meta.main) {
  console.log(JSON.stringify(probe()));
  process.exit(0);
}
