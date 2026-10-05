// @vitest-environment node
/**
 * The OpenCollection directory walk and its companion reads. The walk is the one main-side read of
 * many renderer-unnamed files, so its limits matter more than its happy path: it starts only at a
 * root the user picked (or keeps in a project), never follows a link, never leaves the root's
 * folder, and stops at the file, entry, depth and byte caps. The caps are tested small, through the
 * limits a test may pass; the production values are asserted once.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { OC_TREE_LIMITS, readCompanionTexts, readOpenCollectionTree } from '../src/main/opencollection-tree.js';

const TREE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/opencollection/crafted/tree');
const PICKED = { hasRead: () => true };
const ROOT_DOC = 'opencollection: "1.0.0"\ninfo: {name: x}\n';
const SMALL = { files: 10, depth: 3, bytes: 4096, entries: 50 };

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

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await realpath(mkdtempSync(join(tmpdir(), 'wirebench-oc-')));
  dirs.push(dir);
  writeFileSync(join(dir, 'opencollection.yml'), ROOT_DOC);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readOpenCollectionTree', () => {
  it('reads every YAML file under the picked root, POSIX keys', async () => {
    const files = await readOpenCollectionTree(join(TREE, 'opencollection.yml'), [], PICKED);
    expect([...files.keys()]).toEqual(
      expect.arrayContaining(['opencollection.yml', 'Users/folder.yml', 'environments/dev.yml']),
    );
    expect([...files.keys()].some((k) => k.endsWith('.proto'))).toBe(false);
  });

  it('refuses when the root file was not picked', async () => {
    await expect(
      readOpenCollectionTree(join(TREE, 'opencollection.yml'), [], { hasRead: () => false }),
    ).rejects.toMatchObject({ code: 'import-path-refused' });
  });

  it('reads a root inside an open project folder without a pick', async () => {
    const files = await readOpenCollectionTree(join(TREE, 'opencollection.yml'), [TREE], { hasRead: () => false });
    expect(files.has('Users/get-user.yml')).toBe(true);
  });

  it.skipIf(!canSymlink)('skips symbolic links to files and folders, and never reads outside the root', async () => {
    const dir = await tempDir();
    const outside = await tempDir();
    writeFileSync(join(outside, 'secret.yml'), 'token: leaked\n');
    mkdirSync(join(outside, 'nested'));
    writeFileSync(join(outside, 'nested', 'deep.yml'), 'token: leaked\n');
    symlinkSync(join(outside, 'secret.yml'), join(dir, 'linked.yml'));
    symlinkSync(join(outside, 'nested'), join(dir, 'linked-folder'));
    writeFileSync(join(dir, 'notes.txt'), 'not yaml');
    writeFileSync(join(dir, 'kept.YAML'), 'info: {name: k}\n');

    const files = await readOpenCollectionTree(join(dir, 'opencollection.yml'), [], PICKED);

    expect([...files.keys()].sort()).toEqual(['kept.YAML', 'opencollection.yml']);
    expect([...files.values()].join('')).not.toContain('leaked');
  });

  it('stops past the file limit', async () => {
    const dir = await tempDir();
    for (let i = 0; i < SMALL.files; i += 1) writeFileSync(join(dir, `r${i}.yml`), 'info: {name: r}\n');
    await expect(readOpenCollectionTree(join(dir, 'opencollection.yml'), [], PICKED, SMALL)).rejects.toMatchObject({
      name: 'OpenCollectionError',
      code: 'oc-too-many-files',
    });
  });

  it('stops past the entry limit, counting files it does not read', async () => {
    const dir = await tempDir();
    for (let i = 0; i < SMALL.entries; i += 1) writeFileSync(join(dir, `n${i}.txt`), 'x');
    await expect(readOpenCollectionTree(join(dir, 'opencollection.yml'), [], PICKED, SMALL)).rejects.toMatchObject({
      code: 'oc-too-many-files',
    });
  });

  it('does not walk node_modules or .git', async () => {
    const dir = await tempDir();
    for (const skipped of ['node_modules', '.git']) {
      mkdirSync(join(dir, skipped));
      for (let i = 0; i < SMALL.entries; i += 1) writeFileSync(join(dir, skipped, `p${i}.yml`), 'x: 1\n');
    }
    const files = await readOpenCollectionTree(join(dir, 'opencollection.yml'), [], PICKED, SMALL);
    expect([...files.keys()]).toEqual(['opencollection.yml']);
  });

  it('stops past the depth limit', async () => {
    const dir = await tempDir();
    let current = dir;
    for (let i = 0; i <= SMALL.depth; i += 1) {
      current = join(current, 'd');
      mkdirSync(current);
    }
    writeFileSync(join(current, 'leaf.yml'), 'info: {name: leaf}\n');
    await expect(readOpenCollectionTree(join(dir, 'opencollection.yml'), [], PICKED, SMALL)).rejects.toMatchObject({
      code: 'oc-too-deep',
    });
  });

  it('stops past the byte limit, counting the bytes on disk', async () => {
    const dir = await tempDir();
    // Multi-byte text: over the cap in bytes, though under it in characters.
    const half = '€'.repeat(Math.ceil(SMALL.bytes / 3 / 2) + 1);
    writeFileSync(join(dir, 'a.yml'), half);
    writeFileSync(join(dir, 'b.yml'), half);
    expect(half.length * 2).toBeLessThan(SMALL.bytes);
    await expect(readOpenCollectionTree(join(dir, 'opencollection.yml'), [], PICKED, SMALL)).rejects.toMatchObject({
      code: 'oc-too-large',
    });
  });

  it('keeps the production limits', () => {
    expect(OC_TREE_LIMITS).toEqual({ files: 5000, depth: 64, bytes: 50 * 1024 * 1024, entries: 50_000 });
  });

  it.skipIf(!canSymlink)('refuses a root document that is a symbolic link', async () => {
    const dir = await tempDir();
    const outside = await tempDir();
    symlinkSync(join(outside, 'opencollection.yml'), join(dir, 'collection.yml'));
    await expect(readOpenCollectionTree(join(dir, 'collection.yml'), [], PICKED)).rejects.toMatchObject({
      code: 'import-path-refused',
    });
  });

  it.skipIf(!canSymlink)('refuses a root document whose own folder is a symbolic link', async () => {
    const parent = await tempDir();
    const outside = await tempDir();
    writeFileSync(join(outside, 'secret.yml'), 'token: leaked\n');
    symlinkSync(outside, join(parent, 'linked'));
    await expect(
      readOpenCollectionTree(join(parent, 'linked', 'opencollection.yml'), [], PICKED),
    ).rejects.toMatchObject({ code: 'import-path-refused' });
  });
});

describe('readCompanionTexts', () => {
  it('reads the named files beside the root, keyed by POSIX relative path', async () => {
    const texts = await readCompanionTexts(join(TREE, 'opencollection.yml'), [], PICKED, ['protos/pets.proto']);
    expect([...texts.keys()]).toEqual(['protos/pets.proto']);
    expect(texts.get('protos/pets.proto')).toContain('service Pets');
  });

  it('leaves out a name with nothing at it', async () => {
    const texts = await readCompanionTexts(join(TREE, 'opencollection.yml'), [], PICKED, [
      'protos/pets.proto',
      'protos/missing.proto',
    ]);
    expect([...texts.keys()]).toEqual(['protos/pets.proto']);
  });

  it.skipIf(!canSymlink)('refuses a name outside the root, a symbolic link, and an unpicked root', async () => {
    const dir = await tempDir();
    const outside = await tempDir();
    writeFileSync(join(outside, 'x.proto'), 'syntax = "proto3";');
    symlinkSync(join(outside, 'x.proto'), join(dir, 'linked.proto'));
    const root = join(dir, 'opencollection.yml');

    await expect(readCompanionTexts(root, [], PICKED, ['../x.proto'])).rejects.toMatchObject({
      code: 'import-path-refused',
    });
    await expect(readCompanionTexts(root, [], PICKED, [join(outside, 'x.proto')])).rejects.toMatchObject({
      code: 'import-path-refused',
    });
    await expect(readCompanionTexts(root, [], PICKED, ['linked.proto'])).rejects.toMatchObject({
      code: 'import-path-refused',
    });
    await expect(readCompanionTexts(root, [], { hasRead: () => false }, ['x.proto'])).rejects.toMatchObject({
      code: 'import-path-refused',
    });
  });
});
