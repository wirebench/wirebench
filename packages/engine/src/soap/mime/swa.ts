/**
 * SOAP with Attachments (SwA), including swaRef per WS-I Attachments Profile 1.0.
 *
 * SwA is the plain case: the envelope is sent untouched as the root part and every
 * attachment rides along beside it. A `ref:swaRef`-typed element already contains the
 * `cid:` reference the profile asks for, so — unlike MTOM — nothing in the body is
 * rewritten; the reference simply has to name a part that is actually there.
 */

import type { Attachment } from '../../project/model.js';
import { findCidReferences } from './cid-scan.js';
import type { ParsedMultipart } from './multipart.js';
import type { AttachmentResolver, MultipartPart, ResponseAttachment } from './types.js';

/** Knobs for {@link prepareSwaRequest}. */
export interface SwaOptions {
  readonly resolver: AttachmentResolver;
  /** SoapUI's "Encode Attachments": base64 transfer encoding instead of binary. */
  readonly encodeAttachments: boolean;
  /** SoapUI's "Disable Multiparts": send the envelope alone and ignore every attachment. */
  readonly disableMultiparts?: boolean;
}

/** What {@link prepareSwaRequest} produced. */
export interface PreparedSwa {
  readonly parts: readonly MultipartPart[];
  /** False when nothing is to be sent as a multipart (no attachments, or multiparts disabled). */
  readonly used: boolean;
  /** Content-IDs the envelope actually references with `cid:` (swaRef and friends). */
  readonly referencedContentIds: readonly string[];
}

/** The Content-ID an attachment goes out with: its own, or its id as a fallback. */
function contentIdOf(attachment: Attachment): string {
  return attachment.contentId.length > 0 ? attachment.contentId : `${attachment.id}@wirebench`;
}

/**
 * Builds the SwA parts for `attachments` — every attachment MTOM did not already consume.
 *
 * The envelope is never modified; it is only scanned, so the caller can tell which
 * attachments a `cid:` reference in the body actually points at (an unreferenced
 * attachment is still sent, which is what SoapUI does and what "anonymous" MIME parts are
 * for).
 *
 * @param envelopeXml the envelope as it will be sent
 * @param attachments the attachments to package
 * @param options the resolver plus the request's encode/disable flags
 */
export async function prepareSwaRequest(
  envelopeXml: string,
  attachments: readonly Attachment[],
  options: SwaOptions,
): Promise<PreparedSwa> {
  if (options.disableMultiparts === true || attachments.length === 0) {
    return { parts: [], used: false, referencedContentIds: [] };
  }

  const referenced = new Set(findCidReferences(envelopeXml).references.map((reference) => reference.cid));
  const parts: MultipartPart[] = [];
  const referencedContentIds: string[] = [];
  for (const attachment of attachments) {
    const contentId = contentIdOf(attachment);
    if (referenced.has(contentId) || referenced.has(attachment.id)) {
      referencedContentIds.push(contentId);
    }
    parts.push({
      contentId,
      contentType: attachment.contentType,
      bytes: await options.resolver(attachment),
      transferEncoding: options.encodeAttachments ? 'base64' : 'binary',
      ...(attachment.name.length > 0 ? { fileName: attachment.name } : {}),
      ...(attachment.part !== undefined && attachment.part.length > 0 ? { partName: attachment.part } : {}),
    });
  }
  return { parts, used: parts.length > 0, referencedContentIds };
}

/**
 * Describes every non-root part of a parsed response as a {@link ResponseAttachment}.
 *
 * @param parsed the parsed `multipart/related` response
 */
export function collectResponseAttachments(parsed: ParsedMultipart): readonly ResponseAttachment[] {
  return parsed.parts.map((part) => ({
    contentId: part.contentId ?? '',
    contentType: part.contentType,
    size: part.bytes.length,
    bytes: part.bytes,
    ...(part.fileName !== undefined ? { name: part.fileName } : {}),
    ...(part.transferEncoding !== undefined ? { transferEncoding: part.transferEncoding } : {}),
  }));
}
