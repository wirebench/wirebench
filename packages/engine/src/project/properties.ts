/**
 * Property expansion over the `${#Project#name}`, `${#Env#name}`,
 * `${#Workspace#name}`, `${#Global#name}` and `${#System#name}` syntax, plus
 * the shorthand `${name}` which resolves through the scope chain
 * Env -> Project -> Workspace -> Global (System is never implicit). Values
 * are themselves expanded recursively (cycle-safe, depth limited);
 * unresolved expressions are left verbatim in the output and reported via
 * `unresolved`.
 *
 * Pure module: no I/O beyond reading the `scopes.system` map the caller
 * passes in (default `process.env`).
 */

import { entitizeValue } from '../soap/transforms.js';
import type { PropertyMap } from './model.js';
import type { SoapSendInput } from '../types.js';

/** The property lookup scopes available to {@link expand}. */
export interface PropertyScopes {
  readonly project: PropertyMap;
  readonly env?: PropertyMap;
  /** Workspace-level properties, when expanding within a workspace. */
  readonly workspace?: PropertyMap;
  /**
   * Global properties. Unlike the other scopes, globals have no `disabledProperties` list of
   * their own in this package (they are not part of `Project`/`Workspace`) — a caller that wants
   * disabled globals excluded from resolution must filter this map itself (with
   * {@link enabledProperties}, say) before passing it in.
   */
  readonly global: PropertyMap;
  /** Defaults to `process.env` when omitted. */
  readonly system?: Readonly<Record<string, string | undefined>>;
}

/**
 * Filters `map` down to the entries not listed in `disabled`, preserving the map's key order.
 * Used to make property resolution treat a disabled property as absent (its value stays on disk,
 * see `Environment.disabledProperties`) without mutating the stored map itself.
 */
export function enabledProperties(map: PropertyMap, disabled: readonly string[]): PropertyMap {
  if (disabled.length === 0) {
    return map;
  }
  const disabledSet = new Set(disabled);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    if (!disabledSet.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

/** One `${...}` expression that could not be resolved, with offsets into the original text. */
export interface UnresolvedRef {
  /**
   * The `${...}` expression text (or the unterminated `${` for a `malformed` ref). When this
   * ref was found while expanding a property's VALUE (see `via`), this is the inner expression
   * text, not the outer reference the user typed — use `start`/`end` for the user-visible span.
   */
  readonly expr: string;
  readonly scope?: string;
  readonly name?: string;
  readonly code: 'missing' | 'unknown-scope' | 'cycle' | 'too-deep' | 'malformed';
  /**
   * Offsets into the original text of the *outermost* `${...}` reference the user can see. When
   * this ref was discovered while recursively expanding a property's value (not the original
   * text directly), these are the outer reference's offsets, not offsets into that value string.
   */
  readonly start: number;
  readonly end: number;
  /**
   * The chain of `scope#name` properties traversed to reach this ref, outermost first. Present
   * only when this ref was found while expanding a property's value (i.e. it is nested at least
   * one level below the outer reference at `start`/`end`).
   */
  readonly via?: readonly string[];
}

/** The result of expanding a string: the expanded text plus any problems and properties used. */
export interface ExpandResult {
  readonly text: string;
  readonly unresolved: readonly UnresolvedRef[];
  readonly used: readonly { scope: string; name: string }[];
}

const DEFAULT_MAX_DEPTH = 8;
const SCOPE_NAMES = new Set(['Project', 'Env', 'Workspace', 'Global', 'System']);

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
    case 'Workspace':
      return scopes.workspace?.[name];
    case 'Global':
      return scopes.global[name];
    case 'System':
      return (scopes.system ?? process.env)[name];
    default:
      return undefined;
  }
}

