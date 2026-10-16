// packages/engine/src/import/template-dialects.ts
/**
 * Variable syntax of other API clients, rewritten to the `{{name}}` text the shared
 * `rewriteMustache` turns into Wirebench references. Nothing here emits `${`. A construct with no
 * Wirebench equivalent is left as written and its name added to `kept`, for the import report.
 * Every scanner moves forward with `indexOf`, so a long run of delimiters costs linear time.
 */

/**
 * `text` with each `open … close` span passed to `rewrite` (given the span's inner text); a span it
 * returns `undefined` for stays as written, and scanning resumes just past its open. `findClose`
 * returns the close index, -1 for none after this open, or -2 when nothing later can close either.
 */
function rewriteSpans(
  text: string,
  open: string,
  close: string,
  rewrite: (inner: string) => string | undefined,
  findClose: (from: number) => number = (from) => {
    const at = text.indexOf(close, from);
    return at < 0 ? -2 : at;
  },
): string {
  let out = '';
  let from = 0;
  let start = text.indexOf(open, 0);
  while (start >= 0) {
    const innerStart = start + open.length;
    const end = findClose(innerStart);
    if (end === -2) break;
    if (end >= 0) {
      // An open inside the span is a later, real start: the earlier one never closed.
      const later = text.lastIndexOf(open, end - open.length);
      if (later >= innerStart) {
        start = later;
        continue;
      }
      const replacement = rewrite(text.slice(innerStart, end));
      if (replacement !== undefined) {
        out += text.slice(from, start) + replacement;
        from = end + close.length;
        start = text.indexOf(open, from);
        continue;
      }
    }
    // Rejected, or this open has no close: keep it as written and look past it.
    start = text.indexOf(open, innerStart);
  }
  return out + text.slice(from);
}

function isNameChar(ch: string): boolean {
  return /[A-Za-z0-9_$-]/.test(ch);
}

/** The dotted name of an Insomnia reference (`_.a.b`, `_['k']`, `a[0].b`), or `undefined`. */
function insomniaPath(expr: string): string | undefined {
  let i = 0;
  const segments: string[] = [];
  const readName = (): string => {
    const begin = i;
    while (i < expr.length && isNameChar(expr[i] as string)) i += 1;
    return expr.slice(begin, i);
  };
  const first = readName();
  if (first.length === 0) return undefined;
  if (first !== '_') segments.push(first);
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === '.') {
      i += 1;
      const name = readName();
      if (name.length === 0) return undefined;
      segments.push(name);
    } else if (ch === '[') {
      const close = expr.indexOf(']', i);
      if (close < 0) return undefined;
      const body = expr.slice(i + 1, close).trim();
      const quote = body[0];
      const key =
        (quote === "'" || quote === '"') && body.length >= 2 && body.endsWith(quote) ? body.slice(1, -1) : body;
      if (key.length === 0 || /[\s{}]/.test(key)) return undefined;
      segments.push(key);
      i = close + 1;
    } else {
      return undefined;
    }
  }
  // `_.vault.x` is a vault variable; the environment plan holds `x` as a secret.
  if (first === '_' && segments[0] === 'vault' && segments.length > 1) segments.shift();
  return segments.length === 0 ? undefined : segments.join('.');
}

/** The text between the first pair of single or double quotes in `args`, or `undefined`. */
function firstQuoted(args: string): string | undefined {
  const match = /^\s*(['"])(.*?)\1/.exec(args);
  return match === null ? undefined : match[2];
}

export function insomniaTemplates(text: string, kept: Set<string>): string {
  const tags = rewriteSpans(text, '{%', '%}', (inner) => {
    const body = inner.trim();
    const space = body.search(/\s/);
    const name = space < 0 ? body : body.slice(0, space);
    const arg = space < 0 ? undefined : firstQuoted(body.slice(space));
    if (name === 'uuid' && (arg === undefined || arg === 'v4' || arg === 'v1')) return '{{$guid}}';
    if (name === 'now' && arg === 'iso-8601') return '{{$isoTimestamp}}';
    if (name === 'now' && arg === 'unix') return '{{$timestamp}}';
    kept.add(name);
    return undefined;
  });
  return rewriteSpans(tags, '{{', '}}', (inner) => {
    const expr = inner.trim();
    if (expr.startsWith('$')) return undefined;
    const path = expr.includes('|') ? undefined : insomniaPath(expr);
    if (path === undefined) {
      kept.add(expr.includes('|') ? 'filter' : expr);
      return undefined;
    }
    return `{{${path}}}`;
  });
}

export function hoppscotchTemplates(text: string, kept: Set<string>): string {
  return rewriteSpans(text, '<<', '>>', (inner) => {
    const name = inner.trim();
    if (name.length === 0 || /[<>\n]/.test(name)) return undefined;
    if (/\s/.test(name)) {
      kept.add(name);
      return undefined;
    }
    return `{{${name}}}`;
  });
}

const THUNDER_GENERATORS: ReadonlyMap<string, string> = new Map([
  ['guid', '{{$guid}}'],
  ['timestamp', '{{$timestamp}}'],
  ['dateISO', '{{$isoTimestamp}}'],
]);

/**
 * Where a Thunder Client `{{#call, {arg: 1}}}` ends: its braces balance, so `}}` closes the call
 * only at depth zero. -1 when the call does not close before the next `{{` or the end.
 */
function thunderClose(text: string, from: number): number {
  if (text[from] !== '#') {
    const at = text.indexOf('}}', from);
    return at < 0 ? -2 : at;
  }
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      if (text[i + 1] === '{') return -1;
      depth += 1;
    } else if (ch === '}') {
      if (depth === 0 && text[i + 1] === '}') return i;
      if (depth > 0) depth -= 1;
    }
  }
  return -1;
}

export function thunderTemplates(text: string, kept: Set<string>): string {
  return rewriteSpans(
    text,
    '{{',
    '}}',
    (inner) => {
      const expr = inner.trim();
      if (expr.includes('|')) {
        kept.add(expr);
        return undefined;
      }
      if (expr.startsWith('#')) {
        const mapped = THUNDER_GENERATORS.get(expr.slice(1));
        if (mapped === undefined) kept.add(expr);
        return mapped;
      }
      return undefined;
    },
    (from) => thunderClose(text, from),
  );
}

const ENV_PREFIX = 'process.env.';

export function brunoTemplates(text: string, kept: Set<string>): string {
  return rewriteSpans(text, '{{', '}}', (inner) => {
    const expr = inner.trim();
    if (expr.startsWith('?')) {
      kept.add(expr);
      return undefined;
    }
    if (expr.startsWith(ENV_PREFIX) && expr.length > ENV_PREFIX.length) {
      return `{{#System#${expr.slice(ENV_PREFIX.length)}}}`;
    }
    return undefined;
  });
}
