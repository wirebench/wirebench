/**
 * What a `.http` file and its environment files share about a value: the template rewrite, the
 * "references only" test that decides whether a credential-named value may stay in a project, and
 * the cut of literal user info from a URL. Pure, and free of Node.
 */

import { rewriteMustache } from '../../import/templates.js';

/** Collects what a rewrite kept as written, for the importer's report. */
export interface HttpRewriteContext {
  /** Dynamic `{{$name}}` variables. */
  readonly dynamic: Set<string>;
  /** Request-chaining `{{name.response…}}` references. */
  readonly chained: Set<string>;
}

export function newRewriteContext(): HttpRewriteContext {
  return { dynamic: new Set(), chained: new Set() };
}

const PROCESS_ENV = /\{\{\s*\$processEnv\s+([A-Za-z_]\w*)\s*\}\}/g;
const CHAINING = /\{\{\s*[\w-]+\.(?:response|request)\.[^{}]*\}\}/g;
/**
 * One reference: a `${…}` property, or a `{{…}}` kept as written (request chaining, a dynamic
 * variable). Either names a value held elsewhere, so neither is a literal to keep out of the project.
 */
export const REFERENCE = String.raw`(?:\$\{[^{}]+\}|\{\{[^{}]*\}\})`;
/** A value made of references and nothing else. */
const REFERENCES_ONLY = new RegExp(String.raw`^\s*(?:${REFERENCE}\s*)+$`);
/**
 * A URL's `scheme://` and the user info up to the last `@` before the path, as a URL parser cuts
 * it; the user info may hold references, and an `@` of its own.
 */
export const USERINFO = new RegExp(String.raw`^([a-z][\w+.-]*://)((?:${REFERENCE}|[^/?#{}])*)@`, 'i');
/** The same without a scheme, for a variable that holds a URL's authority (`u:pw@host`). */
const BARE_USERINFO = new RegExp(String.raw`^()((?:${REFERENCE}|[^/?#{}\s])*)@`);
/** A value that looks like `user:password@host`: user info with a password, and no scheme. */
const BARE_AUTHORITY = /^[^/?#\s:@]*:[^/?#\s]*@[^/?#\s]/;
/** User info made of references, with at most one `:` between them. */
const USERINFO_REFERENCES = new RegExp(String.raw`^(?:${REFERENCE})+(?::(?:${REFERENCE})+)?$`);

/**
 * Rewrites a `.http` value: `{{$processEnv X}}` → `${#System#X}`, request chaining kept as written
 * (and collected), then `{{x}}` → `${x}`, dynamic `{{$x}}` kept as written (and collected).
 */
export function rewriteHttpValue(text: string, ctx: HttpRewriteContext): string {
  const kept: string[] = [];
  const shielded = text
    .replace(PROCESS_ENV, (_m, name: string) => `\u0000S${name}\u0000`)
    .replace(CHAINING, (m) => {
      ctx.chained.add(m);
      kept.push(m);
      return `\u0000C${kept.length - 1}\u0000`;
    });
  return rewriteMustache(shielded, ctx.dynamic)
    .replace(/\u0000S(\w+)\u0000/g, (_m, name: string) => `\${#System#${name}}`)
    .replace(/\u0000C(\d+)\u0000/g, (_m, i: string) => kept[Number(i)] ?? '');
}

/** True when `value` (already rewritten) is made of references and nothing else. */
export function referencesOnly(value: string): boolean {
  return REFERENCES_ONLY.test(value);
}

/** True when `value` has no scheme but looks like `user:password@host`. */
export function looksLikeBareAuthority(value: string): boolean {
  return !USERINFO.test(value) && BARE_AUTHORITY.test(value);
}

/**
 * `url` without literal user info. User info made only of references stays; otherwise it is cut,
 * and its user name (the part before `:`) handed back so the caller can set Basic auth. With
 * `bare`, `url` is read as an authority with no scheme.
 */
export function stripUserinfo(url: string, bare = false): { url: string; stripped: boolean; username?: string } {
  const match = (bare ? BARE_USERINFO : USERINFO).exec(url);
  if (!match) return { url, stripped: false };
  const [whole, scheme = '', userinfo = ''] = match;
  if (USERINFO_REFERENCES.test(userinfo)) return { url, stripped: false };
  const colon = userinfo.indexOf(':');
  const username = colon === -1 ? userinfo : userinfo.slice(0, colon);
  return { url: scheme + url.slice(whole.length), stripped: true, ...(username !== '' ? { username } : {}) };
}
