/**
 * Deterministic, readable namespace prefixes for generated SOAP envelopes.
 *
 * The established convention names a namespace after a short mnemonic taken from its URI
 * (`http://tempuri.org/` → `tem`), which reads far better in a hand-edited
 * request than `ns1`. This module reproduces that convention from the URI
 * alone, without ever colliding with the prefixes the envelope reserves.
 */

/** Prefixes an envelope always owns; a mnemonic never takes one of these. */
export const RESERVED_PREFIXES: readonly string[] = ['soapenv', 'soapenc', 'xsi', 'xsd', 'xs', 'xml', 'xmlns'];

/** The mnemonic length: three letters, per the convention. */
const MNEMONIC_LENGTH = 3;

/**
 * Picks the "most meaningful" token of a namespace URI: the last non-empty
 * path segment of an http(s) URL, else the URL's host without a leading
 * `www.`, else the last non-empty `:`-separated token of a URN.
 */
function meaningfulToken(uri: string): string {
  const trimmed = uri.trim();
  const schemeSplit = trimmed.indexOf('://');
  if (schemeSplit === -1) {
    // A URN (or anything else without an authority): `urn:wb:common` → `common`.
    const parts = trimmed.split(':').filter((part) => part.length > 0);
    return parts.length === 0 ? '' : (parts[parts.length - 1] ?? '');
  }
  const rest = trimmed.slice(schemeSplit + 3);
  const slash = rest.indexOf('/');
  const host = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash + 1);
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments.length > 0) {
    return segments[segments.length - 1] ?? '';
  }
  const hostLabels = host.replace(/^www\./i, '').split('.');
  return hostLabels[0] ?? '';
}

/** Reduces a token to letters and digits, keeping only its first dotted part. */
function mnemonicOf(token: string): string {
  const firstPart = token.split('.')[0] ?? '';
  const letters = firstPart.toLowerCase().replace(/[^a-z0-9]/g, '');
  // A prefix is an NCName, so it can never start with a digit; a token with
  // nothing but digits left yields no mnemonic at all.
  return letters.replace(/^[0-9]+/, '').slice(0, MNEMONIC_LENGTH);
}

/**
 * Derives a short, readable prefix for `uri` that is not already in `taken`.
 *
 * The mnemonic is the first three letters of the URI's most meaningful token
 * (`http://tempuri.org/` → `tem`, `http://www.dataaccess.com/webservicesserver/`
 * → `web`, `urn:wb:common` → `com`). A mnemonic that is empty, or that would
 * collide with a reserved or already-taken prefix, is disambiguated with a
 * numeric suffix (`web`, `web1`, `web2`, …). `ns1`, `ns2`, … is the fallback
 * when no mnemonic can be derived at all.
 *
 * Pure and deterministic: the same URI and `taken` set always yield the same
 * prefix. The returned prefix is **not** added to `taken`; callers own that.
 */
export function prefixForNamespace(uri: string, taken: ReadonlySet<string>): string {
  const base = mnemonicOf(meaningfulToken(uri));
  if (base.length > 0 && !taken.has(base) && !RESERVED_PREFIXES.includes(base)) {
    return base;
  }
  const stem = base.length > 0 ? base : 'ns';
  for (let counter = 1; ; counter += 1) {
    const candidate = `${stem}${counter}`;
    if (!taken.has(candidate) && !RESERVED_PREFIXES.includes(candidate)) {
      return candidate;
    }
  }
}
