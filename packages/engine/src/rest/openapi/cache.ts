/**
 * Persisting an imported OpenAPI definition byte-exact under `apis/<slug>/definition/`.
 *
 * The same contract the WSDL cache keeps (`wsdl/cache.ts`): nothing is ever re-serialised, so an
 * export of a cached definition is byte-identical to what was fetched, and a `manifest.yaml` records
 * each document's location, size and SHA-256 so corruption is noticed rather than parsed. What
 * differs is only what there is to record — a JSON or YAML document has no namespace, no `kind` and
 * no importing document, just a location and its bytes.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ProjectError } from '../../errors.js';
import type { DirEntry, FsLike } from '../../project/fs.js';
import { nodeFs, readFileIfExists, readdirIfExists, writeFileAtomic } from '../../project/fs.js';
import type { ApiDefinitionCacheDocument, ApiDefinitionCacheManifest } from '../../project/schema.js';
import { apiDefinitionCacheManifestSchema, parseFile } from '../../project/schema.js';
import { parseYaml, stringifyYaml } from '../../project/yaml.js';
import { assignFileNames } from '../../wsdl/cache-naming.js';
import type { FetchDocument, FetchedDocument } from '../../wsdl/resolver.js';
import type { ResolvedDocument } from './refs.js';

const MANIFEST_FILE = 'manifest.yaml';

/** Options accepted by the read and write halves. */
export interface ApiDefinitionCacheOptions {
  /** Overrides the file system, e.g. for tests. Defaults to `nodeFs`. */
  readonly fs?: FsLike;
}

/** Options accepted by {@link writeApiDefinitionCache}. */
export interface WriteApiDefinitionCacheOptions extends ApiDefinitionCacheOptions {
  /** Overrides the clock used for `fetchedAt`. Defaults to `() => new Date().toISOString()`. */
  readonly now?: () => string;
  /** The `openapi` string the root document declared, recorded for the definition card. */
  readonly declaredVersion?: string;
  /**
   * The name the root document is cached under when its own location gives none. Defaults to
   * `openapi.yaml`; an AsyncAPI import passes `asyncapi.yaml`.
   */
  readonly rootFile?: string;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A document's fallback extension: what it actually is, not what its URL claims. */
function kindOf(text: string): 'json' | 'yaml' {
  return text.trimStart().startsWith('{') ? 'json' : 'yaml';
}

/**
 * Writes every document byte-exact into `dir` (created if needed) alongside a `manifest.yaml`, and
 * returns that manifest. The directory's previous contents are REPLACED: a file left over from an
 * earlier cache that the new manifest does not list is deleted, so the folder never accumulates
 * documents a later import no longer references.
 *
 * @param documents every document the import was made of, root first
 * @param dir absolute path of the API's `definition/` directory
 */
export async function writeApiDefinitionCache(
  documents: readonly ResolvedDocument[],
  dir: string,
  options?: WriteApiDefinitionCacheOptions,
): Promise<ApiDefinitionCacheManifest> {
  const fs = options?.fs ?? nodeFs;
  const now = options?.now ?? (() => new Date().toISOString());
  const root = documents[0];
  if (root === undefined) {
    throw new ProjectError('definition-cache-corrupt', 'An API definition cache needs at least one document', {
      details: { dir },
    });
  }

  const existing: readonly DirEntry[] = await readdirIfExists(fs, dir);
  const named = assignFileNames(
    documents.map((document) => ({ ...document, kind: kindOf(document.text) })),
    { rootFile: options?.rootFile ?? 'openapi.yaml' },
  );

  const entries: ApiDefinitionCacheDocument[] = named.map(({ document, file }) => ({
    file,
    location: document.location,
    ...(document.requestedLocation !== document.location ? { requestedLocation: document.requestedLocation } : {}),
    sha256: sha256Hex(document.bytes),
    bytes: document.bytes.length,
  }));

  const manifest: ApiDefinitionCacheManifest = {
    formatVersion: 1,
    rootLocation: root.location,
    fetchedAt: now(),
    ...(options?.declaredVersion !== undefined ? { declaredVersion: options.declaredVersion } : {}),
    documents: entries,
  };

  for (const { document, file } of named) {
    await writeFileAtomic(fs, join(dir, file), Buffer.from(document.bytes));
  }
  await writeFileAtomic(fs, join(dir, MANIFEST_FILE), stringifyYaml(manifest));

  const keep = new Set([MANIFEST_FILE, ...named.map((one) => one.file)]);
  for (const entry of existing) {
    if (entry.isFile && !keep.has(entry.name)) {
      await fs.rm(join(dir, entry.name), { force: true });
    }
  }

  return manifest;
}

/** A cached definition: its manifest and every document it lists, root first. */
export interface CachedApiDefinition {
  readonly manifest: ApiDefinitionCacheManifest;
  readonly documents: readonly ResolvedDocument[];
}

/**
 * Reads a cache previously written by {@link writeApiDefinitionCache}, verifying every document's
 * bytes against its recorded SHA-256.
 *
 * @throws {ProjectError} `definition-cache-missing` if `dir` has no `manifest.yaml`
 * @throws {ProjectError} `definition-cache-corrupt` if a document's bytes no longer match its hash
 */
export async function readApiDefinitionCache(
  dir: string,
  options?: ApiDefinitionCacheOptions,
): Promise<CachedApiDefinition> {
  const fs = options?.fs ?? nodeFs;
  const manifestPath = join(dir, MANIFEST_FILE);
  const raw = await readFileIfExists(fs, manifestPath);
  if (raw === undefined) {
    throw new ProjectError('definition-cache-missing', `No API definition cache manifest at ${manifestPath}`, {
      details: { dir },
    });
  }
  const manifest = parseFile(
    apiDefinitionCacheManifestSchema,
    parseYaml(raw.toString('utf-8'), manifestPath),
    manifestPath,
  );

  const documents: ResolvedDocument[] = [];
  for (const entry of manifest.documents) {
    const bytes = new Uint8Array(await fs.readFile(join(dir, entry.file)));
    const actual = sha256Hex(bytes);
    if (actual !== entry.sha256) {
      throw new ProjectError('definition-cache-corrupt', `Definition cache document "${entry.file}" is corrupt`, {
        details: { file: entry.file, expected: entry.sha256, actual },
      });
    }
    documents.push({
      location: entry.location,
      requestedLocation: entry.requestedLocation ?? entry.location,
      bytes,
      text: new TextDecoder('utf-8').decode(bytes),
    });
  }
  return { manifest, documents };
}

/**
 * Wraps `fallback` with a fetcher that answers from a written cache by location (or by the location
 * originally requested), and only reaches the network for something the cache does not hold. This is
 * what lets an imported API be re-read, exported and viewed with no connection at all.
 */
export function createCachedApiFetch(
  manifest: ApiDefinitionCacheManifest,
  dir: string,
  fallback: FetchDocument,
  options?: ApiDefinitionCacheOptions,
): FetchDocument {
  const fs = options?.fs ?? nodeFs;
  const byLocation = new Map<string, ApiDefinitionCacheDocument>();
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
    const bytes = new Uint8Array(await fs.readFile(join(dir, entry.file)));
    return { location: entry.location, bytes, text: new TextDecoder('utf-8').decode(bytes) };
  };
}
