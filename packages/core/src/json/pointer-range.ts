/**
 * Where a JSON Pointer's value sits in a JSON text, so a problem found on the parsed value can be
 * marked in the text the user sees — pretty-printed or exactly as received.
 *
 * One forward scan: at each container it walks every member, descending into the ones on the
 * pointer's path and skipping the rest, so no character is read twice. A scalar is located as its whole token; an object or array
 * as its opening bracket only, which is also where a missing required property belongs (the
 * validator reports that at the parent). Pure and dependency-free, so the renderer can use it.
 */

/** A 1-based range, Monaco style: `endColumn` is one past the last character. */
export interface PointerTextRange {
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

function skipWs(text: string, i: number): number {
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) break;
    i++;
  }
  return i;
}

/** Index just past the string that opens at `i`, or -1 when it never closes. */
function endOfString(text: string, i: number): number {
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') j++;
    else if (c === '"') return j + 1;
  }
  return -1;
}

/** Index just past the value starting at `i` (whitespace already skipped), or -1. */
function endOfValue(text: string, i: number): number {
  const c = text[i];
  if (c === '"') return endOfString(text, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const d = text[j];
      if (d === '"') {
        const end = endOfString(text, j);
        if (end < 0) return -1;
        j = end - 1;
      } else if (d === '{' || d === '[') depth++;
      else if (d === '}' || d === ']') {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
    return -1;
  }
  let j = i;
  while (j < text.length && !/[\s,:\]}]/.test(text[j]!)) j++;
  return j > i ? j : -1;
}

function decodeKey(raw: string): string | undefined {
  try {
    const decoded: unknown = JSON.parse(raw);
    return typeof decoded === 'string' ? decoded : undefined;
  } catch {
    return undefined;
  }
}

interface Located {
  /** Where the pointer's value starts, or -1 when it is not in this value. */
  readonly target: number;
  /** Index just past this value, or -1 when the text is malformed from here. */
  readonly end: number;
}

/**
 * Locates `segments[k..]` inside the value starting at `i`, and also returns where that value
 * ends, so the caller carries on scanning from there: every character is read once. An object may
 * repeat a key; `JSON.parse` keeps the last, so a later match replaces an earlier one.
 */
function locate(text: string, i: number, segments: readonly string[], k: number): Located {
  if (k === segments.length) {
    const container = text[i] === '{' || text[i] === '[';
    const end = endOfValue(text, i);
    return { target: container || end >= 0 ? i : -1, end };
  }
  if (text[i] !== '{' && text[i] !== '[') return { target: -1, end: endOfValue(text, i) };
  const isArray = text[i] === '[';
  const close = isArray ? ']' : '}';
  const segment = segments[k]!;
  const wanted = isArray && /^(0|[1-9]\d*)$/.test(segment) ? Number(segment) : -1;
  let target = -1;
  let j = skipWs(text, i + 1);
  if (text[j] === close) return { target, end: j + 1 };
  for (let index = 0; ; index++) {
    let matched: boolean;
    if (isArray) {
      matched = index === wanted;
    } else {
      if (text[j] !== '"') return { target, end: -1 };
      const keyEnd = endOfString(text, j);
      if (keyEnd < 0) return { target, end: -1 };
      matched = decodeKey(text.slice(j, keyEnd)) === segment;
      j = skipWs(text, keyEnd);
      if (text[j] !== ':') return { target, end: -1 };
      j = skipWs(text, j + 1);
    }
    let end: number;
    if (matched) {
      const inner = locate(text, j, segments, k + 1);
      target = inner.target;
      end = inner.end;
    } else {
      end = endOfValue(text, j);
    }
    if (end < 0) return { target, end: -1 };
    j = skipWs(text, end);
    if (text[j] === close) return { target, end: j + 1 };
    if (text[j] !== ',') return { target, end: -1 };
    j = skipWs(text, j + 1);
  }
}

function position(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let k = text.indexOf('\n'); k >= 0 && k < offset; k = text.indexOf('\n', k + 1)) {
    line++;
    lineStart = k + 1;
  }
  return { line, column: offset - lineStart + 1 };
}

/** The range of the value `pointer` names in `text`, or `undefined` when it cannot be located. */
export function pointerRange(text: string, pointer: string): PointerTextRange | undefined {
  if (pointer !== '' && !pointer.startsWith('/')) return undefined;
  const segments =
    pointer === ''
      ? []
      : pointer
          .slice(1)
          .split('/')
          .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  const at = skipWs(text, 0);
  if (at >= text.length) return undefined;
  const found = locate(text, at, segments, 0).target;
  if (found < 0) return undefined;
  const container = text[found] === '{' || text[found] === '[';
  const end = container ? found + 1 : endOfValue(text, found);
  if (end < 0) return undefined;
  const start = position(text, found);
  return { line: start.line, column: start.column, endLine: start.line, endColumn: start.column + (end - found) };
}
