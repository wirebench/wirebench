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
import { loadProtoSet, readProtoDefinitionCache, writeProtoDefinitionCache } from '@wirebench/engine';
import {
  MISSING_IMPORTS_LISTED,
  OC_TREE_LIMITS,
  readCompanionProtos,
  readOpenCollectionTree,
} from '../src/main/opencollection-tree.js';

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

describe('readCompanionProtos', () => {
  const ROOTLESS = 'syntax = "proto3";\n';
  /** A folder collection holding `files`, keyed by POSIX path below it. */
  async function collection(files: Record<string, string>): Promise<{ dir: string; root: string }> {
    const dir = await tempDir();
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return { dir, root: join(dir, 'opencollection.yml') };
  }
  const imports = (...names: string[]) => ROOTLESS + names.map((name) => `import "${name}";\n`).join('');

  it('reads the named files beside the root, keyed by POSIX relative path', async () => {
    const read = await readCompanionProtos(join(TREE, 'opencollection.yml'), [], PICKED, ['protos/pets.proto']);
    expect([...read.sources.keys()]).toEqual(['protos/pets.proto']);
    expect(read.sources.get('protos/pets.proto')).toContain('service Pets');
    expect(read.roots).toEqual(['protos/pets.proto']);
    expect(read.missing).toEqual([]);
  });

  it('leaves out a name with nothing at it', async () => {
    const read = await readCompanionProtos(join(TREE, 'opencollection.yml'), [], PICKED, [
      'protos/pets.proto',
      'protos/missing.proto',
    ]);
    expect([...read.sources.keys()]).toEqual(['protos/pets.proto']);
    expect(read.roots).toEqual(['protos/pets.proto']);
  });

  it('follows an import into a sibling folder, read relative to the root', async () => {
    const { root } = await collection({
      'protos/pets.proto': imports('shared/common.proto', 'google/protobuf/empty.proto'),
      'shared/common.proto': ROOTLESS,
    });
    const read = await readCompanionProtos(root, [], PICKED, ['protos/pets.proto']);
    expect([...read.sources.keys()]).toEqual(['protos/pets.proto', 'shared/common.proto']);
    expect(read.roots).toEqual(['protos/pets.proto']);
    expect(read.missing).toEqual([]);
  });

  it('follows imports transitively, root-relative first, and keys each by its path below the root', async () => {
    const { root } = await collection({
      'api/v1/service.proto': imports('api/v1/types.proto'),
      'api/v1/types.proto': imports('common.proto'),
      'common.proto': ROOTLESS,
      'api/v1/common.proto': 'not this one',
    });
    const read = await readCompanionProtos(root, [], PICKED, ['api/v1/service.proto']);
    expect([...read.sources.keys()]).toEqual(['api/v1/service.proto', 'api/v1/types.proto', 'common.proto']);
    expect(read.sources.get('common.proto')).toBe(ROOTLESS);
  });

  it('falls back to an import relative to the importing file, and the loader resolves it', async () => {
    const { root } = await collection({
      'protos/pets.proto': ROOTLESS + 'import "types.proto";\nservice Pets { rpc Get (Pet) returns (Pet); }\n',
      'protos/types.proto': ROOTLESS + 'message Pet { string name = 1; }\n',
    });
    const read = await readCompanionProtos(root, [], PICKED, ['protos/pets.proto']);
    expect([...read.sources.keys()]).toEqual(['protos/pets.proto', 'protos/types.proto']);
    expect(read.missing).toEqual([]);
    expect(loadProtoSet(read.sources, { roots: read.roots }).files).toEqual([
      'protos/pets.proto',
      'protos/types.proto',
    ]);
  });

  it('prefers the root-relative file whatever order the walk meets the files in', async () => {
    const { root } = await collection({
      'protos/a.proto': imports('types.proto'),
      'protos/types.proto': 'beside',
      'types.proto': 'at the root',
    });
    const read = await readCompanionProtos(root, [], PICKED, ['protos/a.proto', 'protos/types.proto']);
    expect(read.sources.get('types.proto')).toBe('at the root');
    expect(read.sources.get('protos/types.proto')).toBe('beside');
    expect(read.roots).toEqual(['protos/a.proto', 'protos/types.proto']);
  });

  it("keeps two folders' same-named neighbours apart, and both load", async () => {
    const { root } = await collection({
      'a/x.proto': ROOTLESS + 'package a; import "common.proto"; message X { Common c = 1; }',
      'a/common.proto': ROOTLESS + 'package a; message Common { string a = 1; }',
      'b/y.proto': ROOTLESS + 'package b; import "common.proto"; message Y { Common c = 1; }',
      'b/common.proto': ROOTLESS + 'package b; message Common { int32 b = 1; }',
    });
    const read = await readCompanionProtos(root, [], PICKED, ['a/x.proto', 'b/y.proto']);
    expect([...read.sources.keys()].sort()).toEqual(['a/common.proto', 'a/x.proto', 'b/common.proto', 'b/y.proto']);
    const set = loadProtoSet(read.sources, { roots: read.roots });
    expect(set.root.lookupType('a.Common').fields['a']).toBeDefined();
    expect(set.root.lookupType('b.Common').fields['b']).toBeDefined();
  });

  it('loads the same from the definition cache as at import', async () => {
    const { dir, root } = await collection({
      'protos/pets.proto':
        ROOTLESS + 'package p; import "types.proto"; import "shared/s.proto"; message P { T t = 1; S s = 2; }',
      'protos/types.proto': ROOTLESS + 'package p; message T { string t = 1; }',
      'shared/s.proto': ROOTLESS + 'package p; message S { string s = 1; }',
    });
    const read = await readCompanionProtos(root, [], PICKED, ['protos/pets.proto']);
    const cacheDir = join(dir, 'cache');
    await writeProtoDefinitionCache(read.sources, cacheDir, { source: root, roots: read.roots });
    const cached = await readProtoDefinitionCache(cacheDir);
    expect(cached.manifest.roots).toEqual(['protos/pets.proto']);
    const reloaded = loadProtoSet(cached.sources, { roots: cached.manifest.roots });
    expect(reloaded.files).toEqual(loadProtoSet(read.sources, { roots: read.roots }).files);
    expect(reloaded.root.lookupType('p.P').fieldsArray.map((field) => field.name)).toEqual(['t', 's']);
  });

  it('reads each file of a cycle once', async () => {
    const { root } = await collection({ 'a.proto': imports('b.proto'), 'b.proto': imports('a.proto') });
    const read = await readCompanionProtos(root, [], PICKED, ['a.proto']);
    expect([...read.sources.keys()]).toEqual(['a.proto', 'b.proto']);
    expect(read.roots).toEqual(['a.proto']);
  });

  it('lists an import found nowhere, with the file that imports it', async () => {
    const { root } = await collection({ 'protos/pets.proto': imports('shared/gone.proto', 'shared/gone.proto') });
    const read = await readCompanionProtos(root, [], PICKED, ['protos/pets.proto']);
    expect(read.missing).toEqual([{ name: 'shared/gone.proto', importedBy: 'protos/pets.proto' }]);
    expect(read.missingMore).toBe(0);
    expect([...read.sources.keys()]).toEqual(['protos/pets.proto']);
  });

  it('lists the first missing imports and counts the rest, quickly, for many importers of many names', async () => {
    // 20 importers × 1,000 missing names in short statements, about 220 KB: 20,000 pairs, each noted
    // once without a scan of the pairs already noted, which alone would take seconds.
    const statements = Array.from({ length: 1000 }, (_, index) => `import"${String(index)}";`).join('');
    const files: Record<string, string> = {};
    for (let index = 0; index < 20; index += 1) files[`i${String(index)}.proto`] = statements;
    const { root } = await collection(files);
    const start = performance.now();
    const read = await readCompanionProtos(root, [], PICKED, Object.keys(files));
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(read.missing).toHaveLength(MISSING_IMPORTS_LISTED);
    expect(read.missing[0]).toEqual({ name: '0', importedBy: 'i0.proto' });
    expect(read.missingMore).toBe(20 * 1000 - MISSING_IMPORTS_LISTED);
  });

  it('refuses an import that is not a plain relative path, before reading it', async () => {
    const { dir, root } = await collection({ 'protos/pets.proto': imports('../outside.proto') });
    // Inside the folder, `../outside.proto` from `protos/` would land on this file: it must still not be read.
    writeFileSync(join(dir, 'outside.proto'), 'SECRET');
    for (const name of ['../outside.proto', './outside.proto', '/etc/x.proto', 'a//b.proto', 'a\\b.proto']) {
      writeFileSync(join(dir, 'protos', 'pets.proto'), imports(name));
      await expect(readCompanionProtos(root, [], PICKED, ['protos/pets.proto'])).rejects.toMatchObject({
        code: 'import-path-refused',
        details: { path: name, importedBy: 'protos/pets.proto' },
      });
    }
  });

  it.skipIf(!canSymlink)('refuses an import that is a symbolic link, or reached through one', async () => {
    const outside = await tempDir();
    writeFileSync(join(outside, 'x.proto'), ROOTLESS);
    const { dir, root } = await collection({ 'a.proto': imports('linked.proto') });
    symlinkSync(join(outside, 'x.proto'), join(dir, 'linked.proto'));
    await expect(readCompanionProtos(root, [], PICKED, ['a.proto'])).rejects.toMatchObject({
      code: 'import-path-refused',
    });

    writeFileSync(join(dir, 'a.proto'), imports('through/x.proto'));
    symlinkSync(outside, join(dir, 'through'));
    await expect(readCompanionProtos(root, [], PICKED, ['a.proto'])).rejects.toMatchObject({
      code: 'import-path-refused',
    });
  });

  it('stops past the file, byte and entry limits, counting imported files', async () => {
    const { root } = await collection({
      'a.proto': imports('b.proto'),
      'b.proto': imports('c.proto'),
      'c.proto': ROOTLESS,
    });
    const limits = { files: 3, bytes: 4096, entries: 50 };
    await expect(readCompanionProtos(root, [], PICKED, ['a.proto'], limits)).resolves.toMatchObject({
      roots: ['a.proto'],
    });
    await expect(readCompanionProtos(root, [], PICKED, ['a.proto'], { ...limits, files: 2 })).rejects.toMatchObject({
      code: 'oc-too-many-files',
    });
    await expect(readCompanionProtos(root, [], PICKED, ['a.proto'], { ...limits, bytes: 60 })).rejects.toMatchObject({
      code: 'oc-too-large',
    });
    await expect(readCompanionProtos(root, [], PICKED, ['a.proto'], { ...limits, entries: 2 })).rejects.toMatchObject({
      code: 'oc-too-many-files',
    });
  });

  it('holds lookups for missing imports to the entry limit', async () => {
    const names = Array.from({ length: 40 }, (_, index) => `gone/${String(index)}.proto`);
    const { root } = await collection({ 'a.proto': imports(...names) });
    await expect(
      readCompanionProtos(root, [], PICKED, ['a.proto'], { files: 10, bytes: 4096, entries: 20 }),
    ).rejects.toMatchObject({ code: 'oc-too-many-files' });
  });

  it.skipIf(!canSymlink)('refuses a name outside the root, a symbolic link, and an unpicked root', async () => {
    const dir = await tempDir();
    const outside = await tempDir();
    writeFileSync(join(outside, 'x.proto'), 'syntax = "proto3";');
    symlinkSync(join(outside, 'x.proto'), join(dir, 'linked.proto'));
    const root = join(dir, 'opencollection.yml');

    await expect(readCompanionProtos(root, [], PICKED, ['../x.proto'])).rejects.toMatchObject({
      code: 'import-path-refused',
    });
    await expect(readCompanionProtos(root, [], PICKED, [join(outside, 'x.proto')])).rejects.toMatchObject({
      code: 'import-path-refused',
    });
    await expect(readCompanionProtos(root, [], PICKED, ['linked.proto'])).rejects.toMatchObject({
      code: 'import-path-refused',
    });
    await expect(readCompanionProtos(root, [], { hasRead: () => false }, ['x.proto'])).rejects.toMatchObject({
      code: 'import-path-refused',
    });
  });
});
