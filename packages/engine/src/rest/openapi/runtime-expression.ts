/**
 * OpenAPI runtime expressions: the `{$request.body#/callbackUrl}` in a callback's key. Parsed once,
 * evaluated against one recorded exchange of the parent operation. Anything the grammar does not
 * allow is "not a runtime expression" — never an exception.
 */

export type RuntimeSource =
  | { readonly kind: 'header'; readonly name: string }
  | { readonly kind: 'query'; readonly name: string }
  | { readonly kind: 'path'; readonly name: string }
  | { readonly kind: 'body'; readonly pointer: string };

export type RuntimeExpression =
  | { readonly kind: 'url' }
  | { readonly kind: 'method' }
  | { readonly kind: 'statusCode' }
  | { readonly kind: 'request'; readonly source: RuntimeSource }
  | { readonly kind: 'response'; readonly source: RuntimeSource };

export type TemplatePart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'expression'; readonly source: string; readonly expression: RuntimeExpression };

/** The exchange an expression is evaluated against: the parent operation's last request and reply. */
export interface RuntimeExchange {
  readonly url: string;
  readonly method: string;
  /** The parent's templated path (`/subscriptions/{id}`), for `$request.path.<name>`. */
  readonly pathTemplate?: string;
  readonly request: { readonly headers: readonly (readonly [string, string])[]; readonly body?: string };
  readonly response?:
    | {
        readonly status: number;
        readonly headers: readonly (readonly [string, string])[];
        readonly body?: string;
      }
    | undefined;
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function parseSource(text: string, request: boolean): RuntimeSource | undefined {
  if (text === 'body') return { kind: 'body', pointer: '' };
  if (text.startsWith('body#')) {
    const pointer = text.slice('body#'.length);
    return pointer === '' || pointer.startsWith('/') ? { kind: 'body', pointer } : undefined;
  }
  const dot = text.indexOf('.');
  if (dot < 0) return undefined;
  const where = text.slice(0, dot);
  const name = text.slice(dot + 1);
  if (name === '') return undefined;
  if (where === 'header') return TOKEN.test(name) ? { kind: 'header', name } : undefined;
  if (request && (where === 'query' || where === 'path')) return { kind: where, name };
  return undefined;
}

/** Parses one expression without its braces: `$url`, `$request.body#/a`… */
export function parseRuntimeExpression(text: string): RuntimeExpression | undefined {
  if (text === '$url') return { kind: 'url' };
  if (text === '$method') return { kind: 'method' };
  if (text === '$statusCode') return { kind: 'statusCode' };
  for (const kind of ['request', 'response'] as const) {
    const prefix = `$${kind}.`;
    if (text.startsWith(prefix)) {
      const source = parseSource(text.slice(prefix.length), kind === 'request');
      return source === undefined ? undefined : { kind, source };
    }
  }
  return undefined;
}

/** Splits a callback key into literal text and `{expression}` parts; `undefined` when it does not parse. */
export function parseRuntimeTemplate(key: string): readonly TemplatePart[] | undefined {
  const parts: TemplatePart[] = [];
  let index = 0;
  while (index < key.length) {
    const open = key.indexOf('{', index);
    if (open < 0) {
      parts.push({ kind: 'text', text: key.slice(index) });
      break;
    }
    if (open > index) parts.push({ kind: 'text', text: key.slice(index, open) });
    const close = key.indexOf('}', open);
    if (close < 0) return undefined;
    const source = key.slice(open + 1, close);
    const expression = parseRuntimeExpression(source);
    if (expression === undefined) return undefined;
    parts.push({ kind: 'expression', source, expression });
    index = close + 1;
  }
  return parts;
}

/** RFC 6901: `''` is the whole value; `~1` is `/`, `~0` is `~`. `undefined` when there is nothing there. */
export function resolveJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  let current: unknown = value;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
      current = current[Number(key)];
    } else if (typeof current === 'object' && current !== null && Object.hasOwn(current, key)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

function headerOf(headers: readonly (readonly [string, string])[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find(([candidate]) => candidate.toLowerCase() === lower)?.[1];
}

function pathParam(url: string, template: string | undefined, name: string): string | undefined {
  if (template === undefined) return undefined;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const names: string[] = [];
  const pattern = template
    .split(/(\{[^}]+\})/)
    .map((piece) => {
      const param = /^\{([^}]+)\}$/.exec(piece);
      if (param !== null) {
        names.push(param[1] as string);
        return '([^/]+)';
      }
      return piece.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
    })
    .join('');
  const match = new RegExp(`${pattern}$`).exec(path);
  const at = names.indexOf(name);
  const found = match === null || at < 0 ? undefined : match[at + 1];
  return found === undefined ? undefined : decodeURIComponent(found);
}

function bodyValue(body: string | undefined, pointer: string): string | undefined {
  if (body === undefined) return undefined;
  if (pointer === '') return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const found = resolveJsonPointer(parsed, pointer);
  if (found === undefined || found === null) return undefined;
  return typeof found === 'string' ? found : JSON.stringify(found);
}

function evaluate(expression: RuntimeExpression, exchange: RuntimeExchange): string | undefined {
  switch (expression.kind) {
    case 'url':
      return exchange.url;
    case 'method':
      return exchange.method;
    case 'statusCode':
      return exchange.response === undefined ? undefined : String(exchange.response.status);
    case 'request':
    case 'response': {
      const side = expression.kind === 'request' ? exchange.request : exchange.response;
      if (side === undefined) return undefined;
      const source = expression.source;
      switch (source.kind) {
        case 'header':
          return headerOf(side.headers, source.name);
        case 'body':
          return bodyValue(side.body, source.pointer);
        case 'query':
          try {
            return new URL(exchange.url).searchParams.get(source.name) ?? undefined;
          } catch {
            return undefined;
          }
        case 'path':
          return pathParam(exchange.url, exchange.pathTemplate, source.name);
      }
    }
  }
}

/** Fills a callback key from `exchange`. */
export function evaluateRuntimeTemplate(
  key: string,
  exchange: RuntimeExchange,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string } {
  const parts = parseRuntimeTemplate(key);
  if (parts === undefined) return { ok: false, reason: 'not a runtime expression' };
  let value = '';
  for (const part of parts) {
    if (part.kind === 'text') {
      value += part.text;
      continue;
    }
    const found = evaluate(part.expression, exchange);
    if (found === undefined) return { ok: false, reason: `${part.source} has no value` };
    value += found;
  }
  return { ok: true, value };
}
