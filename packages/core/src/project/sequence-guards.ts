/**
 * The checks ADR-0015 puts on `${#Sequence#…}` values wherever a request is expanded: text a server
 * chose may be escaped into a body, but it may never pick where the request goes, and it may never
 * carry a line break or NUL into a URL, a header or metadata. Each per-protocol expander calls these
 * only when the scopes hold Sequence values, so a send outside a sequence pays nothing.
 */

import { randomUUID } from 'node:crypto';
import { SequenceError } from '../errors.js';
import type { PropertyMap } from './model.js';
import type { ExpandResult, PropertyScopes } from './properties.js';

/** What every Sequence value becomes in the comparison expansion: plain, host-safe, unlikely to be real. */
const MARKER = 'wbseq';

/** CR, LF and NUL: what splits a header or a request line. */
const CONTROL_CHARACTERS = /[\r\n\0]/;

/** True when `scopes` carry at least one Sequence value, which is when the guards apply. */
export function hasSequenceValues(scopes: PropertyScopes): boolean {
  return scopes.sequence !== undefined && Object.keys(scopes.sequence).length > 0;
}

function mapValues(map: PropertyMap, transform: (value: string) => string): PropertyMap {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(map)) {
    out[name] = transform(value);
  }
  return out;
}

/** Full XML escaping, quotes included, so a value is safe in element text and in an attribute alike. */
export function escapeXmlValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Expands with every Sequence value escaped by `escape` exactly once, wherever it lands and however it
 * is reached, directly or through a chained property.
 *
 * Escaping the Sequence map up front is not enough: a request that escapes its own values would escape
 * a Sequence value a second time. So each value is first replaced by a placeholder no user text can
 * contain (a fresh random nonce per call) and made only of letters and digits, which no escaping
 * touches. `expandText` runs with the request's own escaping, and then each placeholder is swapped
 * for its escaped value.
 */
export function expandWithSequenceEscaped(
  expandText: (scopes: PropertyScopes) => string,
  scopes: PropertyScopes,
  escape: (value: string) => string,
): string {
  if (!hasSequenceValues(scopes) || scopes.sequence === undefined) {
    return expandText(scopes);
  }
  const prefix = `wbseq${randomUUID().replace(/-/g, '')}x`;
  const escaped = new Map<string, string>();
  const placeholders: Record<string, string> = {};
  let index = 0;
  for (const [name, value] of Object.entries(scopes.sequence)) {
    // The trailing `z` ends the index, so placeholder 1 followed by a digit is never read as 15.
    const placeholder = `${prefix}${index++}z`;
    placeholders[name] = placeholder;
    escaped.set(placeholder, escape(value));
  }
  const text = expandText({ ...scopes, sequence: placeholders });
  return text.replace(new RegExp(`${prefix}\\d+z`, 'g'), (placeholder) => escaped.get(placeholder) ?? placeholder);
}

/** The origin of an absolute URL (`scheme://host:port`), or `undefined` when `text` is not one. */
export function urlOrigin(text: string): string | undefined {
  try {
    const url = new URL(text);
    // A non-special scheme (`grpc:`, `ws+unix:`) has an opaque `origin` of "null"; host and port
    // still say where the request goes.
    return url.origin !== 'null' ? url.origin : `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

/**
 * Refuses a send whose destination depends on a Sequence value: `resolve` is expanded once with the
 * real values and once with every Sequence value replaced by a fixed marker, and the two results must
 * have the same origin under `originOf`. A value in the path, query or fragment changes neither;
 * one in the scheme, host or port changes it.
 *
 * @param place what is being sent to, for the message ("The request URL")
 * @param resolve builds the destination text from a set of scopes
 * @param originOf reduces that text to what must not change
 * @throws SequenceError `sequence-origin-from-response`
 */
export function assertOriginIndependent(
  place: string,
  resolve: (scopes: PropertyScopes) => string,
  scopes: PropertyScopes,
  originOf: (text: string) => string | undefined = urlOrigin,
): void {
  if (!hasSequenceValues(scopes) || scopes.sequence === undefined) {
    return;
  }
  const marked = { ...scopes, sequence: mapValues(scopes.sequence, () => MARKER) };
  if (originOf(resolve(scopes)) !== originOf(resolve(marked))) {
    throw new SequenceError(
      'sequence-origin-from-response',
      `${place} would take its scheme, host or port from a value a response supplied; ` +
        'use ${#Sequence#…} only in the path, query or fragment',
      { details: { place } },
    );
  }
}

/**
 * Refuses a Sequence value holding CR, LF or NUL wherever `result` put one: a URL, a header name or
 * value, gRPC metadata, a SOAP action. A body may carry them; a line-oriented place may not.
 *
 * @throws SequenceError `sequence-value-invalid`
 */
export function assertNoControlCharacters(place: string, result: ExpandResult, scopes: PropertyScopes): void {
  if (scopes.sequence === undefined) {
    return;
  }
  for (const { scope, name } of result.used) {
    const value = scope === 'Sequence' && Object.hasOwn(scopes.sequence, name) ? scopes.sequence[name] : undefined;
    if (value !== undefined && CONTROL_CHARACTERS.test(value)) {
      throw new SequenceError(
        'sequence-value-invalid',
        `${place} would carry a line break or NUL from \${#Sequence#${name}}`,
        { details: { place, name } },
      );
    }
  }
}
