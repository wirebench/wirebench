/**
 * Persisting an imported `.proto` set byte-exact under `apis/<slug>/definition/`.
 *
 * The same contract the WSDL and OpenAPI caches keep: nothing is re-serialised, a `manifest.yaml`
 * records each file's size and SHA-256 so corruption is noticed rather than parsed, and an export is
 * byte-identical to what was imported. What differs is the layout: a `.proto` reaches its imports by
 * path, so each file is stored under `protos/` *at its import path* — the set loads again from the
 * cache exactly as it loaded from the user's folder, with no renaming to undo.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ProjectError } from '../errors.js';
import type { FsLike } from '../project/fs.js';
import { nodeFs, readFileIfExists, readdirIfExists, writeFileAtomic } from '../project/fs.js';
import { assertPathSegment } from '../project/paths.js';
import type { ProtoDefinitionCacheManifest } from '../project/schema.js';
import { parseFile, protoDefinitionCacheManifestSchema } from '../project/schema.js';
import { parseYaml, stringifyYaml } from '../project/yaml.js';
import type { ProtoSources } from './proto/load.js';

const MANIFEST_FILE = 'manifest.yaml';
/** The directory under `definition/` the `.proto` files live in, at their import paths. */
export const PROTOS_DIR = 'protos';

/** Options accepted by the read and write halves. */
export interface ProtoDefinitionCacheOptions {
  /** Overrides the file system, e.g. for tests. Defaults to `nodeFs`. */
  readonly fs?: FsLike;
}

/** Options accepted by {@link writeProtoDefinitionCache}. */
export interface WriteProtoDefinitionCacheOptions extends ProtoDefinitionCacheOptions {
  /** Where the files came from, as the user gave it. */
  readonly source: string;
  /** The import paths the load started from. */
  readonly roots: readonly string[];
  /** Overrides the clock used for `fetchedAt`. */
  readonly now?: () => string;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Splits an import path into segments, each checked as a path segment (ADR-0005), so a file that
 * calls itself `../../etc/passwd.proto` never leaves the cache directory.
 *
 * @throws ProjectError `project-path-invalid`
 */
export function protoPathSegments(path: string): string[] {
  const segments = path.split('/');
  if (segments.length === 0 || segments.some((segment) => segment === '')) {
    throw new ProjectError('project-path-invalid', `"${path}" is not a usable .proto import path`, {
      details: { path },
    });
  }
  for (const segment of segments) {
    assertPathSegment(segment);
  }
  return segments;
}

/** Every file under `dir`, recursively, as `/`-separated paths relative to it. */
async function listFiles(fs: FsLike, dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdirIfExists(fs, dir)) {
    if (entry.isDirectory) {
      out.push(...(await listFiles(fs, join(dir, entry.name), `${prefix}${entry.name}/`)));
    } else if (entry.isFile) {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return out;
}

/**
 * Writes every source byte-exact under `dir/protos/` alongside a `manifest.yaml`, and returns the
 * manifest. The previous contents are REPLACED: a file the new manifest does not list is deleted.
 *
 * @param sources the `.proto` files, keyed by import path
 * @param dir absolute path of the API's `definition/` directory
 * @throws ProjectError `definition-cache-corrupt` for an empty set, `project-path-invalid` for an unsafe path
 */
export async function writeProtoDefinitionCache(
  sources: ProtoSources,
  dir: string,
  options: WriteProtoDefinitionCacheOptions,
): Promise<ProtoDefinitionCacheManifest> {
  const fs = options.fs ?? nodeFs;
  if (sources.size === 0) {
    throw new ProjectError('definition-cache-corrupt', 'A proto definition cache needs at least one file', {
      details: { dir },
    });
  }
  const protosDir = join(dir, PROTOS_DIR);
  const existing = await listFiles(fs, protosDir);
  const files = [...sources.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, text]) => {
      protoPathSegments(path);
      const bytes = Buffer.from(text, 'utf8');
      return { path, sha256: sha256Hex(bytes), bytes: bytes.byteLength, content: bytes };
    });
  const manifest: ProtoDefinitionCacheManifest = {
    formatVersion: 1,
    kind: 'proto',
    source: options.source,
    fetchedAt: (options.now ?? (() => new Date().toISOString()))(),
    roots: [...options.roots],
    files: files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
  };
  for (const file of files) {
    await writeFileAtomic(fs, join(protosDir, ...protoPathSegments(file.path)), file.content);
  }
  await writeFileAtomic(fs, join(dir, MANIFEST_FILE), stringifyYaml(manifest));
  const keep = new Set(files.map((file) => file.path));
  for (const stale of existing) {
    if (!keep.has(stale)) {
      await fs.rm(join(protosDir, ...stale.split('/')), { force: true });
    }
  }
  return manifest;
}

/** A cached `.proto` set: its manifest and every file it lists. */
export interface CachedProtoDefinition {
  readonly manifest: ProtoDefinitionCacheManifest;
  readonly sources: Map<string, string>;
}

/**
 * Reads a cache previously written by {@link writeProtoDefinitionCache}, verifying every file's
 * bytes against its recorded SHA-256.
 *
 * @throws ProjectError `definition-cache-missing` when `dir` has no `manifest.yaml` or it is not a
 * proto manifest, `definition-cache-corrupt` when a file is gone or its bytes no longer match
 */
export async function readProtoDefinitionCache(
  dir: string,
  options?: ProtoDefinitionCacheOptions,
): Promise<CachedProtoDefinition> {
  const fs = options?.fs ?? nodeFs;
  const manifestPath = join(dir, MANIFEST_FILE);
  const raw = await readFileIfExists(fs, manifestPath);
  if (raw === undefined) {
    throw new ProjectError('definition-cache-missing', `No definition cache manifest at ${manifestPath}`, {
      details: { dir },
    });
  }
  const document = parseYaml(raw.toString('utf8'), manifestPath);
  if (typeof document !== 'object' || document === null || (document as { kind?: unknown }).kind !== 'proto') {
    throw new ProjectError('definition-cache-missing', `${manifestPath} is not a .proto definition cache`, {
      details: { dir },
    });
  }
  const manifest = parseFile(protoDefinitionCacheManifestSchema, document, manifestPath);
  const sources = new Map<string, string>();
  for (const file of manifest.files) {
    const bytes = await readFileIfExists(fs, join(dir, PROTOS_DIR, ...protoPathSegments(file.path)));
    if (bytes === undefined) {
      throw new ProjectError(
        'definition-cache-corrupt',
        `${file.path} is listed in the manifest but missing from the cache`,
        {
          details: { dir, path: file.path },
        },
      );
    }
    if (sha256Hex(bytes) !== file.sha256) {
      throw new ProjectError(
        'definition-cache-corrupt',
        `${file.path} no longer matches the hash the manifest recorded`,
        {
          details: { dir, path: file.path },
        },
      );
    }
    sources.set(file.path, bytes.toString('utf8'));
  }
  return { manifest, sources };
}
