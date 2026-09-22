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

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
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
  return origin === null ? url : url.slice(origin[0].length);
}

function segments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function segmentsMatch(declared: readonly string[], actual: readonly string[]): boolean {
  return (
    declared.length === actual.length &&
    declared.every((segment, index) => {
      const other = actual[index] as string;
      return segment === other || VARIABLE.test(segment) || VARIABLE.test(other);
    })
  );
}

/**
 * The one operation `method` and `url` call, or `undefined` when none does or more than one could.
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
  const found = operations.filter(
    (operation) => operation.method.toLowerCase() === wanted && segmentsMatch(segments(operation.path), actual),
  );
  const only = found.length === 1 ? found[0] : undefined;
  return only === undefined ? undefined : { method: only.method, path: only.path };
}
