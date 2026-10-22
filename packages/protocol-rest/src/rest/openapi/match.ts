/**
 * Finding the operation of a definition a request calls, from its method and URL alone.
 *
 * Variables cannot be expanded here, so a `{{…}}` or `${…}` in the URL is opaque: at the start it
 * stands for a base URL, and as a whole segment it matches any segment, as a `{param}` does. Pure,
 * so the importer, the editor and the tests share it.
 */

/** An operation as the definition names it: the lower-case method and the templated path. */
export interface RestOperationRef {
  readonly method: string;
  readonly path: string;
}

const VARIABLE = /^(?:\{\{[^}]*\}\}|\$\{[^}]*\}|\{[^}]*\})$/;
const LEADING_VARIABLE = /^(?:\{\{[^}]*\}\}|\$\{[^}]*\})/;
const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;

function withoutQuery(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/** `value` without trailing slashes; a loop, since `/\/+$/` backtracks on a long run of them. */
function trimSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* '/' */) {
    end -= 1;
  }
  return value.slice(0, end);
}

/** The URL's path relative to the API: the longest matching base URL, a leading variable, or the origin gone. */
function relativePath(url: string, baseUrls: readonly string[]): string {
  const bases = baseUrls
    .map((base) => trimSlash(withoutQuery(base.trim())))
    .filter((base) => base.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const base of bases) {
    if (url === base || url.startsWith(`${base}/`)) {
      return url.slice(base.length);
    }
  }
  const variable = LEADING_VARIABLE.exec(url);
  if (variable !== null) {
    return url.slice(variable[0].length);
  }
  const origin = ORIGIN.exec(url);
  const path = origin === null ? url : url.slice(origin[0].length);
  // No base matched whole, as when the URL is sent to another host (staging, a mock) than the
  // servers name: a base's own path prefix (`/v1`) is still not part of the operation's path.
  const prefixes = bases
    .map((base) => basePath(base))
    .filter((prefix) => prefix.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      return path.slice(prefix.length);
    }
  }
  return path;
}

/** A base URL's path after its origin, or after a leading variable standing for one (`{scheme}://…` stays opaque). */
function basePath(base: string): string {
  const origin = ORIGIN.exec(base) ?? LEADING_VARIABLE.exec(base);
  if (origin !== null) return trimSlash(base.slice(origin[0].length));
  return base.startsWith('/') ? trimSlash(base) : '';
}

function segments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** How many of `declared`'s segments are literal when it matches `actual`, or -1 when it does not. */
function literalMatch(declared: readonly string[], actual: readonly string[]): number {
  if (declared.length !== actual.length) {
    return -1;
  }
  let literals = 0;
  for (const [index, segment] of declared.entries()) {
    const other = actual[index] as string;
    if (VARIABLE.test(segment) || VARIABLE.test(other)) {
      continue;
    }
    if (decoded(segment) !== decoded(other)) {
      return -1;
    }
    literals += 1;
  }
  return literals;
}

/**
 * The one operation `method` and `url` call. As in OpenAPI, a concrete path wins over a templated
 * one: of several matches, the one with the most literal segments; `undefined` on a tie or no match.
 * A URL whose host matches no server still matches by path, once its origin is dropped and, if it
 * starts with one, a server's own path prefix.
 * `baseUrls` are the API's servers and base URL; the longest one the URL starts with is stripped.
 */
export function matchOperation(
  operations: readonly RestOperationRef[],
  method: string,
  url: string,
  baseUrls: readonly string[],
): RestOperationRef | undefined {
  const actual = segments(withoutQuery(relativePath(url.trim(), baseUrls)));
  const wanted = method.toLowerCase();
  let best: RestOperationRef | undefined;
  let bestLiterals = -1;
  let tied = false;
  for (const operation of operations) {
    if (operation.method.toLowerCase() !== wanted) {
      continue;
    }
    const literals = literalMatch(segments(operation.path), actual);
    if (literals > bestLiterals) {
      best = operation;
      bestLiterals = literals;
      tied = false;
    } else if (literals >= 0 && literals === bestLiterals) {
      tied = true;
    }
  }
  return best === undefined || tied ? undefined : { method: best.method, path: best.path };
}
