/**
 * The attachment stages of a send: what happens to the envelope on the way out, and how a
 * `multipart/related` response is unwrapped on the way back in.
 *
 * Kept beside the MIME modules rather than in `send.ts` so the ordering rules live next to
 * the code that implements them.
 */

import { headerValue, setHeader } from '../../http/headers.js';
import { decodeBody, encodeBody } from '../charset.js';
import type { SoapExchange, SoapSendInput } from '../../types.js';
import { inlineFiles } from './inline-files.js';
import { expandMtomResponse, prepareMtomRequest, xopContentType } from './mtom.js';
import { DEFAULT_ROOT_CONTENT_ID, buildMultipartRelated, mediaTypeOf, parseMultipartRelated } from './multipart.js';
import { prepareSwaRequest } from './swa.js';
import type { MultipartPart, ResponseAttachment } from './types.js';

/** One problem recorded on the exchange. */
export type SoapProblem = SoapExchange['problems'][number];

/**
 * Substitutes every `file:` reference in the envelope with the file's base64 bytes.
 *
 * This is envelope *text preparation*, exactly like property expansion, so it runs before the
 * envelope transforms rather than with the attachment packaging that follows them (see
 * `send.ts`): a WS-Security signature must cover the bytes that actually go on the wire, and
 * signing the literal `file:/…` text and then replacing it would produce a signature no
 * receiver can verify.
 *
 * A missing file is a problem, not a failure: the reference is left verbatim and the send
 * continues, since the server's own error is usually more informative than a client-side abort.
 * Without a `resolveFile` there is no way to read anything, so the property is inert.
 *
 * @param input the (already expanded) send input
 * @param problems collects non-fatal issues, e.g. an inline file that is missing
 * @returns the envelope with every readable `file:` reference replaced
 */
export async function substituteInlineFiles(input: SoapSendInput, problems: SoapProblem[]): Promise<string> {
  const options = input.attachmentOptions;
  if (options === undefined || !options.enableInlineFiles || options.resolveFile === undefined) {
    return input.envelopeXml;
  }
  const inlined = await inlineFiles(input.envelopeXml, {
    enabled: true,
    resolveFile: options.resolveFile,
    ...(options.resourceRoot !== undefined ? { resourceRoot: options.resourceRoot } : {}),
  });
  for (const problem of inlined.problems) {
    problems.push({ code: problem.code, message: problem.message });
  }
  return inlined.envelopeXml;
}

/**
 * Runs the request-side attachment pipeline and returns the bytes to send.
 *
 * The order is fixed and matches SoapUI's: property expansion, inline-file substitution
 * ({@link substituteInlineFiles}) and the envelope transforms have already happened, then
 * MTOM claims the attachments its `cid:` references name, then everything left over rides
 * along as SwA. Only when something is actually packaged is the `Content-Type` replaced by
 * the multipart's — the caller's own content type (charset and all) becomes the root part's,
 * so a request that sets one still gets what it asked for where it matters.
 *
 * "Disable Multiparts" short-circuits the whole stage, MTOM included: rewriting a `cid:`
 * reference into an `xop:Include` whose part is then not sent would produce a message no
 * server can read.
 *
 * @param input the (already expanded, already inlined) send input
 * @param headers the request headers, mutated when a multipart Content-Type takes over
 */
export async function packageRequestBody(input: SoapSendInput, headers: Record<string, string>): Promise<Uint8Array> {
  const options = input.attachmentOptions;
  if (options === undefined) {
    return encodeBody(input.envelopeXml, input.encoding);
  }

  // Inline files were already substituted, before the envelope transforms — see
  // {@link substituteInlineFiles} and the pipeline order in `send.ts`.
  let envelopeXml = input.envelopeXml;

  const attachments = input.attachments ?? [];
  const parts: MultipartPart[] = [];
  let mtom = false;
  if (!options.disableMultiparts) {
    let remaining = attachments;
    if (options.enableMtom || options.forceMtom) {
      const prepared = await prepareMtomRequest(envelopeXml, attachments, {
        force: options.forceMtom,
        resolver: options.resolver,
      });
      envelopeXml = prepared.envelopeXml;
      parts.push(...prepared.parts);
      mtom = prepared.used;
      remaining = attachments.filter((attachment) => !prepared.consumedIds.includes(attachment.id));
    }
    const swa = await prepareSwaRequest(envelopeXml, remaining, {
      resolver: options.resolver,
      encodeAttachments: options.encodeAttachments,
    });
    parts.push(...swa.parts);
  }

  const encoded = encodeBody(envelopeXml, input.encoding);
  if (parts.length === 0 && !mtom) {
    return encoded;
  }
  const soapContentType = headerValue(headers, 'content-type') ?? 'text/xml;charset=UTF-8';
  const built = buildMultipartRelated({
    root: {
      contentType: mtom ? xopContentType(soapContentType) : soapContentType,
      contentId: DEFAULT_ROOT_CONTENT_ID,
      bytes: encoded,
    },
    parts,
    ...(mtom ? { mtom: true } : {}),
  });
  setHeader(headers, 'content-type', built.contentType);
  return built.body;
}

/**
 * Reads the response body as an envelope, unwrapping a `multipart/related` response into
 * its root part plus attachments.
 *
 * A response is unwrapped whether or not the request asked for attachments — a server may
 * answer with MTOM regardless — but the two SoapUI knobs only apply when the request
 * carried them: `expandMtomAttachments` writes each referenced part back into the envelope
 * as base64, and `inlineResponseAttachments` decides whether those parts stay listed
 * afterwards.
 */
export function readResponseBody(
  body: Uint8Array,
  contentType: string | undefined,
  options: SoapSendInput['attachmentOptions'],
  problems: SoapProblem[],
): { readonly envelopeXml: string; readonly attachments?: readonly ResponseAttachment[] } {
  const isMultipart = contentType !== undefined && mediaTypeOf(contentType).toLowerCase().startsWith('multipart/');
  if (!isMultipart) {
    const decoded = decodeBody(body, contentType);
    if (decoded.problem !== undefined) {
      problems.push(decoded.problem);
    }
    return { envelopeXml: decoded.text };
  }

  const parsed = parseMultipartRelated(body, contentType);
  for (const problem of parsed.problems) {
    problems.push({ code: 'mime-parse', message: `Response multipart: ${problem}` });
  }
  // A root part with no Content-Type of its own still inherits the multipart's charset.
  const decoded = decodeBody(parsed.root.bytes, parsed.root.headers['content-type'] ?? contentType);
  if (decoded.problem !== undefined) {
    problems.push(decoded.problem);
  }
  const expanded = expandMtomResponse(parsed, {
    inline: options?.expandMtomAttachments === true,
    envelopeXml: decoded.text,
  });
  const attachments =
    options?.inlineResponseAttachments === true
      ? expanded.attachments
      : expanded.attachments.filter((attachment) => !expanded.inlinedContentIds.includes(attachment.contentId));
  return { envelopeXml: expanded.envelopeXml, attachments };
}
