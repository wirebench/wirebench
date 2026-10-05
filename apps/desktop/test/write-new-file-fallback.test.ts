// @vitest-environment node
/**
 * Where the file system has no hard links, `writeNewFile` creates the file with an exclusive open
 * instead, and removes what it created when the write then fails.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fsControl = vi.hoisted(() => ({ failWrite: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    // A file system without hard links.
    link: () => Promise.reject(Object.assign(new Error('EPERM: no hard links'), { code: 'EPERM' })),
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (!fsControl.failWrite) return handle;
      fsControl.failWrite = false;
      return Object.assign(Object.create(handle) as typeof handle, {
        writeFile: () => Promise.reject(Object.assign(new Error('ENOSPC: disk full'), { code: 'ENOSPC' })),
        close: () => handle.close(),
      });
    },
  };
});

import { writeNewFile } from '../src/main/write-new-file.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wirebench-new-file-fallback-'));
  made.push(dir);
  return dir;
}

describe('writeNewFile without hard links', () => {
  it('writes the file with an exclusive open, leaving no temp file behind', async () => {
    const dir = tmp();
    expect(await writeNewFile(join(dir, 'a.js'), Buffer.from('script'))).toBe(true);
    expect(readFileSync(join(dir, 'a.js'), 'utf8')).toBe('script');
    expect(readdirSync(dir)).toEqual(['a.js']);
  });

  it('still leaves a file already at the name alone', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.js'), 'theirs');
    expect(await writeNewFile(join(dir, 'a.js'), Buffer.from('ours'))).toBe(false);
    expect(readFileSync(join(dir, 'a.js'), 'utf8')).toBe('theirs');
  });

  it('removes the file it created when the write fails', async () => {
    const dir = tmp();
    fsControl.failWrite = true;
    await expect(writeNewFile(join(dir, 'a.js'), Buffer.from('ours'))).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(readdirSync(dir)).toEqual([]);
  });
});
