/**
 * Other request clients' template syntax, rewritten to the `{{name}}` form {@link rewriteMustache}
 * reads, before the shared mappers run (spec §3.4). Dynamic names then map, or are kept and
 * reported, exactly as for a Postman collection.
 *
 * A construct a dialect cannot map is kept as written and its name added to `kept`, for the report.
 * One written as `{{…}}` is shielded — its braces swapped for private-use characters — so the shared
 * mappers do not turn it into a `${…}` reference that never resolves; {@link unshieldTemplates}
 * puts the braces back once mapping is done.
 *
 * Every scan is linear: openings are found with `indexOf`, and the closing a search found is
 * reused until the scan passes it, so a long run of `{` costs one pass.
 */

import { isDynamicName } from '../project/dynamic.js';

/** Stand-ins for a kept construct's `{{` and `}}` while the shared mappers run. */
const SHIELD_OPEN = '';
const SHIELD_CLOSE = '';

function shield(construct: string): string {
  return `${SHIELD_OPEN}${construct.slice(2, -2)}${SHIELD_CLOSE}`;
}

/** `text` with every shielded construct's braces put back. */
export function unshieldText(text: string): string {
  if (!text.includes(SHIELD_OPEN) && !text.includes(SHIELD_CLOSE)) return text;
  return text.split(SHIELD_OPEN).join('{{').split(SHIELD_CLOSE).join('}}');
}

/** `value` with every string in it unshielded, arrays and plain objects walked; nothing else is touched. */
export function unshieldTemplates<T>(value: T): T {
  if (typeof value === 'string') return unshieldText(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => unshieldTemplates(item)) as T;
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = unshieldTemplates(item);
    return out as T;
  }
  return value;
}

/**
 * Calls `each` for every `open … close` construct in `text` and joins what it returns with the text
 * between them. `each` gets the inner text and the whole construct and returns the replacement, or
 * `undefined` to keep the construct's first character as text and go on scanning after it.
 */
function scan(
  text: string,
  open: string,
  close: string,
  each: (inner: string, whole: string) => string | undefined,
): string {
  let out = '';
  let at = 0;
  let closeAt = -1;
  for (;;) {
    const start = text.indexOf(open, at);
    if (start === -1) break;
    if (closeAt < start + open.length) closeAt = text.indexOf(close, start + open.length);
    if (closeAt === -1) break;
    const end = closeAt + close.length;
    const replaced = each(text.slice(start + open.length, closeAt), text.slice(start, end));
    if (replaced === undefined) {
      out += text.slice(at, start + 1);
      at = start + 1;
      continue;
    }
    out += text.slice(at, start) + replaced;
    at = end;
  }
  return out + text.slice(at);
}

function isIdentifierStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

/** Where an identifier starting at `from` ends: a letter or `_`, then letters, digits and `_`. */
function identifierEnd(text: string, from: number): number {
  if (!isIdentifierStart(text.charCodeAt(from))) return from;
  let at = from + 1;
  while (at < text.length) {
    const c = text.charCodeAt(at);
    if (!isIdentifierStart(c) && !(c >= 48 && c <= 57)) break;
    at += 1;
  }
  return at;
}

/**
 * The segments of an Insomnia variable path — `_.a.b`, `_['my-key']`, `users[0].id`, or a bare
 * `name` — or `undefined` when `inner` is anything else (a filter, an expression).
 */
function insomniaPath(inner: string): string[] | undefined {
  let at: number;
  const segments: string[] = [];
  if (inner.startsWith('_.') || inner.startsWith('_[')) {
    at = 1;
  } else {
    const end = identifierEnd(inner, 0);
    if (end === 0) return undefined;
    segments.push(inner.slice(0, end));
    at = end;
  }
  while (at < inner.length) {
    const c = inner[at];
    if (c === '.') {
      const end = identifierEnd(inner, at + 1);
      if (end === at + 1) return undefined;
      segments.push(inner.slice(at + 1, end));
      at = end;
      continue;
    }
    if (c !== '[') return undefined;
    const quote = inner[at + 1];
    if (quote === "'" || quote === '"') {
      const close = inner.indexOf(`${quote}]`, at + 2);
      if (close === -1) return undefined;
      const key = inner.slice(at + 2, close);
      if (key === '' || key.includes(quote)) return undefined;
      segments.push(key);
      at = close + 2;
      continue;
    }
    const close = inner.indexOf(']', at + 1);
    const index = close === -1 ? '' : inner.slice(at + 1, close);
    if (index === '' || ![...index].every((d) => d >= '0' && d <= '9')) return undefined;
    segments.push(index);
    at = close + 1;
  }
  return segments.length > 0 ? segments : undefined;
}

/** The first argument of a `{% tag 'arg', … %}`, unquoted, or `undefined` when it has none. */
function firstTagArgument(rest: string): string | undefined {
  const text = rest.trim();
  const quote = text[0];
  if (quote !== "'" && quote !== '"') return undefined;
  const close = text.indexOf(quote, 1);
  return close === -1 ? undefined : text.slice(1, close);
}

/**
 * Insomnia: `{{ _.name }}`, `{{ name }}` and `{{ _['my-name'] }}` become `{{name}}`, a nested
 * `{{ _.db.host }}` becomes `{{db.host}}` (the flattened property), and `{{ _.vault.name }}` becomes
 * `{{name}}` when `vaultNames` holds it (the vault value became a secret of that name). `{% uuid %}`
 * and `{% now 'iso-8601' | 'unix' %}` become dynamic names. Any other tag, a filter or an
 * expression is kept; `kept` gets each tag's name, or the construct itself.
 */
