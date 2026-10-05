/**
 * The redaction a recorded response gets before it is kept as a request example (spec §3.7): the
 * cookie headers are dropped, credential-looking headers are masked, and the values under
 * credential-looking keys of a JSON or form body are masked. Shared by every importer that keeps
 * examples. Pure, and free of Node.
 */

import type { KeyValueEntry } from '../http/entries.js';
import { entry } from '../http/entries.js';
import { REDACTED_MARKER, redactStructuredBody } from '../redact/index.js';
import { isCredentialName } from './credentials.js';

/** An example body's cap, in characters: the one History puts on a recorded body. */
export const MAX_EXAMPLE_BODY_CHARS = 256 * 1024;

const DROPPED_EXAMPLE_HEADERS = new Set(['set-cookie', 'cookie']);
const ENCODED_MARKER = encodeURIComponent(REDACTED_MARKER);

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
  if (text !== undefined) {
    const redacted = redactStructuredBody(text, contentType, { isSecretKey: isCredentialName });
    // Re-serialising may reformat JSON, so the redacted text replaces the body only when it masked something.
    if (markers(redacted) > markers(text)) {
      text = redacted;
      masked = true;
    }
  }
  return { headers: kept, ...(text !== undefined ? { body: text } : {}), masked };
}
