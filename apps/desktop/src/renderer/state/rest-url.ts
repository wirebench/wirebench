/**
 * The renderer's view of a REST request's URL: how it reads, and what it would resolve to.
 *
 * Splitting, rejoining and finding `{param}` placeholders all come from the engine
 * (`@wirebench/engine/rest`) rather than being written again here, so the query table and the URL
 * field can never disagree with what the send path actually builds.
 */
import { joinQuery, parseUrlParams, splitQuery } from '@wirebench/engine/rest';
import type { KeyValueWire } from '../../shared/wire-types.js';

/** One run of a URL, tagged with what it is, for the highlighted mirror behind the field. */
export interface UrlSegment {
  readonly text: string;
  /** `property` is `${…}`, `param` is `{name}`, `plain` is everything else. */
  readonly kind: 'plain' | 'property' | 'param';
}

/**
 * A property reference, `{param}`, or neither. `${…}` is matched first and greedily enough to keep
 * a scoped reference (`${#Env#base}`) in one piece; a `{param}` never contains `$`, `{` or `}`.
 */
const TOKEN = /\$\{[^}]*\}|\{[^{}$]*\}/g;

/** Splits a URL into runs so the field can highlight its property references and placeholders. */
export function urlSegments(url: string): readonly UrlSegment[] {
  const segments: UrlSegment[] = [];
  let at = 0;
  for (const match of url.matchAll(TOKEN)) {
    const start = match.index;
    if (start > at) {
      segments.push({ text: url.slice(at, start), kind: 'plain' });
    }
    segments.push({ text: match[0], kind: match[0].startsWith('${') ? 'property' : 'param' });
    at = start + match[0].length;
  }
  if (at < url.length) {
    segments.push({ text: url.slice(at), kind: 'plain' });
  }
  return segments;
}

/** Whether a URL is absolute, and so ignores the API's base URL. */
export function isAbsoluteUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
}

/**
 * The path parameter rows a URL implies, keeping the value already typed for a name that is still
 * there. A `{param}` removed from the URL takes its row with it — the row cannot be sent anywhere —
 * and the rows come back in the order the URL names them.
 */
export function syncPathParams(url: string, rows: readonly KeyValueWire[]): readonly KeyValueWire[] {
  const byName = new Map(rows.map((row) => [row.name, row]));
  return parseUrlParams(url).map((name) => byName.get(name) ?? { name, value: '', enabled: true });
}

/** The query table a URL implies. Ordered as the URL writes them, duplicates kept. */
export function queryFromUrl(url: string): readonly KeyValueWire[] {
  return splitQuery(url).query.map((entry) => ({ ...entry }));
}

/** The path half of a URL, with its query string removed. */
export function pathFromUrl(url: string): string {
  return splitQuery(url).path;
}

/**
 * The URL that carries `query`, keeping the path as it is.
 *
 * Only the *enabled* rows reach the URL, because the URL is what is sent: a row switched off would
 * otherwise come back the moment the field re-parsed itself. A switched-off row therefore lives in
 * the table only, which is why the table — not the URL — is the request's stored query.
 */
export function urlWithQuery(url: string, query: readonly KeyValueWire[]): string {
  // The engine's entry carries no optional `description`, so the rows are narrowed rather than
  // passed straight through: the URL has no room for a description anyway.
  const entries = query
    .filter((row) => row.enabled)
    .map((row) => ({ name: row.name, value: row.value, enabled: row.enabled }));
  return joinQuery(splitQuery(url).path, entries);
}
