/**
 * The API definition cache: byte-exact in, byte-exact out.
 *
 * An export of a cached definition has to be indistinguishable from what was fetched, so every
 * assertion here compares bytes rather than parsed content.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectError } from '../../../../src/errors.js';
import {
  createCachedApiFetch,
  readApiDefinitionCache,
  writeApiDefinitionCache,
} from '../../../../src/rest/openapi/cache.js';
import { parseOpenApi } from '../../../../src/rest/openapi/import.js';
import type { ResolvedDocument } from '../../../../src/rest/openapi/refs.js';
import type { FetchDocument } from '../../../../src/wsdl/resolver.js';

const craftedDir = fileURLToPath(new URL('../../../../../../fixtures/openapi/crafted/', import.meta.url));

const fetchDocument = ((location: string) => {
  const text = readFileSync(fileURLToPath(location), 'utf-8');
  return Promise.resolve({ location, bytes: new TextEncoder().encode(text), text });
}) as FetchDocument;

/** The `refs` fixture resolved, which is a root plus two shared documents. */
async function refsDocuments(): Promise<readonly ResolvedDocument[]> {
  const parsed = await parseOpenApi(
    { kind: 'file', path: pathToFileURL(`${craftedDir}refs/openapi.yaml`).href },
    { fetchDocument },
  );
  return parsed.documents;
}

describe('writeApiDefinitionCache / readApiDefinitionCache', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'wirebench-api-definition-'));
    dirs.push(dir);
    return dir;
  }

  it('writes every document under a name of its own, root first, with its hash', async () => {
    const dir = await tempDir();
    const documents = await refsDocuments();

    const manifest = await writeApiDefinitionCache(documents, dir, {
      now: () => '2026-01-01T00:00:00.000Z',
      declaredVersion: '3.0.3',
    });

    expect(manifest.formatVersion).toBe(1);
    expect(manifest.fetchedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(manifest.declaredVersion).toBe('3.0.3');
    expect(manifest.rootLocation).toBe(documents[0]?.location);
    expect(manifest.documents.map((document) => document.file)).toEqual([
      'openapi.yaml',
      'parameters.yaml',
      'schemas.yaml',
    ]);
    expect(await readdir(dir)).toContain('manifest.yaml');
    for (const entry of manifest.documents) {
      const written = new Uint8Array(await readFile(join(dir, entry.file)));
      const original = documents.find((document) => document.location === entry.location);
      expect(written).toEqual(original?.bytes);
      expect(entry.bytes).toBe(original?.bytes.length);
    }
  });

  it('reads back exactly what was written', async () => {
    const dir = await tempDir();
    const documents = await refsDocuments();
    await writeApiDefinitionCache(documents, dir);

    const cached = await readApiDefinitionCache(dir);

    expect(cached.documents.map((document) => document.location)).toEqual(
      documents.map((document) => document.location),
    );
    expect(cached.documents.map((document) => document.bytes)).toEqual(documents.map((document) => document.bytes));
  });

  it('replaces the folder’s previous contents, so nothing stale survives a re-import', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'left-over.yaml'), 'openapi: 3.0.3\n');

    await writeApiDefinitionCache(await refsDocuments(), dir);

    expect(await readdir(dir)).not.toContain('left-over.yaml');
  });

  it('refuses a document whose bytes no longer match its hash', async () => {
    const dir = await tempDir();
    await writeApiDefinitionCache(await refsDocuments(), dir);
    await writeFile(join(dir, 'openapi.yaml'), 'openapi: 3.0.3\ninfo:\n  title: Tampered\n');

    await expect(readApiDefinitionCache(dir)).rejects.toMatchObject({ code: 'definition-cache-corrupt' });
  });

  it('says the cache is missing rather than reading an empty folder', async () => {
    const dir = await tempDir();

    await expect(readApiDefinitionCache(dir)).rejects.toBeInstanceOf(ProjectError);
    await expect(readApiDefinitionCache(dir)).rejects.toMatchObject({ code: 'definition-cache-missing' });
  });

  it('needs at least one document to cache', async () => {
    const dir = await tempDir();

    await expect(writeApiDefinitionCache([], dir)).rejects.toMatchObject({ code: 'definition-cache-corrupt' });
  });

  it('names a JSON root openapi.yaml only when its own location gives no name', async () => {
    const dir = await tempDir();
    const bytes = new TextEncoder().encode('{"openapi":"3.0.3"}');

    const manifest = await writeApiDefinitionCache(
      [{ location: 'https://api.test/v1/spec', requestedLocation: 'https://api.test/v1/spec', bytes, text: '{}' }],
      dir,
    );

    expect(manifest.documents[0]?.file).toBe('openapi.yaml');
  });

  it('serves a cached document instead of reaching the network, and falls through for the rest', async () => {
    const dir = await tempDir();
    const documents = await refsDocuments();
    const manifest = await writeApiDefinitionCache(documents, dir);
    const asked: string[] = [];
    const fallback = ((location: string) => {
      asked.push(location);
      return Promise.resolve({ location, bytes: new Uint8Array(), text: '' });
    }) as FetchDocument;

    const fetch = createCachedApiFetch(manifest, dir, fallback);
    const root = await fetch(manifest.rootLocation);
    await fetch('https://elsewhere.test/other.yaml');

    expect(root.bytes).toEqual(documents[0]?.bytes);
    expect(asked).toEqual(['https://elsewhere.test/other.yaml']);
  });
});
