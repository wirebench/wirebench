/**
 * Persists a resolved {@link DefinitionBundle} byte-exact inside a project
 * (`interfaces/<slug>/definition/`) so the interface can be opened offline,
 * and reconstructs a bundle from that cache later. Unlike
 * `wsdl/export-definition.ts`, nothing here is ever re-serialised: every
 * document is written and read back as the exact bytes that were fetched,
 * verified by SHA-256 against the manifest.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ProjectError } from '../errors.js';
import type { DefinitionCacheDocument, DefinitionCacheManifest } from '../project/schema.js';
import { definitionCacheManifestSchema, parseFile } from '../project/schema.js';
import type { DirEntry, FsLike } from '../project/fs.js';
import { nodeFs, readFileIfExists, readdirIfExists, writeFileAtomic } from '../project/fs.js';
import { parseYaml, stringifyYaml } from '../project/yaml.js';
import { parseXml } from '../xml/parse.js';
import { assignFileNames } from './cache-naming.js';
import type { BundledDocument, DefinitionBundle, FetchDocument, FetchedDocument } from './resolver.js';

const MANIFEST_FILE = 'manifest.yaml';

/** Options accepted by {@link writeDefinitionCache} and {@link readDefinitionCache}. */
export interface DefinitionCacheOptions {
  /** Overrides the file system, e.g. for tests. Defaults to `nodeFs`. */
  readonly fs?: FsLike;
}

/** Options accepted by {@link writeDefinitionCache} beyond {@link DefinitionCacheOptions}. */
export interface WriteDefinitionCacheOptions extends DefinitionCacheOptions {
  /** Overrides the clock used for `fetchedAt`. Defaults to `() => new Date().toISOString()`. */
  readonly now?: () => string;
}

/** Hex-encoded SHA-256 digest of `bytes`, used to verify cached documents haven't been tampered with or corrupted. */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Writes every document of `bundle` byte-exact into `dir` (created if
 * needed), alongside a `manifest.yaml` describing them, and returns that
 * manifest. This entirely REPLACES the directory's previous contents: any
 * file left over from a prior cache that is not part of the new manifest is
 * deleted, so the folder never accumulates stale documents across re-caches.
 *
 * @param bundle the resolved definition to cache
 * @param dir absolute path of the interface's `definition/` directory
 */
export async function writeDefinitionCache(
  bundle: DefinitionBundle,
  dir: string,
  options?: WriteDefinitionCacheOptions,
): Promise<DefinitionCacheManifest> {
  const fs = options?.fs ?? nodeFs;
  const now = options?.now ?? (() => new Date().toISOString());

  const existing: readonly DirEntry[] = await readdirIfExists(fs, dir);
  const named = assignFileNames(bundle.documents);

  const documents: DefinitionCacheDocument[] = named.map(({ document, file }) => ({
    file,
    location: document.location,
    ...(document.requestedLocation !== document.location ? { requestedLocation: document.requestedLocation } : {}),
    kind: document.kind,
    sha256: sha256Hex(document.bytes),
    bytes: document.bytes.length,
    ...(document.importedBy !== undefined ? { importedBy: document.importedBy } : {}),
    ...(document.namespace !== undefined ? { namespace: document.namespace } : {}),
    ...(document.chameleonFor !== undefined ? { chameleonFor: document.chameleonFor } : {}),
  }));

  const manifest: DefinitionCacheManifest = {
    formatVersion: 1,
    rootLocation: bundle.root.location,
    fetchedAt: now(),
    documents,
  };

  for (const { document, file } of named) {
    await writeFileAtomic(fs, join(dir, file), Buffer.from(document.bytes));
  }
  await writeFileAtomic(fs, join(dir, MANIFEST_FILE), stringifyYaml(manifest));

  const keep = new Set([MANIFEST_FILE, ...named.map((n) => n.file)]);
  for (const entry of existing) {
    if (entry.isFile && !keep.has(entry.name)) {
      await fs.rm(join(dir, entry.name), { force: true });
    }
  }

  return manifest;
}

/**
 * Reads a manifest previously written by {@link writeDefinitionCache} back
 * into a {@link DefinitionBundle}, re-parsing every document and verifying
 * its bytes against the manifest's recorded SHA-256.
 *
 * @throws {ProjectError} `definition-cache-missing` if `dir` has no `manifest.yaml`
 * @throws {ProjectError} `definition-cache-corrupt` if a document's bytes no longer match its recorded hash
 */
export async function readDefinitionCache(dir: string, options?: DefinitionCacheOptions): Promise<DefinitionBundle> {
  const fs = options?.fs ?? nodeFs;
  const manifestPath = join(dir, MANIFEST_FILE);
  const manifestRaw = await readFileIfExists(fs, manifestPath);
  if (manifestRaw === undefined) {
    throw new ProjectError('definition-cache-missing', `No definition cache manifest at ${manifestPath}`, {
      details: { dir },
    });
  }
  const manifest = parseFile(
    definitionCacheManifestSchema,
    parseYaml(manifestRaw.toString('utf-8'), manifestPath),
    manifestPath,
  );

  const documents: BundledDocument[] = [];
  for (const entry of manifest.documents) {
    const filePath = join(dir, entry.file);
    const buffer = await fs.readFile(filePath);
    const bytes = new Uint8Array(buffer);
    const actualSha256 = sha256Hex(bytes);
    if (actualSha256 !== entry.sha256) {
      throw new ProjectError('definition-cache-corrupt', `Definition cache document "${entry.file}" is corrupt`, {
        details: { file: entry.file, expected: entry.sha256, actual: actualSha256 },
      });
    }
    const text = new TextDecoder('utf-8').decode(bytes);
    const document = parseXml(text, { location: entry.location });
    documents.push({
      location: entry.location,
      requestedLocation: entry.requestedLocation ?? entry.location,
      bytes,
      text,
      kind: entry.kind,
      ...(entry.importedBy !== undefined ? { importedBy: entry.importedBy } : {}),
      ...(entry.namespace !== undefined ? { namespace: entry.namespace } : {}),
      ...(entry.chameleonFor !== undefined ? { chameleonFor: entry.chameleonFor } : {}),
      document,
    });
  }

  const root = documents.find((d) => d.location === manifest.rootLocation) ?? documents[0];
  if (root === undefined) {
    throw new ProjectError(
      'definition-cache-corrupt',
      `Definition cache manifest at ${manifestPath} lists no documents`,
      {
        details: { dir },
      },
    );
  }

  return { root, documents, problems: [] };
}

/**
 * Wraps `fallback` with a {@link FetchDocument} that serves documents from a
 * previously-written cache by canonical location (or the location that was
 * originally requested to fetch it), and only falls through to `fallback`
 * for a location the cache does not contain.
 */
export function createCachedFetchDocument(
  manifest: DefinitionCacheManifest,
  dir: string,
  fallback: FetchDocument,
  options?: DefinitionCacheOptions,
): FetchDocument {
  const fs = options?.fs ?? nodeFs;
  const byLocation = new Map<string, DefinitionCacheDocument>();
  for (const entry of manifest.documents) {
    byLocation.set(entry.location, entry);
    if (entry.requestedLocation !== undefined) {
      byLocation.set(entry.requestedLocation, entry);
    }
  }

  return async (location: string, signal?: AbortSignal): Promise<FetchedDocument> => {
    const entry = byLocation.get(location);
    if (entry === undefined) {
      return fallback(location, signal);
    }
    const buffer = await fs.readFile(join(dir, entry.file));
    const bytes = new Uint8Array(buffer);
    return { location: entry.location, bytes, text: new TextDecoder('utf-8').decode(bytes) };
  };
}
