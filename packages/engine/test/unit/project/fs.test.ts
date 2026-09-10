import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isNotFound, nodeFs, readFileIfExists, readdirIfExists, writeFileAtomic } from '../../../src/project/fs.js';
import type { FsLike } from '../../../src/project/fs.js';
import { loadProject } from '../../../src/project/load.js';
import { saveProject } from '../../../src/project/save.js';
import { listTree, sampleProject, tempProjectDir } from './fixture.js';

describe('nodeFs', () => {
  it('implements the FsLike surface against the real file system', async () => {
    const dir = await tempProjectDir();
    await nodeFs.mkdir(join(dir, 'a', 'b'), { recursive: true });
    await nodeFs.writeFile(join(dir, 'a', 'b', 'f.txt'), 'hello');
    await nodeFs.rename(join(dir, 'a', 'b', 'f.txt'), join(dir, 'a', 'b', 'g.txt'));

    expect((await nodeFs.readFile(join(dir, 'a', 'b', 'g.txt'))).toString('utf8')).toBe('hello');
    expect(await nodeFs.readdir(join(dir, 'a'))).toEqual([{ name: 'b', isDirectory: true, isFile: false }]);
    expect(await nodeFs.stat(join(dir, 'a', 'b', 'g.txt'))).toEqual({ isDirectory: false, isFile: true, size: 5 });
    expect(await nodeFs.stat(join(dir, 'a'))).toMatchObject({ isDirectory: true, isFile: false });

    await nodeFs.rm(join(dir, 'a'), { recursive: true, force: true });
    expect(await readdirIfExists(nodeFs, join(dir, 'a'))).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('readFileIfExists / readdirIfExists', () => {
  it('return undefined and [] for a missing path', async () => {
    const dir = await tempProjectDir();
    expect(await readFileIfExists(nodeFs, join(dir, 'nope'))).toBeUndefined();
    expect(await readdirIfExists(nodeFs, join(dir, 'nope'))).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it('rethrow errors that are not ENOENT', async () => {
    const dir = await tempProjectDir();
    await writeFile(join(dir, 'file'), 'x');
    // readdir on a plain file fails with ENOTDIR, which must not be swallowed.
    await expect(readdirIfExists(nodeFs, join(dir, 'file'))).rejects.toThrow();
    await mkdir(join(dir, 'adir'));
    await expect(readFileIfExists(nodeFs, join(dir, 'adir'))).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });

  it('recognises only ENOENT as not-found', () => {
    expect(isNotFound(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(true);
    expect(isNotFound(new Error('x'))).toBe(false);
    expect(isNotFound(null)).toBe(false);
  });
});

describe('writeFileAtomic', () => {
  it('creates missing directories and leaves no temp file behind', async () => {
    const dir = await tempProjectDir();
    const target = join(dir, 'deep', 'nested', 'out.txt');
    await writeFileAtomic(nodeFs, target, 'payload');

    expect((await readFile(target)).toString('utf8')).toBe('payload');
    expect(await listTree(dir)).toEqual(['deep/nested/out.txt']);
    await rm(dir, { recursive: true, force: true });
  });

  it('cleans up the temp file and rethrows when the rename fails', async () => {
    const dir = await tempProjectDir();
    const failing: FsLike = {
      ...nodeFs,
      rename: () => Promise.reject(new Error('rename blew up')),
    };
    const target = join(dir, 'out.txt');

    await expect(writeFileAtomic(failing, target, 'payload')).rejects.toThrow('rename blew up');
    expect(await listTree(dir)).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('injected FsLike', () => {
  it('is used by saveProject and loadProject instead of node:fs', async () => {
    const dir = await tempProjectDir();
    const calls: string[] = [];
    const spy: FsLike = {
      readFile: (p) => {
        calls.push('readFile');
        return nodeFs.readFile(p);
      },
      writeFile: (p, d) => {
        calls.push('writeFile');
        return nodeFs.writeFile(p, d);
      },
      rename: (a, b) => nodeFs.rename(a, b),
      mkdir: (p, o) => nodeFs.mkdir(p, o),
      readdir: (p) => nodeFs.readdir(p),
      stat: (p) => nodeFs.stat(p),
      rm: (p, o) => nodeFs.rm(p, o),
    };

    const project = sampleProject();
    await saveProject(project, dir, { fs: spy });
    const { project: loaded } = await loadProject(dir, { fs: spy });

    expect(loaded).toEqual(project);
    expect(calls).toContain('writeFile');
    expect(await stat(join(dir, 'wirebench.yaml'))).toBeTruthy();
    await rm(dir, { recursive: true, force: true });
  });
});
