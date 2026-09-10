/**
 * SoapUI-compatible property expansion: `${#Project#name}`, `${#Env#name}`,
 * `${#Global#name}`, `${#System#name}` and the shorthand `${name}` which
 * resolves through the scope chain Env -> Project -> Global (System is never
 * implicit). Values are themselves expanded recursively (cycle-safe, depth
 * limited); unresolved expressions are left verbatim in the output (SoapUI
 * parity) and reported via `unresolved`.
 *
 * Pure module: no I/O beyond reading the `scopes.system` map the caller
 * passes in (default `process.env`).
 */

import type { PropertyMap } from './model.js';
import type { SoapSendInput } from '../types.js';

/** The property lookup scopes available to {@link expand}. */
export interface PropertyScopes {
  readonly project: PropertyMap;
  readonly env?: PropertyMap;
  readonly global: PropertyMap;
  /** Defaults to `process.env` when omitted. */
  readonly system?: Readonly<Record<string, string | undefined>>;
}

/** One `${...}` expression that could not be resolved, with offsets into the original text. */
export interface UnresolvedRef {
  /** Full `${...}` text (or the unterminated `${` for a `malformed` ref). */
  readonly expr: string;
  readonly scope?: string;
  readonly name?: string;
  readonly code: 'missing' | 'unknown-scope' | 'cycle' | 'too-deep' | 'malformed';
  readonly start: number;
  readonly end: number;
}

/** The result of expanding a string: the expanded text plus any problems and properties used. */
export interface ExpandResult {
  readonly text: string;
  readonly unresolved: readonly UnresolvedRef[];
  readonly used: readonly { scope: string; name: string }[];
}

const DEFAULT_MAX_DEPTH = 8;
const SCOPE_NAMES = new Set(['Project', 'Env', 'Global', 'System']);

interface ParsedExpr {
  /** Explicit scope (`Project`/`Env`/`Global`/`System`), or undefined for the shorthand form. */
  readonly scope: string | undefined;
  readonly name: string;
}

/** Parses the inside of `${...}` (without the delimiters) into a scope + name. */
function parseExpr(inner: string): ParsedExpr {
  if (inner.startsWith('#')) {
    const secondHash = inner.indexOf('#', 1);
    if (secondHash !== -1) {
      const scope = inner.slice(1, secondHash);
      const name = inner.slice(secondHash + 1);
      if (SCOPE_NAMES.has(scope)) {
        return { scope, name };
      }
    }
  }
  return { scope: undefined, name: inner };
}

function lookupInScope(scope: string, name: string, scopes: PropertyScopes): string | undefined {
  switch (scope) {
    case 'Project':
      return scopes.project[name];
    case 'Env':
      return scopes.env?.[name];
    case 'Global':
      return scopes.global[name];
    case 'System':
      return (scopes.system ?? process.env)[name];
    default:
      return undefined;
  }
}

/** Resolves the shorthand `${name}` through Env -> Project -> Global. */
function lookupShorthand(name: string, scopes: PropertyScopes): { scope: string; value: string } | undefined {
  if (scopes.env !== undefined && Object.hasOwn(scopes.env, name)) {
    return { scope: 'Env', value: scopes.env[name]! };
  }
  if (Object.hasOwn(scopes.project, name)) {
    return { scope: 'Project', value: scopes.project[name]! };
  }
  if (Object.hasOwn(scopes.global, name)) {
    return { scope: 'Global', value: scopes.global[name]! };
  }
  return undefined;
}

/** One token found while scanning `text`: either a literal run or a `${...}` expression (parsed or malformed). */
type Token =
  | { readonly kind: 'literal'; readonly text: string }
  | {
      readonly kind: 'expr';
      readonly raw: string;
      readonly inner: string;
      readonly start: number;
      readonly end: number;
    }
  | { readonly kind: 'malformed'; readonly raw: string; readonly start: number; readonly end: number };

