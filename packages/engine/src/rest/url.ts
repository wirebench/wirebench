/**
 * Building the URL a REST request actually sends, and taking one apart again.
 *
 * Two jobs, both pure. {@link composeUrl} joins the API's base URL with the request's own URL,
 * fills its `{name}` path parameters and appends its enabled query rows, percent-encoding to
 * RFC 3986. {@link splitQuery} and {@link joinQuery} are the other direction: the editor keeps one
 * URL field and one query table, and they have to be the same thing seen twice, so a value typed
 * into either lands in the other without drifting.
 *
 * Nothing here throws for bad input. A missing path parameter or a property reference nothing
 * expanded is a {@link UrlProblem} the caller surfaces before the send — a URL that is merely
 * unfinished is the normal state of a request being written.
 */

import type { KeyValueEntry } from './model.js';

/** Something wrong with a URL that must stop the send rather than reach the wire. */
export interface UrlProblem {
  readonly code:
    /** A `{name}` in the URL with no value in the request's path-parameter table. */
    | 'missing-path-param'
    /** A `${…}` property reference the caller did not expand. */
    | 'unexpanded-property'
    /** Neither the request's URL nor the base URL gives a scheme and host. */
    | 'no-host';
  /** The parameter or reference the problem is about. */
  readonly name: string;
}

/** The result of {@link composeUrl}: the URL to send, and anything that must stop the send. */
export interface ComposedUrl {
  readonly url: string;
  readonly problems: readonly UrlProblem[];
}

/** Options for {@link composeUrl}. */
export interface ComposeUrlOptions {
  /**
   * Percent-encode path-parameter and query values. On by default. Off sends them exactly as
   * typed, which is what a request that has to pass a pre-encoded or deliberately odd value needs.
   */
  readonly encode?: boolean;
}

/** Characters RFC 3986 §2.3 calls unreserved, plus the sub-delims a value may keep. */
const UNRESERVED = /[A-Za-z0-9\-._~]/;

/** A `%XX` sequence that is already a valid escape, so encoding it again would double it. */
const VALID_ESCAPE = /^%[0-9A-Fa-f]{2}/;

/**
 * Percent-encodes one value, leaving an existing valid `%XX` escape alone.
 *
 * The double-encoding guard is the whole point: a user who pastes `a%20b` means one space, and
 * turning it into `a%2520b` would silently change the request. A lone `%` that is not a valid
 * escape *is* encoded, because on the wire it has to be.
 */
export function encodeValue(value: string, extraSafe = ''): string {
  let out = '';
  for (let i = 0; i < value.length;) {
    const char = value[i]!;
    if (char === '%' && VALID_ESCAPE.test(value.slice(i, i + 3))) {
      out += value.slice(i, i + 3);
      i += 3;
      continue;
    }
    out += UNRESERVED.test(char) || extraSafe.includes(char) ? char : percentEncode(char, value, i);
    i += char === '%' ? 1 : charLength(value, i);
  }
  return out;
}

/** How many UTF-16 code units the character at `index` occupies (a surrogate pair counts as two). */
function charLength(value: string, index: number): number {
  const code = value.codePointAt(index);
  return code !== undefined && code > 0xffff ? 2 : 1;
}

