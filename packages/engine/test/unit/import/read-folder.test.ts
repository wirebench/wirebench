import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readImportFolder } from '../../../src/import/read-folder.js';
import type { ImportFolderOptions } from '../../../src/import/read-folder.js';

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-folder-'));
  made.push(dir);
  return dir;
}

class CodedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const base: ImportFolderOptions = {
  readFile: (name) => name.endsWith('.txt'),
  error: (code, message) => new CodedError(code, message),
};

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error instanceof CodedError ? error.code : String(error);
  }
}

const LIMITS = { files: 5000, depth: 64, bytes: 1024 * 1024, entries: 50_000 };

describe('readImportFolder', () => {
  it('reads only files readFile accepts', async () => {
    const dir = await temp();
    await writeFile(join(dir, 'a.txt'), 'A');
    await writeFile(join(dir, 'b.md'), 'B');
    expect([...(await readImportFolder(dir, base)).keys()]).toEqual(['a.txt']);
  });

  it('skips node_modules and .git', async () => {
    const dir = await temp();
    await mkdir(join(dir, 'node_modules'));
    await mkdir(join(dir, '.git'));
    await writeFile(join(dir, 'node_modules', 'x.txt'), 'x');
    await writeFile(join(dir, '.git', 'y.txt'), 'y');
    await writeFile(join(dir, 'a.txt'), 'A');
    expect([...(await readImportFolder(dir, base)).keys()]).toEqual(['a.txt']);
  });

  it('skipFolder drops a subtree', async () => {
    const dir = await temp();
    await mkdir(join(dir, 'keep', 'inner'), { recursive: true });
    await mkdir(join(dir, 'drop', 'inner'), { recursive: true });
    await writeFile(join(dir, 'keep', 'inner', 'a.txt'), 'A');
    await writeFile(join(dir, 'drop', 'inner', 'b.txt'), 'B');
    const files = await readImportFolder(dir, { ...base, skipFolder: (rel) => rel === 'drop' });
    expect([...files.keys()]).toEqual(['keep/inner/a.txt']);
  });

  it('never follows a symbolic link', async () => {
    const dir = await temp();
    const outside = await temp();
    await writeFile(join(outside, 'secret.txt'), 's');
    await symlink(join(outside, 'secret.txt'), join(dir, 'file.txt'));
    await symlink(outside, join(dir, 'folder'));
    await writeFile(join(dir, 'a.txt'), 'A');
    expect([...(await readImportFolder(dir, base)).keys()]).toEqual(['a.txt']);
  });

  it('refuses a root that is a link (not-a-folder)', async () => {
    const dir = await temp();
    const outside = await temp();
    const link = join(dir, 'link');
    await symlink(outside, link);
    expect(await codeOf(readImportFolder(link, base))).toBe('not-a-folder');
  });

  it('stops at limits.files (too-many-files)', async () => {
    const dir = await temp();
    await writeFile(join(dir, 'a.txt'), 'A');
    await writeFile(join(dir, 'b.txt'), 'B');
    expect(await codeOf(readImportFolder(dir, { ...base, limits: { ...LIMITS, files: 1 } }))).toBe('too-many-files');
  });

  it('stops past limits.depth (too-deep)', async () => {
    const dir = await temp();
    await mkdir(join(dir, 'a', 'b', 'c'), { recursive: true });
    await writeFile(join(dir, 'a', 'b', 'c', 'x.txt'), 'x');
    expect(await codeOf(readImportFolder(dir, { ...base, limits: { ...LIMITS, depth: 2 } }))).toBe('too-deep');
  });

  it('stops at limits.bytes (too-large)', async () => {
    const dir = await temp();
    await writeFile(join(dir, 'a.txt'), 'A'.repeat(20));
    expect(await codeOf(readImportFolder(dir, { ...base, limits: { ...LIMITS, bytes: 10 } }))).toBe('too-large');
  });

  it('keys are POSIX and root-relative', async () => {
    const dir = await temp();
    await mkdir(join(dir, 'one', 'two'), { recursive: true });
    await writeFile(join(dir, 'one', 'two', 'a.txt'), 'A');
    const files = await readImportFolder(dir, base);
    expect(files.get('one/two/a.txt')).toBe('A');
  });
});
