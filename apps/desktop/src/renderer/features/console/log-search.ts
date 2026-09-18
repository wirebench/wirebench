/**
 * The HTTP Log's text search: what a row can be found by (URL, request and response header lines,
 * the first 256 KiB of each body, the request name) and how the query is compiled (substring or
 * regular expression, with or without case). Pure apart from a small decode cache; the request-name
 * resolver is passed in, so nothing here reads a store.
 */
import type { LogEntry, LogFilter } from '../../state/exchanges.js';
import { urlOf } from './log-filter.js';

/** How much of each body is decoded and searched. */
export const SEARCH_BODY_CAP = 256 * 1024;
/** The HTTP Log's largest row count; the cache never needs to hold more rows than that. */
const CACHE_CAP = 5000;

export type TextMatcher = ((haystack: string) => boolean) & { readonly invalid?: true };

/** Compiles the filter's text; an invalid regex yields a matcher flagged `invalid`. */
export function compileMatcher(filter: Pick<LogFilter, 'text' | 'regex' | 'matchCase'>): TextMatcher {
  if (filter.regex) {
    try {
      const pattern = new RegExp(filter.text, filter.matchCase ? '' : 'i');
      return (haystack: string) => pattern.test(haystack);
    } catch {
      return Object.assign(() => false, { invalid: true as const });
    }
  }
  if (filter.matchCase) {
    return (haystack: string) => haystack.includes(filter.text);
  }
  const needle = filter.text.toLowerCase();
  return (haystack: string) => haystack.toLowerCase().includes(needle);
}

const decoder = new TextDecoder('utf-8');

function decodeCapped(base64: string | undefined): string {
  if (base64 === undefined || base64 === '') {
    return '';
  }
  // Only the leading slice is decoded: 4 base64 characters carry 3 bytes.
  const slice = base64.slice(0, Math.ceil(SEARCH_BODY_CAP / 3) * 4);
  const binary = atob(slice);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return decoder.decode(bytes.subarray(0, SEARCH_BODY_CAP));
}

function headerLines(headers: Readonly<Record<string, string>> | undefined): string[] {
  return headers === undefined ? [] : Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
}

const cache = new Map<string, readonly string[]>();

function cacheKey(entry: LogEntry): string {
  return entry.kind === 'exchange'
    ? `${entry.exchange.sendId}:${entry.exchange.http.bodyBase64.length}`
    : `${entry.failure.sendId}:${entry.failure.rawRequestBase64?.length ?? 0}`;
}

/** The searchable text of one row (URL, header lines, first 256 KiB of each body), cached by sendId. */
export function searchTextOf(entry: LogEntry): readonly string[] {
  const key = cacheKey(entry);
  const hit = cache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const texts =
    entry.kind === 'exchange'
      ? [
          urlOf(entry),
          ...headerLines(entry.exchange.http.request.headers),
          ...headerLines(entry.exchange.http.headers),
          decodeCapped(entry.exchange.http.rawRequestBase64),
          decodeCapped(entry.exchange.http.bodyBase64),
        ]
      : [urlOf(entry), ...headerLines(entry.failure.request.headers), decodeCapped(entry.failure.rawRequestBase64)];
  cache.set(key, texts);
  if (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  return texts;
}

export function clearSearchCache(): void {
  cache.clear();
}

export function matchesText(entry: LogEntry, matcher: TextMatcher, name: string | undefined): boolean {
  return searchTextOf(entry).some((text) => matcher(text)) || (name !== undefined && matcher(name));
}
