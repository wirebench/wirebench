/**
 * Whether this platform lets a test create a symbolic link: Windows without the privilege (or developer mode) does
 * not, and a test that needs one skips there (`it.skipIf(!canSymlink)`), as `packages/host`'s tests do.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const canSymlink = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'wbs-symlink-probe-'));
  try {
    mkdirSync(join(probe, 'dir'));
    symlinkSync(join(probe, 'target'), join(probe, 'file-link'));
    symlinkSync(join(probe, 'dir'), join(probe, 'dir-link'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();
