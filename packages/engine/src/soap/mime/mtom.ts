/**
 * MTOM/XOP (SOAP Message Transmission Optimization Mechanism).
 *
 * Outgoing, this implements the rule SoapUI exposes in the request editor: an element
 * whose text is exactly `cid:<content-id>` names an attachment, and enabling MTOM replaces
 * that text with an `<xop:Include>` while the bytes travel unencoded in their own MIME
 * part. Nothing is inferred from the schema — a base64Binary element that does not carry a
 * `cid:` reference is left alone, and a `cid:` reference naming no attachment stays as it
 * is (the server may know what it means).
 *
 * Incoming, an `<xop:Include>` can either be expanded back into base64 inside the envelope
 * (SoapUI's "Expand MTOM Attachments") or left in place with the part listed alongside.
 */

import type { Attachment } from '../../project/model.js';
import { scanXml } from '../../xsd/xml-scan.js';
import { findCidReferences, forEachScannedElement, spliceRanges } from './cid-scan.js';
import { mediaTypeOf, mimeParameter, type ParsedMultipart } from './multipart.js';
import { collectResponseAttachments } from './swa.js';
import type { AttachmentResolver, MultipartPart, ResponseAttachment } from './types.js';

/** The XOP namespace, whose `Include` element replaces optimised content. */
export const XOP_NS = 'http://www.w3.org/2004/08/xop/include';

/** Knobs for {@link prepareMtomRequest}. */
export interface MtomOptions {
  /** SoapUI's "Force MTOM": package as MTOM even when nothing was optimised. */
  readonly force: boolean;
  readonly resolver: AttachmentResolver;
}

/** What {@link prepareMtomRequest} produced. */
export interface PreparedMtom {
  /** The envelope with every resolved `cid:` reference replaced by an `xop:Include`. */
  readonly envelopeXml: string;
  readonly parts: readonly MultipartPart[];
  /** True when the message must be packaged as an MTOM `multipart/related`. */
  readonly used: boolean;
  /** Ids of the attachments that became XOP parts; the rest fall through to SwA. */
  readonly consumedIds: readonly string[];
}

/** What {@link expandMtomResponse} produced. */
export interface ExpandedMtom {
  readonly envelopeXml: string;
  readonly attachments: readonly ResponseAttachment[];
  /** Content-IDs whose bytes were written into the envelope as base64. */
  readonly inlinedContentIds: readonly string[];
}

/**
 * Turns a SOAP content type into the XOP root part's content type.
 *
 * The SOAP media type moves into the `type` parameter (so the receiver knows what the
 * package encodes) and any SOAP 1.2 `action` parameter is kept, at the end, on the root
 * part itself — the multipart's own `Content-Type` has no room for it.
 *
 * @param soapContentType e.g. `text/xml;charset=UTF-8` or `application/soap+xml;charset=UTF-8;action="urn:Add"`
 */
export function xopContentType(soapContentType: string): string {
  const mediaType = mediaTypeOf(soapContentType);
  const charset = mimeParameter(soapContentType, 'charset') ?? 'UTF-8';
  const action = mimeParameter(soapContentType, 'action');
  return (
    `application/xop+xml;charset=${charset};type="${mediaType}"` + (action === undefined ? '' : `;action="${action}"`)
  );
}

/**
 * Percent-decodes a `cid:` href's tail, falling back to the raw string when it is not valid
 * percent-encoding (e.g. a stray `%` from a server that did not escape its Content-IDs) —
 * a malformed response should not throw out of the send path.
 */
function decodeCidHref(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The attachment a `cid:` reference names: by Content-ID first, then by attachment id. */
function findAttachment(attachments: readonly Attachment[], cid: string): Attachment | undefined {
  return attachments.find((a) => a.contentId === cid) ?? attachments.find((a) => a.id === cid);
}

/**
 * Rewrites `envelopeXml` for MTOM and resolves the bytes of every attachment it optimises.
 *
 * @param envelopeXml the envelope as it would otherwise be sent
 * @param attachments the request's attachments
 * @param options `force` packaging and the resolver that reads attachment bytes
 */
export async function prepareMtomRequest(
  envelopeXml: string,
  attachments: readonly Attachment[],
  options: MtomOptions,
): Promise<PreparedMtom> {
  const scan = findCidReferences(envelopeXml);
  const edits: { readonly range: { readonly start: number; readonly end: number }; readonly text: string }[] = [];
  const consumed = new Map<string, Attachment>();

  for (const reference of scan.references) {
    const attachment = findAttachment(attachments, reference.cid);
    if (attachment === undefined) {
      continue;
    }
    const contentId = attachment.contentId.length > 0 ? attachment.contentId : `${attachment.id}@wirebench`;
    consumed.set(attachment.id, attachment);
    edits.push({
      range: reference.range,
      text: `<xop:Include href="cid:${contentId}" xmlns:xop="${XOP_NS}"/>`,
    });
  }

  const parts: MultipartPart[] = [];
  for (const attachment of consumed.values()) {
    parts.push({
      contentId: attachment.contentId.length > 0 ? attachment.contentId : `${attachment.id}@wirebench`,
      contentType: attachment.contentType,
      bytes: await options.resolver(attachment),
      transferEncoding: 'binary',
      ...(attachment.name.length > 0 ? { fileName: attachment.name } : {}),
      ...(attachment.part !== undefined && attachment.part.length > 0 ? { partName: attachment.part } : {}),
    });
  }

  return {
    envelopeXml: spliceRanges(envelopeXml, edits),
    parts,
    used: parts.length > 0 || options.force,
    consumedIds: [...consumed.keys()],
  };
}

/**
 * Expands (or merely lists) the XOP parts of a `multipart/related` response.
 *
 * With `inline` set, every `<xop:Include>` whose part is present is replaced by that
 * part's base64, which is what the receiver's own XML tooling would have seen; the parts
 * stay listed so the caller can still show and save them. Without it the envelope is
 * returned as received.
 *
 * @param parsed the parsed multipart response
 * @param options `inline` expansion, and the already charset-decoded root text when the caller has it
 */
export function expandMtomResponse(
  parsed: ParsedMultipart,
  options: { readonly inline: boolean; readonly envelopeXml?: string },
): ExpandedMtom {
  const envelopeXml = options.envelopeXml ?? Buffer.from(parsed.root.bytes).toString('utf-8');
  const attachments = collectResponseAttachments(parsed);
  if (!options.inline) {
    return { envelopeXml, attachments, inlinedContentIds: [] };
  }

  const scan = scanXml(envelopeXml);
  if (scan.problems.length > 0) {
    return { envelopeXml, attachments, inlinedContentIds: [] };
  }
  const byContentId = new Map(parsed.parts.map((part) => [part.contentId ?? '', part]));
  const edits: { readonly range: { readonly start: number; readonly end: number }; readonly text: string }[] = [];
  const inlined: string[] = [];

  forEachScannedElement(scan.elements, (element) => {
    if (element.localName !== 'Include' || element.namespaceUri !== XOP_NS) {
      return;
    }
    const href = element.attributes.find((attribute) => attribute.name === 'href')?.value;
    if (href === undefined || !href.startsWith('cid:')) {
      return;
    }
    const contentId = decodeCidHref(href.slice('cid:'.length));
    const part = byContentId.get(contentId);
    if (part === undefined) {
      return;
    }
    inlined.push(contentId);
    edits.push({ range: element.range, text: Buffer.from(part.bytes).toString('base64') });
  });

  return { envelopeXml: spliceRanges(envelopeXml, edits), attachments, inlinedContentIds: inlined };
}
