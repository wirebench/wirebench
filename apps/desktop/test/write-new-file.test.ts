// @vitest-environment node
/**
 * Writing a file that must not replace anything at its name: the name is taken by the write itself,
 * so whatever is there — a file, or a link — stays as it was.
 */
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeNewFile } from '../src/main/write-new-file.js';

/** Whether this platform lets the test create a symlink (Windows without the privilege does not). */
const canSymlink = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'wirebench-symlink-probe-'));
  try {
    symlinkSync(join(probe, 'target'), join(probe, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wirebench-new-file-'));
  made.push(dir);
  return dir;
}

describe('writeNewFile', () => {
  it('writes a file at a free name, leaving no temp file behind', async () => {
    const dir = tmp();
    expect(await writeNewFile(join(dir, 'a.js'), Buffer.from('script'))).toBe(true);
    expect(readFileSync(join(dir, 'a.js'), 'utf8')).toBe('script');
    expect(readdirSync(dir)).toEqual(['a.js']);
  });

  it('leaves a file already at the name as it is, and says so', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.js'), 'theirs');
    expect(await writeNewFile(join(dir, 'a.js'), Buffer.from('ours'))).toBe(false);
    expect(readFileSync(join(dir, 'a.js'), 'utf8')).toBe('theirs');
    expect(readdirSync(dir)).toEqual(['a.js']);
  });

  it.skipIf(!canSymlink)('never writes through a link at the name, even a dangling one', async () => {
    const dir = tmp();
    const outside = tmp();
    symlinkSync(join(outside, 'planted.js'), join(dir, 'a.js'));
    expect(await writeNewFile(join(dir, 'a.js'), Buffer.from('ours'))).toBe(false);
    expect(readlinkSync(join(dir, 'a.js'))).toBe(join(outside, 'planted.js'));
    expect(readdirSync(outside)).toEqual([]);
  });
});
