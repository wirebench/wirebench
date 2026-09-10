import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { importDefinition } from '../../../src/import.js';
import { ProjectError } from '../../../src/errors.js';
import { createDefaultFetchDocument } from '../../../src/wsdl/fetch.js';
import { resolveDefinition } from '../../../src/wsdl/resolver.js';
import type { DefinitionBundle, FetchDocument, FetchedDocument } from '../../../src/wsdl/resolver.js';
import { createCachedFetchDocument, readDefinitionCache, writeDefinitionCache } from '../../../src/wsdl/cache.js';

const craftedRoot = fileURLToPath(new URL('../../../../../fixtures/wsdl/crafted/', import.meta.url));

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function resolveCrafted(fixture: string, entry: string): Promise<DefinitionBundle> {
  const location = pathToFileURL(join(craftedRoot, fixture, entry)).href;
  return resolveDefinition({ location }, { fetchDocument: createDefaultFetchDocument() });
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'wirebench-definition-cache-'));
}

describe('writeDefinitionCache / readDefinitionCache — nested-imports', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('writes a manifest with 4 documents, root first, byte-exact sha256', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const bundle = await resolveCrafted('nested-imports', 'service.wsdl');

    const manifest = await writeDefinitionCache(bundle, dir, { now: () => '2026-01-01T00:00:00.000Z' });

    expect(manifest.formatVersion).toBe(1);
    expect(manifest.rootLocation).toBe(bundle.root.location);
    expect(manifest.fetchedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(manifest.documents).toHaveLength(4);
    expect(manifest.documents[0]?.location).toBe(bundle.root.location);

    for (const entry of manifest.documents) {
      const onDisk = await readFile(join(dir, entry.file));
      expect(sha256(onDisk)).toBe(entry.sha256);
      const bundled = bundle.documents.find((d) => d.location === entry.location);
      expect(bundled).toBeDefined();
      expect(sha256(bundled!.bytes)).toBe(entry.sha256);
      const originalFile = new URL(entry.location).pathname;
      expect(sha256(await readFile(originalFile))).toBe(entry.sha256);
    }
  });

  it('reads back an equal bundle (locations, bytes, kind)', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const bundle = await resolveCrafted('nested-imports', 'service.wsdl');
    await writeDefinitionCache(bundle, dir);

    const restored = await readDefinitionCache(dir);
    expect(restored.documents).toHaveLength(bundle.documents.length);
    expect(restored.documents.map((d) => d.location)).toEqual(bundle.documents.map((d) => d.location));
    for (const doc of bundle.documents) {
      const restoredDoc = restored.documents.find((d) => d.location === doc.location);
      expect(restoredDoc).toBeDefined();
      expect(Buffer.from(restoredDoc!.bytes)).toEqual(Buffer.from(doc.bytes));
      expect(restoredDoc!.kind).toBe(doc.kind);
    }
    expect(restored.root.location).toBe(bundle.root.location);
  });

  it('preserves chameleonFor for a chameleon include', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const bundle = await resolveCrafted('chameleon-include', 'service.wsdl');
    const chameleonBundled = bundle.documents.find((d) => d.chameleonFor !== undefined);
    expect(chameleonBundled).toBeDefined();

    await writeDefinitionCache(bundle, dir);
    const restored = await readDefinitionCache(dir);
    const chameleonRestored = restored.documents.find((d) => d.location === chameleonBundled!.location);
    expect(chameleonRestored?.chameleonFor).toBe(chameleonBundled!.chameleonFor);
  });

  it('replaces the whole directory content (removes stale files from a prior write)', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    await writeFile(join(dir, 'stale.xsd'), 'stale');
    const bundle = await resolveCrafted('nested-imports', 'service.wsdl');
    await writeDefinitionCache(bundle, dir);

    const names = await readdir(dir);
    expect(names).not.toContain('stale.xsd');
  });

  it('throws definition-cache-missing when there is no manifest', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    await expect(readDefinitionCache(dir)).rejects.toMatchObject({ code: 'definition-cache-missing' });
  });

  it('throws definition-cache-corrupt when a cached file has been tampered with', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const bundle = await resolveCrafted('nested-imports', 'service.wsdl');
    const manifest = await writeDefinitionCache(bundle, dir);
    const victim = manifest.documents[0];
    if (victim === undefined) throw new Error('expected at least one document');
    await writeFile(join(dir, victim.file), 'corrupted bytes');

    await expect(readDefinitionCache(dir)).rejects.toMatchObject({
      code: 'definition-cache-corrupt',
      details: { file: victim.file },
    });
  });
});

describe('createCachedFetchDocument', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('serves cached locations without calling the fallback, and falls back for unknown ones', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const bundle = await resolveCrafted('nested-imports', 'service.wsdl');
    const manifest = await writeDefinitionCache(bundle, dir);

    let fallbackCalls = 0;
    const fallback: FetchDocument = (): Promise<FetchedDocument> => {
      fallbackCalls += 1;
      return Promise.resolve({ location: 'unknown:x', bytes: new Uint8Array(), text: '' });
    };

    const fetchDocument = createCachedFetchDocument(manifest, dir, fallback);
    for (const doc of bundle.documents) {
      const result = await fetchDocument(doc.location);
      expect(Buffer.from(result.bytes)).toEqual(Buffer.from(doc.bytes));
    }
    expect(fallbackCalls).toBe(0);

    await fetchDocument('mem://not-in-cache');
    expect(fallbackCalls).toBe(1);
  });
});

