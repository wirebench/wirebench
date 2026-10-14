/**
 * Reading a lint finding's JSON Pointer as a place in the API (#561): `/paths/~1json/get/responses/200/content/application~1json`
 * becomes `GET /json › 200 › application/json`. Pure, so the Problems view and its tests share it.
 */

const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace', 'query']);

/** Container keys that only say what kind of child comes next: the child names the place well enough. */
const STRUCTURAL = new Set(['responses', 'content', 'properties', 'schemas', 'headers', 'examples']);

/** Plain words for the camel-cased keys that do read as a place; every other key reads as itself. */
const WORDS: ReadonlyMap<string, string> = new Map([
  ['requestBody', 'request body'],
  ['securitySchemes', 'security schemes'],
  ['operationId', 'operation id'],
]);

/** A JSON Pointer's segments, unescaped (`~1` is `/`, `~0` is `~`); none for the root. */
export function pointerSegments(pointer: string): string[] {
  if (pointer === '' || pointer === '/') {
    return [];
  }
  return pointer
    .replace(/^#/, '')
    .split('/')
    .slice(1)
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** The operation a pointer sits in — its upper-case method and templated path — if it is under one. */
export function lintOperation(pointer: string): { readonly method: string; readonly path: string } | undefined {
  const [root, path, method] = pointerSegments(pointer);
  if (root !== 'paths' || path === undefined || method === undefined || !METHODS.has(method)) {
    return undefined;
  }
  return { method: method.toUpperCase(), path };
}

/** A readable place for a lint finding's pointer: `GET /json › 200 › application/json`, or `document` for the root. */
export function lintLocationLabel(pointer: string): string {
  const segments = pointerSegments(pointer);
  if (segments.length === 0) {
    return 'document';
  }
  const parts: string[] = [];
  let rest = segments;
  if (segments[0] === 'paths' && segments[1] !== undefined) {
    const method = segments[2];
    if (method !== undefined && METHODS.has(method)) {
      parts.push(`${method.toUpperCase()} ${segments[1]}`);
      rest = segments.slice(3);
    } else {
      parts.push(segments[1]);
      rest = segments.slice(2);
    }
  }
  rest.forEach((segment, index) => {
    // A container key is dropped when something follows it, which names the place better.
    if (STRUCTURAL.has(segment) && index < rest.length - 1) {
      return;
    }
    // An array index reads as a 1-based position after its list (`parameters › 2`).
    const isIndex = /^\d+$/.test(segment) && rest[index - 1] !== 'responses';
    parts.push(isIndex ? String(Number(segment) + 1) : (WORDS.get(segment) ?? segment));
  });
  return parts.join(' › ');
}
