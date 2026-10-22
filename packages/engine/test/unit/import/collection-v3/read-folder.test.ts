import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PostmanError } from '#core/errors';
import {
  collectionV3Root,
  importCollectionV3Folder,
  readCollectionV3Folder,
} from '../../../../src/import/collection-v3/read-folder.js';
import { v3FixtureDir } from './fixture-files.js';

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-v3-'));
  made.push(dir);
  return dir;
}

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error instanceof PostmanError ? error.code : String(error);
  }
}

describe('readCollectionV3Folder', () => {
  it('reads the YAML and script files under the folder, keyed by POSIX path', async () => {
    const files = await readCollectionV3Folder(resolve(v3FixtureDir, 'workspace'));
    expect(files.has('collections/Bookstore API/.resources/definition.yaml')).toBe(true);
    expect(files.has('collections/Bookstore API/Admin/scripts/sign.js')).toBe(true);
    expect([...files.keys()].some((key) => key.endsWith('.md'))).toBe(false);
  });

  it('follows no link, skips .git and node_modules, and never leaves the folder', async () => {
    const outside = await temp();
    await writeFile(join(outside, 'secret.request.yaml'), '$kind: http-request\nurl: https://leak.example');
    const root = await temp();
    await writeFile(join(root, 'ok.request.yaml'), '$kind: http-request');
    await symlink(join(outside, 'secret.request.yaml'), join(root, 'linked.request.yaml'));
    await symlink(outside, join(root, 'linked-folder'));
    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.git', 'x.yaml'), 'a: 1');
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules', 'y.yaml'), 'a: 1');
    expect([...(await readCollectionV3Folder(root)).keys()]).toEqual(['ok.request.yaml']);
  });

  it('refuses a linked or missing root, and a file', async () => {
    const real = await temp();
    const parent = await temp();
    await symlink(real, join(parent, 'link'));
    expect(await codeOf(readCollectionV3Folder(join(parent, 'link')))).toBe('postman-v3-not-a-folder');
    expect(await codeOf(readCollectionV3Folder(join(parent, 'missing')))).toBe('postman-read-failed');
    await writeFile(join(parent, 'f.yaml'), 'a: 1');
    expect(await codeOf(readCollectionV3Folder(join(parent, 'f.yaml')))).toBe('postman-v3-not-a-folder');
  });

  it('stops at the limits', async () => {
    const root = await temp();
    await writeFile(join(root, 'a.yaml'), 'a: 1');
    await writeFile(join(root, 'b.yaml'), 'b: 2');
    await mkdir(join(root, 'd1', 'd2'), { recursive: true });
    await writeFile(join(root, 'd1', 'd2', 'c.yaml'), 'c: 3');
    const limits = { files: 10, depth: 10, bytes: 1024, entries: 100 };
    expect(await codeOf(readCollectionV3Folder(root, { ...limits, files: 1 }))).toBe('postman-v3-too-many-files');
    expect(await codeOf(readCollectionV3Folder(root, { ...limits, entries: 2 }))).toBe('postman-v3-too-many-files');
    expect(await codeOf(readCollectionV3Folder(root, { ...limits, depth: 1 }))).toBe('postman-v3-too-deep');
    expect(await codeOf(readCollectionV3Folder(root, { ...limits, bytes: 8 }))).toBe('postman-too-large');
  });
});

describe('collectionV3Root and importCollectionV3Folder', () => {
  it('takes a folder as itself and a definition file as the folder above .resources', async () => {
    const collection = resolve(v3FixtureDir, 'workspace/collections/Bookstore API');
    expect(await collectionV3Root(collection)).toBe(collection);
    expect(await collectionV3Root(join(collection, '.resources', 'definition.yaml'))).toBe(collection);
  });

  it('refuses a request file alone, and any other file', async () => {
    const collection = resolve(v3FixtureDir, 'workspace/collections/Bookstore API');
    expect(await codeOf(collectionV3Root(join(collection, 'Add book.request.yaml')))).toBe('postman-v3-pick-folder');
    expect(await codeOf(collectionV3Root(resolve(v3FixtureDir, 'README.md')))).toBe('postman-v3-not-a-collection');
  });

  it('imports a picked definition file as its whole collection, named by its definition', async () => {
    const definition = resolve(v3FixtureDir, 'workspace/collections/Bookstore API/.resources/definition.yaml');
    const mapped = await importCollectionV3Folder(definition);
    expect(mapped.collections.map((c) => c.rest?.name)).toEqual(['Bookstore API']);
    expect(mapped.counts.requests).toBe(14);
  });
});
