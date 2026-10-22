import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WirebenchError } from '#core/errors';
import type { ImportFolderOptions } from '../../../src/import/read-folder.js';
import { readImportFolder } from '../../../src/import/read-folder.js';

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-walk-'));
  made.push(dir);
  return dir;
}

const options = (extra: Partial<ImportFolderOptions> = {}): ImportFolderOptions => ({
  readFile: (name) => name.endsWith('.txt'),
  error: (code, message) => new WirebenchError(`walk-${code}`, message),
  ...extra,
});

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error instanceof WirebenchError ? error.code : String(error);
  }
}

describe('readImportFolder', () => {
  it('reads only files readFile accepts', async () => {
    const root = await temp();
    await writeFile(join(root, 'a.txt'), 'A');
    await writeFile(join(root, 'b.md'), 'B');
    expect([...(await readImportFolder(root, options())).entries()]).toEqual([['a.txt', 'A']]);
  });

  it('skips node_modules and .git', async () => {
    const root = await temp();
    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.git', 'x.txt'), 'x');
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules', 'y.txt'), 'y');
    await writeFile(join(root, 'ok.txt'), 'ok');
    expect([...(await readImportFolder(root, options())).keys()]).toEqual(['ok.txt']);
  });

  it('skipFolder drops a subtree', async () => {
    const root = await temp();
    await mkdir(join(root, 'mocks', 'deep'), { recursive: true });
    await writeFile(join(root, 'mocks', 'deep', 'm.txt'), 'm');
    await mkdir(join(root, 'kept'));
    await writeFile(join(root, 'kept', 'k.txt'), 'k');
    const files = await readImportFolder(root, options({ skipFolder: (path) => path === 'mocks' }));
    expect([...files.keys()]).toEqual(['kept/k.txt']);
  });

  it('never follows a symbolic link', async () => {
    const outside = await temp();
    await writeFile(join(outside, 'secret.txt'), 'leak');
    const root = await temp();
    await symlink(join(outside, 'secret.txt'), join(root, 'linked.txt'));
    await symlink(outside, join(root, 'linked-folder'));
    expect([...(await readImportFolder(root, options())).keys()]).toEqual([]);
  });

  it('refuses a root that is a link (not-a-folder)', async () => {
    const real = await temp();
    const parent = await temp();
    await symlink(real, join(parent, 'link'));
    expect(await codeOf(readImportFolder(join(parent, 'link'), options()))).toBe('walk-not-a-folder');
    expect(await codeOf(readImportFolder(join(parent, 'missing'), options()))).toBe('walk-read-failed');
  });

  it('stops at limits.files (too-many-files)', async () => {
    const root = await temp();
    await writeFile(join(root, 'a.txt'), 'a');
    await writeFile(join(root, 'b.txt'), 'b');
    const limits = { files: 1, depth: 10, bytes: 1024, entries: 100 };
    expect(await codeOf(readImportFolder(root, options({ limits })))).toBe('walk-too-many-files');
    expect(await codeOf(readImportFolder(root, options({ limits: { ...limits, files: 10, bytes: 1 } })))).toBe(
      'walk-too-large',
    );
  });

  it('stops past limits.depth (too-deep)', async () => {
    const root = await temp();
    await mkdir(join(root, 'd1', 'd2'), { recursive: true });
    await writeFile(join(root, 'd1', 'd2', 'c.txt'), 'c');
    const limits = { files: 10, depth: 1, bytes: 1024, entries: 100 };
    expect(await codeOf(readImportFolder(root, options({ limits })))).toBe('walk-too-deep');
  });

  it('keys are POSIX and root-relative', async () => {
    const root = await temp();
    await mkdir(join(root, 'a', 'b'), { recursive: true });
    await writeFile(join(root, 'a', 'b', 'c.txt'), 'c');
    expect([...(await readImportFolder(root, options())).keys()]).toEqual(['a/b/c.txt']);
  });
});