/** Resolves the shorthand `${name}` through Env -> Project -> Workspace -> Global. */
function lookupShorthand(name: string, scopes: PropertyScopes): { scope: string; value: string } | undefined {
  if (scopes.env !== undefined && Object.hasOwn(scopes.env, name)) {
    return { scope: 'Env', value: scopes.env[name]! };
  }
  if (Object.hasOwn(scopes.project, name)) {
    return { scope: 'Project', value: scopes.project[name]! };
  }
  if (scopes.workspace !== undefined && Object.hasOwn(scopes.workspace, name)) {
    return { scope: 'Workspace', value: scopes.workspace[name]! };
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

/**
 * Scans `text` for `$${` escapes and `${...}` expressions, respecting nested braces. The `$${`
 * escape is matched left-to-right and greedily on the *first* two characters that can start it,
 * so a run of three or more `$` before a `{` (e.g. `$$${x}`) never opens an expression: the
 * escape consumes the middle `$$` + `{`, leaving the rest (including `x}`) as plain literal
 * text, so `x` is never looked up.
 */
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
  /** XML-escape every substituted value ("Entitize Properties"). */
  readonly entitize: boolean;
  readonly unresolved: UnresolvedRef[];
  readonly used: { scope: string; name: string }[];
}

/** The original-text span (and property chain) to attribute unresolved refs to, once expansion has recursed into a property's value. */
interface OuterSpan {
  readonly start: number;
  readonly end: number;
}

/** Pushes an unresolved ref, reporting `outer`'s span (the user-visible outer reference) when set, else the token's own span. */
function pushUnresolved(
  ctx: ExpandContext,
  outer: OuterSpan | undefined,
  via: readonly string[],
  entry: { expr: string; scope?: string; name?: string; code: UnresolvedRef['code']; start: number; end: number },
): void {
  ctx.unresolved.push({
    ...entry,
    start: outer?.start ?? entry.start,
    end: outer?.end ?? entry.end,
    ...(via.length > 0 ? { via } : {}),
  });
}

/**
 * The text a resolved reference contributes to the output. When entitizing is on, the value is
 * XML-escaped — but only at the outermost reference (`outer === undefined`), so a property whose
 * value itself expands another property is escaped once rather than once per nesting level.
 */
function substituted(ctx: ExpandContext, outer: OuterSpan | undefined, value: string): string {
  return ctx.entitize && outer === undefined ? entitizeValue(value) : value;
}

/**
 * Expands all `${...}` expressions in `text` at `depth`, tracking an active-resolution stack for
 * cycle detection. `outer`/`via` are set once expansion recurses into a property's value: `outer`
 * pins unresolved refs to the outermost user-visible `${...}` span in the original text (rather
 * than an offset into the value string), and `via` records the `scope#name` chain traversed to
 * get here (outermost first).
 */
function expandAt(
  text: string,
  depth: number,
  stack: readonly string[],
  ctx: ExpandContext,
  outer: OuterSpan | undefined,
  via: readonly string[],
): string {
  const tokens = tokenize(text);
  let out = '';
  for (const token of tokens) {
    if (token.kind === 'literal') {
      out += token.text;
      continue;
    }
    if (token.kind === 'malformed') {
      pushUnresolved(ctx, outer, via, { expr: token.raw, code: 'malformed', start: token.start, end: token.end });
      out += token.raw;
      continue;
    }
    if (depth >= ctx.maxDepth) {
      pushUnresolved(ctx, outer, via, { expr: token.raw, code: 'too-deep', start: token.start, end: token.end });
      out += token.raw;
      continue;
    }
    // The span/chain to attribute anything found from here on down (this token's own span, unless already nested).
    const effectiveOuter = outer ?? { start: token.start, end: token.end };
    // The inner text of the expression may itself contain expressions (nesting); expand those first.
    const resolvedInner = expandAt(token.inner, depth + 1, stack, ctx, effectiveOuter, via);
    const { scope, name } = parseExpr(resolvedInner);

    if (scope !== undefined) {
      const key = `${scope}#${name}`;
      if (stack.includes(key)) {
        pushUnresolved(ctx, outer, via, {
          expr: token.raw,
          scope,
          name,
          code: 'cycle',
          start: token.start,
          end: token.end,
        });
        out += token.raw;
        continue;
      }
      const value = lookupInScope(scope, name, ctx.scopes);
      if (value === undefined) {
        pushUnresolved(ctx, outer, via, {
          expr: token.raw,
          scope,
          name,
          code: 'missing',
          start: token.start,
          end: token.end,
        });
        out += token.raw;
        continue;
      }
      ctx.used.push({ scope, name });
      out += substituted(ctx, outer, expandAt(value, depth + 1, [...stack, key], ctx, effectiveOuter, [...via, key]));
      continue;
    }

    // Shorthand: check it's not referencing an unknown explicit scope form like `${#Foo#x}`.
    if (resolvedInner.startsWith('#')) {
      const secondHash = resolvedInner.indexOf('#', 1);
      if (secondHash !== -1) {
        const attemptedScope = resolvedInner.slice(1, secondHash);
        const attemptedName = resolvedInner.slice(secondHash + 1);
        pushUnresolved(ctx, outer, via, {
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
      pushUnresolved(ctx, outer, via, { expr: token.raw, name, code: 'missing', start: token.start, end: token.end });
      out += token.raw;
      continue;
    }
    const key = `${found.scope}#${name}`;
    if (stack.includes(key)) {
      pushUnresolved(ctx, outer, via, {
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
    out += substituted(
      ctx,
      outer,
      expandAt(found.value, depth + 1, [...stack, key], ctx, effectiveOuter, [...via, key]),
    );
  }
  return out;
}

/** Options accepted by {@link expand} and {@link expandSendInput}. */
export interface ExpandOptions {
  readonly maxDepth?: number;
  /**
   * XML-escape every substituted value ("Entitize Properties"). Off by default; the
   * send path turns it on only for the envelope, never for headers or the endpoint.
   */
  readonly entitize?: boolean;
}

/** Expands every `${...}` property reference in `text` against `scopes`. */
export function expand(text: string, scopes: PropertyScopes, options?: ExpandOptions): ExpandResult {
  const ctx: ExpandContext = {
    scopes,
    maxDepth: options?.maxDepth ?? DEFAULT_MAX_DEPTH,
    entitize: options?.entitize ?? false,
    unresolved: [],
    used: [],
  };
  const out = expandAt(text, 0, [], ctx, undefined, []);
  const seen = new Set<string>();
  const used = ctx.used.filter(({ scope, name }) => {
    const key = `${scope}#${name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { text: out, unresolved: ctx.unresolved, used };
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

/**
 * Expands the endpoint, envelope, soap action, and every header name/value of a
 * {@link SoapSendInput}. Header *names* are expanded too, so two headers whose names expand to
 * the same string collapse into one entry (last-write-wins, per `Object.entries` insertion
 * order — same as any other JS object key collision).
 *
 * Attachments are expanded as well, in the two places a property can reasonably appear: the
 * display/file name that ends up in `Content-Disposition`, and the path of a file-backed
 * attachment. Content-IDs are left alone — they are generated, not authored.
 */
export function expandSendInput(
  input: SoapSendInput,
  scopes: PropertyScopes,
  options?: ExpandOptions,
): { input: SoapSendInput; unresolved: UnresolvedRef[] } {
  const unresolved: UnresolvedRef[] = [];

  function run(text: string, entitize = false): string {
    const result = expand(text, scopes, { ...options, entitize });
    unresolved.push(...result.unresolved);
    return result.text;
  }

  const endpoint = run(input.endpoint);
  // Only the envelope is entitized: escaping a header value or an endpoint would corrupt it.
  const envelopeXml = run(input.envelopeXml, options?.entitize ?? input.entitize ?? false);
  const soapAction = input.soapAction !== undefined ? run(input.soapAction) : undefined;

  let headers: Record<string, string> | undefined;
  if (input.headers !== undefined) {
    headers = {};
    for (const [name, value] of Object.entries(input.headers)) {
      headers[run(name)] = run(value);
    }
  }

  const attachments = input.attachments?.map((attachment) => ({
    ...attachment,
    name: run(attachment.name),
    source:
      attachment.source.kind === 'path'
        ? { kind: 'path' as const, path: run(attachment.source.path) }
        : attachment.source,
  }));

  // The explicit WS-Addressing fields are user-typed strings just like the endpoint or a
  // header value, and may carry the same `${#Env#…}`/`${#Global#…}` references — so they go
  // through the same scopes rather than reaching the wire verbatim.
  const wsa =
    input.wsa !== undefined
      ? {
          ...input.wsa,
          config: {
            ...input.wsa.config,
            ...(input.wsa.config.to !== undefined ? { to: run(input.wsa.config.to) } : {}),
            ...(input.wsa.config.action !== undefined ? { action: run(input.wsa.config.action) } : {}),
            ...(input.wsa.config.replyTo !== undefined ? { replyTo: run(input.wsa.config.replyTo) } : {}),
            ...(input.wsa.config.from !== undefined ? { from: run(input.wsa.config.from) } : {}),
            ...(input.wsa.config.faultTo !== undefined ? { faultTo: run(input.wsa.config.faultTo) } : {}),
          },
        }
      : undefined;

  return {
    input: {
      ...input,
      endpoint,
      envelopeXml,
      ...(soapAction !== undefined ? { soapAction } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(attachments !== undefined ? { attachments } : {}),
      ...(wsa !== undefined ? { wsa } : {}),
    },
    unresolved,
  };
}
