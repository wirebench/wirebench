import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../errors.js';
import type { FetchDocument, FetchedDocument } from './resolver.js';

const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT = 'wirebench/0.1';

/**
 * Decodes bytes as UTF-8, honouring an `<?xml ... encoding="iso-8859-1" ?>`
 * declaration when present (single-byte, so it is safely sniffable by
 * decoding the head as UTF-8 first). A `utf-16` declaration would require a
 * BOM/byte-order sniff before the declaration itself is even legible, which
 * does not fit a small helper like this — such documents fall back to (and
 * garble under) UTF-8; use a pre-fetched `text` in that case instead.
 */
export function decodeXmlBytes(bytes: Uint8Array): string {
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 200));
  const match = /^\s*<\?xml[^>]*\bencoding=["']([^"']+)["']/i.exec(head);
  if (match?.[1]?.toLowerCase() === 'iso-8859-1') {
    return new TextDecoder('iso-8859-1').decode(bytes);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

async function fetchFile(location: string): Promise<FetchedDocument> {
  const bytes = await readFile(fileURLToPath(location));
  return { location, bytes: new Uint8Array(bytes), text: decodeXmlBytes(bytes) };
}

async function fetchHttp(location: string, signal: AbortSignal | undefined): Promise<FetchedDocument> {
  const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const combinedSignal = signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(location, {
    redirect: 'follow',
    signal: combinedSignal,
    headers: { 'user-agent': USER_AGENT },
  });
  if (!response.ok) {
    throw new HttpError('fetch-failed', `GET ${location} failed with status ${response.status}`, {
      details: { location, status: response.status },
    });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { location: response.url, bytes, text: decodeXmlBytes(bytes) };
}

/**
 * Creates the default {@link FetchDocument} implementation: `file:` URLs are
 * read from disk via `node:fs/promises`, and `http(s):` URLs are fetched via
 * the global `fetch` (following redirects, with a 20s timeout combined with
 * the caller's `AbortSignal`, and a `wirebench/0.1` User-Agent).
 *
 * Text is decoded as UTF-8 by default, honouring an `iso-8859-1` `encoding`
 * in the document's XML declaration when present (see {@link decodeXmlBytes}
 * for why `utf-16` isn't sniffed the same way). Other declared encodings
 * fall back to UTF-8.
 */
export function createDefaultFetchDocument(): FetchDocument {
  return async (location: string, signal?: AbortSignal): Promise<FetchedDocument> => {
    if (location.startsWith('file:')) {
      return fetchFile(location);
    }
    return fetchHttp(location, signal);
  };
}