/** Scans `text` for `$${` escapes and `${...}` expressions, respecting nested braces. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let literal = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('$${', i)) {
      literal += '${';
      i += 3;
      continue;
    }
    if (text.startsWith('${', i)) {
      if (literal.length > 0) {
        tokens.push({ kind: 'literal', text: literal });
        literal = '';
      }
      const start = i;
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text.startsWith('${', j)) {
          depth++;
          j += 2;
          continue;
        }
        if (text[j] === '}') {
          depth--;
          j++;
          continue;
        }
        j++;
      }
      if (depth === 0) {
        const raw = text.slice(start, j);
        const inner = text.slice(start + 2, j - 1);
        tokens.push({ kind: 'expr', raw, inner, start, end: j });
        i = j;
      } else {
        // Unterminated ${ : malformed, runs to end of string.
        const raw = text.slice(start);
        tokens.push({ kind: 'malformed', raw, start, end: text.length });
        i = text.length;
      }
      continue;
    }
    literal += text[i];
    i++;
  }
  if (literal.length > 0) {
    tokens.push({ kind: 'literal', text: literal });
  }
  return tokens;
}

interface ExpandContext {
  readonly scopes: PropertyScopes;
  readonly maxDepth: number;
  readonly unresolved: UnresolvedRef[];
  readonly used: { scope: string; name: string }[];
}

/** Expands all `${...}` expressions in `text` at `depth`, tracking an active-resolution stack for cycle detection. */
function expandAt(text: string, depth: number, stack: readonly string[], ctx: ExpandContext): string {
  const tokens = tokenize(text);
  let out = '';
  for (const token of tokens) {
    if (token.kind === 'literal') {
      out += token.text;
      continue;
    }
    if (token.kind === 'malformed') {
      ctx.unresolved.push({ expr: token.raw, code: 'malformed', start: token.start, end: token.end });
      out += token.raw;
      continue;
    }
    if (depth >= ctx.maxDepth) {
      ctx.unresolved.push({ expr: token.raw, code: 'too-deep', start: token.start, end: token.end });
      out += token.raw;
      continue;
    }
    // The inner text of the expression may itself contain expressions (nesting); expand those first.
    const resolvedInner = expandAt(token.inner, depth + 1, stack, ctx);
    const { scope, name } = parseExpr(resolvedInner);

    if (scope !== undefined) {
      const key = `${scope}#${name}`;
      if (stack.includes(key)) {
        ctx.unresolved.push({ expr: token.raw, scope, name, code: 'cycle', start: token.start, end: token.end });
        out += token.raw;
        continue;
      }
      const value = lookupInScope(scope, name, ctx.scopes);
      if (value === undefined) {
        ctx.unresolved.push({ expr: token.raw, scope, name, code: 'missing', start: token.start, end: token.end });
        out += token.raw;
        continue;
      }
      ctx.used.push({ scope, name });
      out += expandAt(value, depth + 1, [...stack, key], ctx);
      continue;
    }

    // Shorthand: check it's not referencing an unknown explicit scope form like `${#Foo#x}`.
    if (resolvedInner.startsWith('#')) {
      const secondHash = resolvedInner.indexOf('#', 1);
      if (secondHash !== -1) {
        const attemptedScope = resolvedInner.slice(1, secondHash);
        const attemptedName = resolvedInner.slice(secondHash + 1);
        ctx.unresolved.push({
          expr: token.raw,
          scope: attemptedScope,
          name: attemptedName,
          code: 'unknown-scope',
          start: token.start,
          end: token.end,
        });
        out += token.raw;
        continue;
      }
    }

    const found = lookupShorthand(name, ctx.scopes);
    if (found === undefined) {
      ctx.unresolved.push({ expr: token.raw, name, code: 'missing', start: token.start, end: token.end });
      out += token.raw;
      continue;
    }
    const key = `${found.scope}#${name}`;
    if (stack.includes(key)) {
      ctx.unresolved.push({
        expr: token.raw,
        scope: found.scope,
        name,
        code: 'cycle',
        start: token.start,
        end: token.end,
      });
      out += token.raw;
      continue;
    }
    ctx.used.push({ scope: found.scope, name });
    out += expandAt(found.value, depth + 1, [...stack, key], ctx);
  }
  return out;
}

/** Expands every `${...}` property reference in `text` against `scopes`. */
export function expand(text: string, scopes: PropertyScopes, options?: { maxDepth?: number }): ExpandResult {
  const ctx: ExpandContext = {
    scopes,
    maxDepth: options?.maxDepth ?? DEFAULT_MAX_DEPTH,
    unresolved: [],
    used: [],
  };
  const out = expandAt(text, 0, [], ctx);
  return { text: out, unresolved: ctx.unresolved, used: ctx.used };
}

/** True when `text` contains at least one (non-escaped) `${` sequence. */
export function hasExpansions(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('$${', i)) {
      i += 2;
      continue;
    }
    if (text.startsWith('${', i)) {
      return true;
    }
  }
  return false;
}

/** Expands the endpoint, envelope, soap action, and every header name/value of a {@link SoapSendInput}. */
export function expandSendInput(
  input: SoapSendInput,
  scopes: PropertyScopes,
): { input: SoapSendInput; unresolved: UnresolvedRef[] } {
  const unresolved: UnresolvedRef[] = [];

  function run(text: string): string {
    const result = expand(text, scopes);
    unresolved.push(...result.unresolved);
    return result.text;
  }

  const endpoint = run(input.endpoint);
  const envelopeXml = run(input.envelopeXml);
  const soapAction = input.soapAction !== undefined ? run(input.soapAction) : undefined;

  let headers: Record<string, string> | undefined;
  if (input.headers !== undefined) {
    headers = {};
    for (const [name, value] of Object.entries(input.headers)) {
      headers[run(name)] = run(value);
    }
  }

  return {
    input: {
      ...input,
      endpoint,
      envelopeXml,
      ...(soapAction !== undefined ? { soapAction } : {}),
      ...(headers !== undefined ? { headers } : {}),
    },
    unresolved,
  };
}