export function insomniaTemplates(text: string, kept: Set<string>, vaultNames?: ReadonlySet<string>): string {
  const variables = scan(text, '{{', '}}', (raw, whole) => {
    if (raw.includes('{')) return undefined;
    const segments = insomniaPath(raw.trim());
    if (segments !== undefined && segments[0] === 'vault') {
      const name = segments.length === 2 ? segments[1] : undefined;
      if (name !== undefined && vaultNames?.has(name) === true) return `{{${name}}}`;
      kept.add(whole);
      return shield(whole);
    }
    if (segments === undefined) {
      kept.add(whole);
      return shield(whole);
    }
    return `{{${segments.join('.')}}}`;
  });
  return scan(variables, '{%', '%}', (raw, whole) => {
    const inner = raw.trim();
    const space = inner.search(/\s/);
    const name = space === -1 ? inner : inner.slice(0, space);
    if (name === 'uuid') return '{{$guid}}';
    if (name === 'now') {
      const format = firstTagArgument(space === -1 ? '' : inner.slice(space));
      if (format === 'iso-8601') return '{{$isoTimestamp}}';
      if (format === 'unix') return '{{$timestamp}}';
    }
    // A block's closing tag (`endif`, `endfor`) is named by its opening one.
    if (!name.startsWith('end')) kept.add(name === '' ? whole : name);
    return whole;
  });
}

/** A Hoppscotch variable name: letters, digits, `_`, `.`, `-`, and a leading `$` for a predefined one. */
const HOPPSCOTCH_NAME = /^\$?[\w.-]+$/;

/** Hoppscotch: `<<name>>` becomes `{{name}}`; a predefined `<<$guid>>` becomes `{{$guid}}`. */
export function hoppscotchTemplates(text: string): string {
  return scan(text, '<<', '>>', (inner) => (HOPPSCOTCH_NAME.test(inner) ? `{{${inner}}}` : undefined));
}

/** The arguments of a `{{#name, a, b}}` system variable, split at commas outside quotes and braces. */
function systemArguments(rest: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = '';
  for (const c of rest) {
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '{') {
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
    } else if (c === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim() !== '') args.push(current.trim());
  return args;
}

const INTEGER = /^-?\d+$/;

/** The `{{$…}}` a Thunder Client system variable maps to, or `undefined` when no generator fits. */
function thunderDynamic(name: string, args: readonly string[]): string | undefined {
  const fits = (dynamic: string): string | undefined => (isDynamicName(dynamic) ? `{{$${dynamic}}}` : undefined);
  if (args.length === 0) {
    switch (name) {
      case 'guid':
        return fits('guid');
      case 'email':
        return fits('email');
      case 'name':
        return fits('fullName');
      case 'bool':
        return fits('randomBoolean');
      case 'dateISO':
        return fits('isoTimestamp');
      default:
        return undefined;
    }
  }
  if (name === 'number' && args.length === 2 && INTEGER.test(args[0]!) && INTEGER.test(args[1]!)) {
    return `{{$randomInt ${args[0]!} ${args[1]!}}}`;
  }
  if (name === 'date' && args.length === 1 && (args[0] === "'X'" || args[0] === '"X"')) return fits('timestamp');
  return undefined;
}

/**
 * Thunder Client: a `{{#name}}` system variable becomes a dynamic name where a generator fits; any
 * other, and a `{{name | filter}}`, is kept and its construct added to `kept`. A plain `{{name}}`
 * is left as it is.
 */
export function thunderTemplates(text: string, kept: Set<string>): string {
  return scan(text, '{{', '}}', (raw, whole) => {
    const inner = raw.trim();
    if (inner.startsWith('#')) {
      const comma = inner.indexOf(',');
      const name = (comma === -1 ? inner.slice(1) : inner.slice(1, comma)).trim();
      const mapped = thunderDynamic(name, comma === -1 ? [] : systemArguments(inner.slice(comma + 1)));
      if (mapped !== undefined) return mapped;
      kept.add(whole);
      return shield(whole);
    }
    if (raw.includes('{')) return undefined;
    if (inner.includes('|') || inner.startsWith('@')) {
      kept.add(whole);
      return shield(whole);
    }
    return whole;
  });
}

const PROCESS_ENV_PREFIX = 'process.env.';

/**
 * Bruno: `{{process.env.NAME}}` becomes `{{#System#NAME}}`, which the shared rewrite turns into
 * `${#System#NAME}`; a `{{?Prompt}}` is kept and added to `kept`.
 */
export function brunoTemplates(text: string, kept: Set<string>): string {
  return scan(text, '{{', '}}', (raw, whole) => {
    if (raw.includes('{')) return undefined;
    const inner = raw.trim();
    if (inner.startsWith(PROCESS_ENV_PREFIX)) {
      const name = inner.slice(PROCESS_ENV_PREFIX.length);
      if (name !== '' && identifierEnd(name, 0) === name.length) return `{{#System#${name}}}`;
    }
    if (inner.startsWith('?')) {
      kept.add(whole);
      return shield(whole);
    }
    return whole;
  });
}
