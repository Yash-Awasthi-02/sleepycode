import { describe, test, expect } from 'bun:test';
import path from 'node:path';
import { detectPkgManager } from '../scripts/sandbox-probe';
import { SCRIPTS_DIR } from './helpers/run';

describe('sandbox-probe', () => {
  describe('detectPkgManager (in-process)', () => {
    test('debian/ubuntu → apt-get', () => {
      expect(detectPkgManager('ID=ubuntu\nID_LIKE=debian\n')).toBe('apt-get install -y bubblewrap socat');
      expect(detectPkgManager('ID=debian\n')).toBe('apt-get install -y bubblewrap socat');
    });
    test('fedora/rhel-like → dnf', () => {
      expect(detectPkgManager('ID=fedora\n')).toBe('dnf install -y bubblewrap socat');
      expect(detectPkgManager('ID=rocky\nID_LIKE="rhel centos fedora"\n')).toBe('dnf install -y bubblewrap socat');
    });
    test('arch → pacman', () => {
      expect(detectPkgManager('ID=arch\n')).toBe('pacman -S --noconfirm bubblewrap socat');
    });
    test('alpine → apk', () => {
      expect(detectPkgManager('ID=alpine\n')).toBe('apk add bubblewrap socat');
    });
    test('unknown distro → generic hint', () => {
      expect(detectPkgManager('ID=plan9\n')).toBe('install bubblewrap socat (check your package manager)');
      expect(detectPkgManager('no equals signs here')).toBe('install bubblewrap socat (check your package manager)');
    });
    test('quoted values are unwrapped', () => {
      expect(detectPkgManager('ID="ubuntu"\n')).toBe('apt-get install -y bubblewrap socat');
    });
  });

  describe('CLI contract (subprocess)', () => {
    test('exits 0 and prints a single valid JSON result', async () => {
      const proc = Bun.spawn(['bun', path.join(SCRIPTS_DIR, 'sandbox-probe.ts')], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout.trim());
      expect(['pass', 'warn', 'fail']).toContain(result.status);
      expect(typeof result.message).toBe('string');
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.install_hint === null || typeof result.install_hint === 'string').toBe(true);
      if (process.platform === 'darwin') {
        expect(result.status).toBe('pass');
      }
    });
  });
});
