/**
 * How a SOAP send gets an attachment's bytes. The engine never reads an attachment on its own: the
 * send path is handed an {@link AttachmentResolver}, and the desktop main process (which owns the
 * project directory and its cache) decides where bytes come from. The cache itself, keyed by hash and
 * knowing nothing of attachments, is `project/attachments-cache.ts`.
 */
import { isAbsolute, join } from 'node:path';
import { ProjectError } from '#core/errors';
import type { AttachmentCacheOptions } from '#core/project/attachments-cache';
import { readAttachment } from '#core/project/attachments-cache';
import { nodeFs, readFileIfExists } from '#core/project/fs';
import type { Attachment } from './model.js';

/** Resolves one attachment's bytes. Rejects when the attachment cannot be read. */
export type AttachmentResolver = (attachment: Attachment) => Promise<Uint8Array>;

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