/** The `%XX` (or multi-byte `%XX%XX…`) escape for the character at `index`. */
function percentEncode(char: string, value: string, index: number): string {
  const length = charLength(value, index);
  return encodeURIComponent(value.slice(index, index + length)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Every `{name}` in `url`, in the order they appear, without duplicates. */
export function parseUrlParams(url: string): string[] {
  const names: string[] = [];
  for (const match of url.matchAll(/\{([^{}/?#]+)\}/g)) {
    const name = match[1]!;
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Every `${…}` reference left in `text`, which means the caller did not expand it.
 *
 * An `indexOf` walk rather than `/\$\{([^}]*)\}/g`: with an unclosed `${` the regex rescans to
 * the end of the string from every later start, which is O(n²) on pathological input. This finds
 * each `${`, then the next `}`; if there is none, nothing after it can match either, so it stops.
 */
function unexpandedProperties(text: string): string[] {
  const names: string[] = [];
  let from = 0;
  for (;;) {
    const open = text.indexOf('${', from);
    if (open === -1) {
      return names;
    }
    const close = text.indexOf('}', open + 2);
    if (close === -1) {
      return names;
    }
    names.push(text.slice(open + 2, close));
    from = close + 1;
  }
}

/**
 * Drops every trailing `/` from `text`.
 *
 * A character walk rather than `replace(/\/+$/, '')`: that pattern is anchored at the end but not
 * at the start, so the engine retries it at each of the string's positions and the whole trim costs
 * O(n²) — 80k slashes took five seconds. Nothing here is attacker-supplied (it is the user's own
 * base URL), so this is a sharp edge rather than a vulnerability, but linear is free.
 */
export function trimTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x2f) {
    end -= 1;
  }
  return text.slice(0, end);
}

/** True when `url` already carries its own scheme, so the base URL plays no part. */
function isAbsolute(url: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url);
}

/**
 * Joins a base URL with a request's relative URL.
 *
 * The base's own path is kept (`https://h/api/v3` + `/pet` is `https://h/api/v3/pet`), because an
 * API's base URL usually *is* a path prefix; exactly one `/` ends up between the two however many
 * either side brought. An empty relative URL sends the base itself.
 */
export function joinBase(base: string, url: string): string {
  if (isAbsolute(url)) {
    return url;
  }
  const trimmedBase = trimTrailingSlashes(base);
  if (url === '') {
    return trimmedBase;
  }
  const relative = url.replace(/^\/+/, '');
  return trimmedBase === '' ? `/${relative}` : `${trimmedBase}/${relative}`;
}

/** Splits `url` into its part before `?`/`#` and the query rows after it. */
export function splitQuery(url: string): { readonly path: string; readonly query: KeyValueEntry[] } {
  const hash = url.indexOf('#');
  const fragment = hash === -1 ? '' : url.slice(hash);
  const withoutFragment = hash === -1 ? url : url.slice(0, hash);
  const mark = withoutFragment.indexOf('?');
  if (mark === -1) {
    return { path: url, query: [] };
  }
  const path = withoutFragment.slice(0, mark) + fragment;
  const search = withoutFragment.slice(mark + 1);
  const query = search
    .split('&')
    .filter((pair) => pair.length > 0)
    .map((pair) => {
      const equals = pair.indexOf('=');
      const name = equals === -1 ? pair : pair.slice(0, equals);
      const value = equals === -1 ? '' : pair.slice(equals + 1);
      return { name, value, enabled: true };
    });
  return { path, query };
}

/**
 * The inverse of {@link splitQuery}: puts enabled rows back onto `path` as its query string.
 *
 * Values are written exactly as given — this is the editor's URL field, not the wire — so
 * `joinQuery(splitQuery(url))` returns `url` for any URL the editor could have produced.
 */
export function joinQuery(path: string, query: readonly KeyValueEntry[]): string {
  const hash = path.indexOf('#');
  const base = hash === -1 ? path : path.slice(0, hash);
  const fragment = hash === -1 ? '' : path.slice(hash);
  const search = query
    .filter((row) => row.enabled)
    .map((row) => (row.value === '' ? row.name : `${row.name}=${row.value}`))
    .join('&');
  return search === '' ? base + fragment : `${base}?${search}${fragment}`;
}

/**
 * Builds the URL one send actually uses.
 *
 * Order of work: the request's URL wins over the base when it is absolute; `{name}` parameters are
 * filled from the enabled rows of `pathParams`; the query is the enabled `query` rows, preceded by
 * any parameter of the URL's own query string that no enabled row carries; every value is encoded
 * unless `encode` is off.
 *
 * The table owns the query. The editor mirrors it into the URL field, so a saved request usually
 * holds each parameter twice — once in `url`, once as a row — and sending both would send it twice.
 * A URL parameter with the same name and value as an enabled row is that row, matched one for one
 * so deliberate duplicates survive. One no row carries (a hand-written file, a URL with no table)
 * is still sent, ahead of the rows, as it is written.
 *
 * @param base the API's effective base URL, already expanded
 * @param url the request's URL, already expanded
 * @param pathParams values for the URL's `{name}` placeholders
 * @param query query rows, the request's stored query
 */
export function composeUrl(
  base: string,
  url: string,
  pathParams: readonly KeyValueEntry[] = [],
  query: readonly KeyValueEntry[] = [],
  options: ComposeUrlOptions = {},
): ComposedUrl {
  const encode = options.encode ?? true;
  const problems: UrlProblem[] = [];

  const joined = joinBase(base, url);
  const { path, query: inlineQuery } = splitQuery(joined);

  const values = new Map<string, string>();
  for (const row of pathParams) {
    if (row.enabled) {
      values.set(row.name, row.value);
    }
  }

  const filled = path.replace(/\{([^{}/?#]+)\}/g, (whole, name: string) => {
    const value = values.get(name);
    if (value === undefined || value === '') {
      problems.push({ code: 'missing-path-param', name });
      return whole;
    }
    // A path segment keeps sub-delims but never a `/`: a value containing one would invent a
    // segment the request did not ask for.
    return encode ? encodeValue(value, "!$&'()*+,;=:@") : value;
  });

  const rows = [...unclaimed(inlineQuery, query), ...query.filter((row) => row.enabled)];
  const search = rows
    .map((row) => {
      const name = encode ? encodeValue(row.name, '') : row.name;
      const value = encode ? encodeValue(row.value, '') : row.value;
      return value === '' ? name : `${name}=${value}`;
    })
    .join('&');

  const composed = search === '' ? filled : appendSearch(filled, search);

  for (const name of unexpandedProperties(composed)) {
    problems.push({ code: 'unexpanded-property', name });
  }
  if (!isAbsolute(composed)) {
    problems.push({ code: 'no-host', name: composed });
  }

  return { url: composed, problems };
}

/**
 * The rows of `inline` that no enabled row of `table` accounts for, in order. Each table row claims
 * at most one inline row with its name and value, so `?t=a&t=a` against two `t=a` rows is fully
 * claimed and against one leaves one.
 */
function unclaimed(inline: readonly KeyValueEntry[], table: readonly KeyValueEntry[]): KeyValueEntry[] {
  const available = new Map<string, number>();
  for (const row of table) {
    if (row.enabled) {
      const key = queryKey(row);
      available.set(key, (available.get(key) ?? 0) + 1);
    }
  }
  return inline.filter((row) => {
    const key = queryKey(row);
    const left = available.get(key) ?? 0;
    if (left === 0) {
      return true;
    }
    available.set(key, left - 1);
    return false;
  });
}

/** One key per name and value; `=` cannot end a name, so the join is unambiguous. */
function queryKey(row: KeyValueEntry): string {
  return `${row.name}=${row.value}`;
}

/** Appends a query string to a URL that may already carry a fragment. */
function appendSearch(url: string, search: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? `${url}?${search}` : `${url.slice(0, hash)}?${search}${url.slice(hash)}`;
}
