/**
 * Turning a SOAP envelope into wire bytes and back, per the request's encoding and the
 * response's declared charset.
 */

import { WirebenchError } from '../errors.js';

/** The charset declared in a `Content-Type` header value, if any. */
export function charsetOf(contentType: string | undefined): string | undefined {
  const match = contentType !== undefined ? /charset=([^;]+)/i.exec(contentType) : null;
  return match?.[1]?.trim().replace(/^"|"$/g, '');
}

/**
 * Encodes `text` for the wire, per `encoding` (default utf-8).
 *
 * `ISO-8859-1` is a valid encoding label (SoapUI offers it, and it is what the Encoding
 * property's `<select>` shows), but it is not one of the labels Node's `Buffer` recognises —
 * `iso-8859-1` is instead spelled `latin1` there. That is the one label this function
 * translates; every other name is handed to `Buffer` as-is.
 */
export function encodeBody(text: string, encoding: string | undefined): Uint8Array {
  const normalized = (encoding ?? 'utf-8').toLowerCase();
  if (normalized === 'utf-8' || normalized === 'utf8') {
    return new TextEncoder().encode(text);
  }
  const bufferEncoding = normalized === 'iso-8859-1' ? 'latin1' : normalized;
  if (Buffer.isEncoding(bufferEncoding)) {
    return new Uint8Array(Buffer.from(text, bufferEncoding));
  }
  throw new WirebenchError('unsupported-encoding', `Unsupported request encoding "${encoding}"`, {
    details: { encoding },
  });
}

/** Decodes a response body per its `Content-Type` charset (default UTF-8), falling back to UTF-8 with a `decode-error` problem when the charset label is unsupported or the bytes are invalid for it. */
export function decodeBody(
  body: Uint8Array,
  contentType: string | undefined,
): { text: string; problem?: { readonly code: 'decode-error'; readonly message: string } } {
  const label = charsetOf(contentType) ?? 'utf-8';
  try {
    return { text: new TextDecoder(label, { fatal: false }).decode(body) };
  } catch {
    return {
      text: new TextDecoder('utf-8', { fatal: false }).decode(body),
      problem: {
        code: 'decode-error',
        message: `Response charset "${label}" is not supported; decoded as UTF-8 instead`,
      },
    };
  }
}
