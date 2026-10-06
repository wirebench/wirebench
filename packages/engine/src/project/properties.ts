/**
 * Property expansion over the `${#Project#name}`, `${#Env#name}`,
 * `${#Workspace#name}`, `${#Global#name}` and `${#System#name}` syntax, plus
 * the shorthand `${name}` which resolves through the scope chain
 * Env -> Project -> Workspace -> Global (System is never implicit). Values
 * are themselves expanded recursively (cycle-safe, depth limited);
 * unresolved expressions are left verbatim in the output and reported via
 * `unresolved`.
 *
 * `${#Sequence#name}` is the exception: its values come from responses, so
 * they are never expanded again, never reached by the shorthand, and never
 * allowed to form another reference's name (ADR-0015).
 *
 * Pure module: no I/O beyond reading the `scopes.system` map the caller
 * passes in (default `process.env`).
 */

import { entitizeValue } from '../xml/entitize.js';
import { SECRET_NAME_PATTERN } from '../secrets/secret-token.js';
import type { PropertyMap } from './model.js';

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
  /**
   * Told the name of each `${#System#name}` property {@link expand} substitutes, so a host can mask
   * the value it put on the wire (`scopesFor` in `run/context.ts`). Only what an expansion actually
   * reaches is named, never the rest of the environment, and a secret lookup that merely follows
   * references names nothing. A protocol that escapes the scopes keeps this, so the host reads the
   * value from its own map, unescaped.
   */
  readonly onSystemRead?: (name: string) => void;
  /**
   * Secret values keyed by name, for the `${secret:name}` token. Resolved by the caller (main
   * from the keychain-backed store, the CLI from `WIREBENCH_SECRET_<NAME>`) and injected here so
   * expansion itself stays synchronous and pure.
   */
  readonly secrets?: Readonly<Record<string, string>>;
  /**
   * Values a running sequence lifted out of earlier responses, for `${#Sequence#name}`. Text a
   * server chose, so it is held to ADR-0015: substituted literally (never expanded again), reachable
   * only by the explicit form (never by the `${name}` shorthand), and never allowed to name another
   * reference.
   */
  readonly sequence?: PropertyMap;
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
  /**
   * Why the reference stayed unexpanded. `name-from-response`: the reference's own name was built
   * from a `${#Sequence#…}` value, so a server would be choosing which property (or secret) is read.
   */
  readonly code: 'missing' | 'unknown-scope' | 'cycle' | 'too-deep' | 'malformed' | 'name-from-response';
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
const SCOPE_NAMES = new Set(['Project', 'Env', 'Workspace', 'Global', 'System', 'Sequence']);

interface ParsedExpr {
  /** Explicit scope (`Project`/`Env`/`Workspace`/`Global`/`System`/`Sequence`), or undefined for the shorthand form. */
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
  if (inner.startsWith('secret:')) {
    return { scope: 'Secret', name: inner.slice('secret:'.length) };
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
    case 'Sequence':
      return scopes.sequence !== undefined && Object.hasOwn(scopes.sequence, name) ? scopes.sequence[name] : undefined;
    case 'Secret':
      return SECRET_NAME_PATTERN.test(name) ? scopes.secrets?.[name] : undefined;
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
 * value itself expands another property is escaped once rather than once per nesting level. A
 * `${secret:name}` token (`scope` `Secret`) is never escaped itself: its value goes out exactly as
 * it was stored, which for one moved out of an envelope is XML text already.
 */
function substituted(ctx: ExpandContext, outer: OuterSpan | undefined, value: string, scope?: string): string {
  return ctx.entitize && outer === undefined && scope !== 'Secret' ? entitizeValue(value) : value;
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
    const usedBefore = ctx.used.length;
    const resolvedInner = expandAt(token.inner, depth + 1, stack, ctx, effectiveOuter, via);
    if (ctx.used.slice(usedBefore).some((entry) => entry.scope === 'Sequence')) {
      // `${${#Sequence#n}}`: a response value would pick the reference, `secret:…` included.
      pushUnresolved(ctx, outer, via, {
        expr: token.raw,
        code: 'name-from-response',
        start: token.start,
        end: token.end,
      });
      out += token.raw;
      continue;
    }
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
      if (scope === 'System') {
        ctx.scopes.onSystemRead?.(name);
      }
      if (scope === 'Sequence') {
        // Literal: the value came from a response, and expanding it would let a server name any
        // property or secret for the next request to carry back (ADR-0015).
        out += substituted(ctx, outer, value, scope);
        continue;
      }
      out += substituted(
        ctx,
        outer,
        expandAt(value, depth + 1, [...stack, key], ctx, effectiveOuter, [...via, key]),
        scope,
      );
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

/** Options accepted by {@link expand} and by `expandSendInput` in `soap/expand.ts`. */
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

/**
 * The `secret:name` values reached from `text`: every `${secret:name}` token found directly, plus
 * any reached by following `${name}` and `${#Scope#name}` property references whose stored value
 * itself expands (or is) a secret token. Reuses the same tokenizer/lookup helpers as {@link expand},
 * and is cycle-safe the same way (a visited `scope#name` is never revisited on a given path).
 * `scopes` is optional — with none given, only literal `${secret:name}` tokens in `text` are found.
 */
export function secretNamesIn(text: string, scopes?: PropertyScopes): string[] {
  const found = new Set<string>();

  function visit(current: string, stack: readonly string[], depth: number): void {
    if (depth > DEFAULT_MAX_DEPTH) {
      return;
    }
    for (const token of tokenize(current)) {
      if (token.kind !== 'expr') {
        continue;
      }
      const { scope, name } = parseExpr(token.inner);
      if (scope === 'Secret') {
        if (SECRET_NAME_PATTERN.test(name)) {
          found.add(name);
        }
        continue;
      }
      // A Sequence value is substituted literally, so a `${secret:…}` inside one is never resolved.
      if (scopes === undefined || scope === 'Sequence') {
        continue;
      }
      let value: string | undefined;
      let key: string;
      if (scope !== undefined) {
        value = lookupInScope(scope, name, scopes);
        key = `${scope}#${name}`;
      } else {
        const shorthand = lookupShorthand(name, scopes);
        if (shorthand === undefined) {
          continue;
        }
        value = shorthand.value;
        key = `${shorthand.scope}#${name}`;
      }
      if (value === undefined || stack.includes(key)) {
        continue;
      }
      visit(value, [...stack, key], depth + 1);
    }
  }

  visit(text, [], 0);
  return [...found];
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