describe('importDefinition — cache modes', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  const location = pathToFileURL(join(craftedRoot, 'nested-imports', 'service.wsdl')).href;

  /** A `FetchDocument` that counts calls and delegates to the real default fetcher. */
  function countingFetch(): { fetchDocument: FetchDocument; calls: () => number } {
    let calls = 0;
    const real = createDefaultFetchDocument();
    return {
      fetchDocument: (loc, signal) => {
        calls += 1;
        return real(loc, signal);
      },
      calls: () => calls,
    };
  }

  const throwingFetch: FetchDocument = () => Promise.reject(new Error('network must not be used'));

  it('refresh: fetches from the network and writes the cache', async () => {
    const dir = await tempDir();
    dirs.push(dir);

    const counting = countingFetch();
    const result = await importDefinition(
      { kind: 'url', url: location },
      { fetchDocument: counting.fetchDocument, cache: { dir, mode: 'refresh' } },
    );

    expect(result.fromCache).toBeUndefined();
    expect(result.problems).toEqual([]);
    expect(counting.calls()).toBeGreaterThan(0);
    await expect(readDefinitionCache(dir)).resolves.toBeDefined();
  });

  it('none: never touches the cache directory', async () => {
    const parent = await tempDir();
    dirs.push(parent);
    const dir = join(parent, 'unused');

    const counting = countingFetch();
    const result = await importDefinition(
      { kind: 'url', url: location },
      { fetchDocument: counting.fetchDocument, cache: { dir, mode: 'none' } },
    );

    expect(result.fromCache).toBeUndefined();
    expect(result.problems).toEqual([]);
    expect(counting.calls()).toBeGreaterThan(0);
    await expect(readDefinitionCache(dir)).rejects.toMatchObject({ code: 'definition-cache-missing' });
  });

  it('prefer-cache + valid cache: reads offline, fromCache true, no network calls', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    await importDefinition({ kind: 'url', url: location }, { cache: { dir, mode: 'refresh' } });

    const second = await importDefinition(
      { kind: 'url', url: location },
      { fetchDocument: throwingFetch, cache: { dir, mode: 'prefer-cache' } },
    );

    expect(second.fromCache).toBe(true);
    expect(second.problems).toEqual([]);
  });

  it('prefer-cache + missing cache: fetches from the network with no problem reported, then writes the cache', async () => {
    const dir = await tempDir();
    dirs.push(dir);

    const counting = countingFetch();
    const result = await importDefinition(
      { kind: 'url', url: location },
      { fetchDocument: counting.fetchDocument, cache: { dir, mode: 'prefer-cache' } },
    );

    expect(result.fromCache).toBeUndefined();
    expect(result.problems).toEqual([]);
    expect(counting.calls()).toBeGreaterThan(0);
    await expect(readDefinitionCache(dir)).resolves.toBeDefined();
  });

  it('prefer-cache + corrupt cache: fetches from the network, reports the problem, and rewrites the cache', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    await importDefinition({ kind: 'url', url: location }, { cache: { dir, mode: 'refresh' } });
    const files = (await readdir(dir)).filter((f) => f !== 'manifest.yaml');
    const victim = files[0];
    if (victim === undefined) throw new Error('expected at least one cached file');
    await writeFile(join(dir, victim), 'corrupted');

    const counting = countingFetch();
    const result = await importDefinition(
      { kind: 'url', url: location },
      { fetchDocument: counting.fetchDocument, cache: { dir, mode: 'prefer-cache' } },
    );

    expect(result.fromCache).toBeUndefined();
    expect(counting.calls()).toBeGreaterThan(0);
    expect(result.problems).toEqual([
      expect.objectContaining({ source: 'resolve', code: 'definition-cache-corrupt', location }),
    ]);
    expect(result.operations.length).toBeGreaterThan(0);

    // the cache was rewritten: the previously-corrupted file is now valid again.
    await expect(readDefinitionCache(dir)).resolves.toBeDefined();
    const restoredBytes = await readFile(join(dir, victim));
    expect(restoredBytes.toString('utf-8')).not.toBe('corrupted');
  });

  it('write failure: reports definition-cache-write-failed but still returns the import result', async () => {
    // Using a plain file (not a directory) as the cache dir makes any write inside it fail.
    const parent = await tempDir();
    dirs.push(parent);
    const notADir = join(parent, 'not-a-directory');
    await writeFile(notADir, 'i am a file, not a directory');

    const result = await importDefinition({ kind: 'url', url: location }, { cache: { dir: notADir, mode: 'refresh' } });

    expect(result.operations.length).toBeGreaterThan(0);
    expect(result.problems).toEqual([
      expect.objectContaining({ source: 'resolve', code: 'definition-cache-write-failed' }),
    ]);
  });
});

// Sanity: ProjectError is re-exported and matches the codes above.
describe('ProjectError codes used by the cache', () => {
  it('are stable strings', () => {
    expect(new ProjectError('definition-cache-missing', 'x').code).toBe('definition-cache-missing');
    expect(new ProjectError('definition-cache-corrupt', 'x').code).toBe('definition-cache-corrupt');
  });
});
