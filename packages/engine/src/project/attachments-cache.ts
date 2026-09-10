/**
 * The project's attachment cache: `attachments/<sha256>` plus an `attachments/index.yaml`
 * describing each blob.
 *
 * Content addressing means adding the same file twice costs one copy, a request that
 * references it keeps working when the original is moved or deleted, and the project stays
 * diffable — the index is the only file that changes when metadata does. Nothing is ever
 * deleted implicitly: {@link pruneAttachments} exists so the UI can offer it explicitly,
 * because a blob whose last reference was removed in an unsaved edit must survive an undo.
 */

import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { ProjectError } from '../errors.js';
import type { Attachment } from './model.js';
import { nodeFs, readFileIfExists, readdirIfExists, writeFileAtomic, type FsLike } from './fs.js';
import { ATTACHMENTS_DIR } from './paths.js';
import type { AttachmentResolver } from '../soap/mime/types.js';
import { parseYaml, stringifyYaml } from './yaml.js';

/** One blob in the attachment cache, as recorded in `attachments/index.yaml`. */
export interface AttachmentCacheEntry {
  readonly sha256: string;
  /** Name of the file the bytes were added from. */
  readonly originalName: string;
  readonly contentType: string;
  readonly size: number;
}

/** Options every cache function accepts. */
export interface AttachmentCacheOptions {
  readonly fs?: FsLike;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** Absolute path of the attachment cache directory. */
export function attachmentsDir(projectDir: string): string {
  return join(projectDir, ATTACHMENTS_DIR);
}

/** Absolute path of the cache index. */
export function attachmentsIndexFile(projectDir: string): string {
  return join(attachmentsDir(projectDir), 'index.yaml');
}

/** Absolute path of one cached blob. */
export function attachmentFile(projectDir: string, sha256: string): string {
  assertDigest(sha256);
  return join(attachmentsDir(projectDir), sha256);
}

function assertDigest(sha256: string): void {
  if (!SHA256.test(sha256)) {
    throw new ProjectError('attachment-invalid-digest', `"${sha256}" is not a sha256 digest`, {
      details: { sha256 },
    });
  }
}

/** The cache index, or an empty one when the project has no attachments yet. */
async function readIndex(projectDir: string, fs: FsLike): Promise<Map<string, AttachmentCacheEntry>> {
  const buffer = await readFileIfExists(fs, attachmentsIndexFile(projectDir));
  const index = new Map<string, AttachmentCacheEntry>();
  if (buffer === undefined) {
    return index;
  }
  const parsed = parseYaml(buffer.toString('utf8'), `${ATTACHMENTS_DIR}/index.yaml`);
  if (typeof parsed !== 'object' || parsed === null) {
    return index;
  }
  for (const [sha256, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      continue;
    }
    const record = value as { originalName?: unknown; contentType?: unknown; size?: unknown };
    index.set(sha256, {
      sha256,
      originalName: typeof record.originalName === 'string' ? record.originalName : sha256,
      contentType: typeof record.contentType === 'string' ? record.contentType : 'application/octet-stream',
      size: typeof record.size === 'number' ? record.size : 0,
    });
  }
  return index;
}

async function writeIndex(
  projectDir: string,
  fs: FsLike,
  index: ReadonlyMap<string, AttachmentCacheEntry>,
): Promise<void> {
  const document: Record<string, unknown> = {};
  for (const entry of [...index.values()].sort((a, b) => a.sha256.localeCompare(b.sha256))) {
    document[entry.sha256] = {
      originalName: entry.originalName,
      contentType: entry.contentType,
      size: entry.size,
    };
  }
  await writeFileAtomic(fs, attachmentsIndexFile(projectDir), stringifyYaml(document));
}

/**
 * Copies `bytes` into the project's attachment cache, returning the digest a
 * {@link Attachment} with a `cache` source references.
 *
 * Re-adding identical bytes is a no-op beyond the index lookup, and the metadata of the
 * first add wins: the digest is the identity, so a second name for the same content would
 * only make the index ambiguous.
 *
 * @param projectDir the project root
 * @param bytes the file content to cache
 * @param meta the name and content type to record for it
 */
export async function putAttachment(
  projectDir: string,
  bytes: Uint8Array,
  meta: { readonly originalName: string; readonly contentType: string },
  options: AttachmentCacheOptions = {},
): Promise<{ readonly sha256: string; readonly size: number }> {
  const fs = options.fs ?? nodeFs;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const index = await readIndex(projectDir, fs);
  const file = attachmentFile(projectDir, sha256);
  // The blob is rewritten when it is missing even though the index knows it: a project
  // whose `attachments/` was partly lost (a bad merge, a stray delete) heals on the next add.
  if ((await readFileIfExists(fs, file)) === undefined) {
    await writeFileAtomic(fs, file, Buffer.from(bytes));
  }
  if (!index.has(sha256)) {
    index.set(sha256, { sha256, originalName: meta.originalName, contentType: meta.contentType, size: bytes.length });
    await writeIndex(projectDir, fs, index);
  }
  return { sha256, size: bytes.length };
}

/**
 * Reads one cached blob.
 *
 * @param projectDir the project root
 * @param sha256 the digest recorded on the attachment
 */
export async function readAttachment(
  projectDir: string,
  sha256: string,
  options: AttachmentCacheOptions = {},
): Promise<Uint8Array> {
  const fs = options.fs ?? nodeFs;
  const file = attachmentFile(projectDir, sha256);
  const buffer = await readFileIfExists(fs, file);
  if (buffer === undefined) {
    throw new ProjectError('attachment-missing', `Cached attachment ${sha256} is not in this project`, {
      details: { sha256 },
    });
  }
  return new Uint8Array(buffer);
}

/** Every blob in the cache, ordered by digest. */
export async function listAttachments(
  projectDir: string,
  options: AttachmentCacheOptions = {},
): Promise<readonly AttachmentCacheEntry[]> {
  const fs = options.fs ?? nodeFs;
  const index = await readIndex(projectDir, fs);
  return [...index.values()].sort((a, b) => a.sha256.localeCompare(b.sha256));
}

/**
 * Deletes every cached blob whose digest is not in `referencedShas`, index entry included.
 *
 * Called only when the UI explicitly asks: an automatic prune would race with editing (an
 * attachment removed from a request but not yet saved is still referenced by the document
 * on disk, and vice versa).
 *
 * @param projectDir the project root
 * @param referencedShas digests still referenced by the project's requests
 */
export async function pruneAttachments(
  projectDir: string,
  referencedShas: Iterable<string>,
  options: AttachmentCacheOptions = {},
): Promise<{ readonly removed: readonly string[] }> {
  const fs = options.fs ?? nodeFs;
  const keep = new Set(referencedShas);
  const index = await readIndex(projectDir, fs);
  const onDisk = (await readdirIfExists(fs, attachmentsDir(projectDir)))
    .filter((entry) => entry.isFile && SHA256.test(entry.name))
    .map((entry) => entry.name);

  const removed: string[] = [];
  for (const sha256 of new Set([...index.keys(), ...onDisk]).values()) {
    if (keep.has(sha256)) {
      continue;
    }
    await fs.rm(attachmentFile(projectDir, sha256), { force: true });
    index.delete(sha256);
    removed.push(sha256);
  }
  if (removed.length > 0) {
    await writeIndex(projectDir, fs, index);
  }
  return { removed: removed.sort() };
}

/**
 * The {@link AttachmentResolver} the desktop main process hands to the send path: cached
 * attachments come out of `attachments/`, path attachments off disk (absolute, or relative
 * to the resource root and then to the project itself, in that order).
 *
 * @param projectDir the project root
 * @param resourceRoot the project's resource root, when it has one
 */
export function createFileAttachmentResolver(
  projectDir: string,
  resourceRoot?: string,
  options: AttachmentCacheOptions = {},
): AttachmentResolver {
  const fs = options.fs ?? nodeFs;
  return async (attachment: Attachment): Promise<Uint8Array> => {
    if (attachment.source.kind === 'cache') {
      return readAttachment(projectDir, attachment.source.sha256, { fs });
    }
    const path = attachment.source.path;
    const candidates = isAbsolute(path)
      ? [path]
      : resourceRoot === undefined
        ? [join(projectDir, path)]
        : [join(resourceRoot, path), join(projectDir, path)];
    for (const candidate of candidates) {
      const buffer = await readFileIfExists(fs, candidate);
      if (buffer !== undefined) {
        return new Uint8Array(buffer);
      }
    }
    throw new ProjectError('attachment-unreadable', `Attachment "${attachment.name}" could not be read from ${path}`, {
      details: { attachmentId: attachment.id, path },
    });
  };
}
