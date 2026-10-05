import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { OpenCollectionError } from '../../../../src/errors.js';
import { importOpenCollection } from '../../../../src/import/opencollection/import.js';
import { MAX_OPENCOLLECTION_BYTES } from '../../../../src/import/opencollection/model.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '../../../../../../fixtures');
const single = resolve(fixtureDir, 'opencollection/crafted/single/collection.yml');

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OpenCollectionError);
    return (error as OpenCollectionError).code;
  }
  return undefined;
}

describe('importOpenCollection', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'oc-import-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('reads a single document from text, from a file, and a tree from its files', async () => {
    const text = readFileSync(single, 'utf8');
    const fromText = await importOpenCollection({ kind: 'text', text });
    expect(fromText.rest?.name).toBe('Pets');
    const fromFile = await importOpenCollection({ kind: 'file', path: single });
    expect(fromFile.counts).toEqual(fromText.counts);

    const tree = resolve(fixtureDir, 'opencollection/crafted/tree');
    const files = new Map(
      ['Users/folder.yml', 'Users/get-user.yml', 'environments/dev.yml', 'OpenCollection.YML'].map(
        (rel) =>
          [
            rel,
            readFileSync(resolve(tree, rel === 'OpenCollection.YML' ? 'opencollection.yml' : rel), 'utf8'),
          ] as const,
      ),
    );
    const fromTree = await importOpenCollection({
      kind: 'tree',
      rootText: readFileSync(resolve(tree, 'opencollection.yml'), 'utf8'),
      files,
      rootKey: 'OpenCollection.YML',
    });
    expect(fromTree.rest?.folders[0]?.requests.map((r) => r.name)).toEqual(['Get User']);
    expect(fromTree.variables.environments.map((e) => e.name)).toEqual(['dev']);
  });

  it('resolves body files against the picked file folder', async () => {
    const path = join(scratch, 'files.yml');
    writeFileSync(
      path,
      'opencollection: "1.0.0"\ninfo: { name: F }\nitems:\n  - info: { name: Up, type: http }\n    http:\n      method: POST\n      url: "https://h/u"\n      body: { type: file, data: [{ filePath: data/a.bin }] }\n',
    );
    const mapped = await importOpenCollection({ kind: 'file', path });
    expect(mapped.rest?.requests[0]?.body).toMatchObject({ source: { path: join(scratch, 'data/a.bin') } });
  });

  it('refuses a collection with nothing to import', async () => {
    expect(
      await codeOf(importOpenCollection({ kind: 'text', text: 'opencollection: "1.0.0"\ninfo: { name: E }\n' })),
    ).toBe('oc-nothing-to-import');
  });

  it('refuses text or a file that is too large, and a file that cannot be read', async () => {
    const big = 'x'.repeat(MAX_OPENCOLLECTION_BYTES + 1);
    expect(await codeOf(importOpenCollection({ kind: 'text', text: big }))).toBe('oc-too-large');
    expect(
      await codeOf(importOpenCollection({ kind: 'tree', rootText: 'a: 1', files: new Map([['big.yml', big]]) })),
    ).toBe('oc-too-large');
    expect(await codeOf(importOpenCollection({ kind: 'file', path: join(scratch, 'missing.yml') }))).toBe(
      'oc-read-failed',
    );
  });
});

describe('importOpenCollection options', () => {
  it('lets options.rootDir override the file folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-rootdir-'));
    try {
      const path = join(dir, 'c.yml');
      writeFileSync(
        path,
        'opencollection: "1.0.0"\ninfo: { name: F }\nitems:\n  - info: { name: Up, type: http }\n    http:\n      method: POST\n      url: "https://h/u"\n      body: { type: file, data: [{ filePath: a.bin }] }\n',
      );
      const other = join(dir, 'other');
      const mapped = await importOpenCollection({ kind: 'file', path }, { rootDir: other });
      expect(mapped.rest?.requests[0]?.body).toMatchObject({ source: { path: join(other, 'a.bin') } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
