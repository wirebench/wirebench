/**
 * What every importer asks of a recorded value before it may stay in a project: whether it is
 * made of references and nothing else, and the cut of literal user info from a URL. Pure, and free
 * of Node.
 */

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
