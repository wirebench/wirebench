// packages/engine/src/import/template-dialects.ts
/**
 * Variable syntax of other API clients, rewritten to the `{{name}}` text the shared
 * `rewriteMustache` turns into Wirebench references. Nothing here emits `${`. A construct with no
 * Wirebench equivalent is left as written and its name added to `kept`, for the import report.
 * Every scanner moves forward with `indexOf`, so a long run of delimiters costs linear time.
 */

/**
 * `text` with each `open … close` span passed to `rewrite` (given the span's inner text); a span it
 * returns `undefined` for stays as written. An open with no close ends the scan: nothing later closes.
 */
function rewriteSpans(
  text: string,
  open: string,
  close: string,
  rewrite: (inner: string) => string | undefined,
): string {
  let out = '';
  let from = 0;
  for (;;) {
    const start = text.indexOf(open, from);
    if (start < 0) break;
    const end = text.indexOf(close, start + open.length);
    if (end < 0) break;
    const replacement = rewrite(text.slice(start + open.length, end));
    out += text.slice(from, start);
    out += replacement ?? text.slice(start, end + close.length);
    from = end + close.length;
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
      if (key.length === 0 || key.includes('{') || key.includes('}')) return undefined;
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
    if (name === 'uuid' && (arg === 'v4' || arg === 'v1')) return '{{$guid}}';
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

export function hoppscotchTemplates(text: string): string {
  return rewriteSpans(text, '<<', '>>', (inner) => {
    const name = inner.trim();
    if (name.length === 0 || /[<>\n]/.test(name)) return undefined;
    return `{{${name}}}`;
  });
}

const THUNDER_GENERATORS: ReadonlyMap<string, string> = new Map([
  ['guid', '{{$guid}}'],
  ['timestamp', '{{$timestamp}}'],
]);

export function thunderTemplates(text: string, kept: Set<string>): string {
  return rewriteSpans(text, '{{', '}}', (inner) => {
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
  });
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
