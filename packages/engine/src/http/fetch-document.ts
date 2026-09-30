/**
 * Fetching one document by its location: what a fetcher is, and the default one.
 *
 * In `http/` because the WSDL, OpenAPI and AsyncAPI imports all take a {@link FetchDocument}, and a
 * protocol folder imports core and itself, never another protocol (protocol modules spec §7.2).
 * `wsdl/resolver.ts` re-exports the two types.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../errors.js';
import { decodeXmlBytes } from '../xml/decode.js';

/** A fetched document's canonical location (post-redirect) and raw content. */
export interface FetchedDocument {
  /** The final absolute location after following any redirects. */
  readonly location: string;
  readonly bytes: Uint8Array;
  readonly text: string;
}

/** Fetches a single document by absolute location, honouring an optional abort signal. */
export type FetchDocument = (location: string, signal?: AbortSignal) => Promise<FetchedDocument>;

const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT = 'wirebench/0.1';

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
