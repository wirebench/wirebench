/**
 * The redaction a recorded response gets before it is kept as a request example (spec §3.7): the
 * cookie headers are dropped, credential-looking headers are masked, and the values under
 * credential-looking keys of a JSON or form body, and under credential-looking elements and
 * attributes of an XML body, are masked. Shared by every importer that keeps examples. Pure, and
 * free of Node.
 */

import type { KeyValueEntry } from '../http/entries.js';
import { entry } from '../http/entries.js';
import { REDACTED_MARKER, REDACTED_XML_MARKER, redactStructuredBody } from '../redact/index.js';
import { scanXml } from './credential-values.js';
import { isCredentialName } from './credentials.js';

/** An example body's cap, in characters: the one History puts on a recorded body. */
export const MAX_EXAMPLE_BODY_CHARS = 256 * 1024;

/** Response headers an example never keeps: the cookie jar, not the example, owns cookies. */
const DROPPED_EXAMPLE_HEADERS = new Set(['set-cookie', 'cookie']);
const ENCODED_MARKER = encodeURIComponent(REDACTED_MARKER);

/** True when a body is XML: its content type says so, or it names none and opens with `<`. */
function isXmlBody(text: string, contentType: string | undefined): boolean {
  if (contentType === undefined) return text.trimStart().startsWith('<');
  return contentType.toLowerCase().includes('xml');
}

function markers(text: string): number {
  return text.split(REDACTED_MARKER).length + text.split(ENCODED_MARKER).length - 2;
}

/** A recorded response's headers and body as an example may keep them; `masked` says whether anything was. */
export function maskRecordedResponse(
  headers: readonly { readonly name: string; readonly value: string }[],
  body: string | undefined,
  contentType: string | undefined,
): { headers: KeyValueEntry[]; body?: string; masked: boolean } {
  let masked = false;
  const kept = headers
    .filter((h) => !DROPPED_EXAMPLE_HEADERS.has(h.name.toLowerCase()))
    .map((h) => {
      if (!isCredentialName(h.name)) return entry(h.name, h.value);
      masked = true;
      return entry(h.name, REDACTED_MARKER);
    });
  let text = body;
  if (text !== undefined && isXmlBody(text, contentType)) {
    const redacted = scanXml(text, () => REDACTED_XML_MARKER);
    if (redacted !== text) {
      text = redacted;
      masked = true;
    }
  } else if (text !== undefined) {
    const redacted = redactStructuredBody(text, contentType, { isSecretKey: isCredentialName });
    // Re-serialising may reformat JSON, so the redacted text replaces the body only when it masked something.
    if (markers(redacted) > markers(text)) {
      text = redacted;
      masked = true;
    }
  }
  return { headers: kept, ...(text !== undefined ? { body: text } : {}), masked };
}
