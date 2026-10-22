/**
 * The headers of one REST send, as rows: each with where it came from and whether it goes out.
 *
 * `sendRest` builds its header map from these rows and the Headers tab's preview shows them, so the
 * two read one merge and cannot disagree about what goes on the wire (spec
 * `2026-10-11-generated-headers-preview-design.md`).
 */

import type { SendAuth } from '#core/http/auth/send-auth';
import type { KeyValueEntry } from './model.js';

/**
 * Where a header comes from. The first five are merged here; `transport` (`Host`, `Content-Length`)
 * and `handshake` (an `Authorization` only a challenge round trip sends) are added by the preview.
 */
export type RestHeaderSource = 'preference' | 'auth' | 'body' | 'cookie' | 'typed' | 'transport' | 'handshake';

/**
 * What happens to a header: it goes out, a higher layer (usually a typed header) replaces it, the
 * request's `omitHeaders` leaves it out, or — for the cookie jar's `Cookie` — it is combined with a
 * typed `Cookie`.
 */
export type RestHeaderState = 'sent' | 'overridden' | 'omitted' | 'merged';

/** One header of a REST send. */
export interface RestHeaderRow {
  readonly name: string;
  readonly value: string;
  readonly source: RestHeaderSource;
  readonly state: RestHeaderState;
}

/** The layers {@link restHeaderRows} merges, lowest first. */
export interface RestHeaderLayers {
  /** The host's defaults from the preferences: `User-Agent`, `Accept`, `Accept-Encoding`, `Connection`. */
  readonly defaults: Readonly<Record<string, string>>;
  /** What the credentials put on the request (`applyAuth`'s headers). */
  readonly auth: Readonly<Record<string, string>>;
  /** The `Content-Type` the encoded body declares. */
  readonly contentType?: string | undefined;
  /** A `Cookie` built from a cookie list (a send without a jar). */
  readonly cookie?: string | undefined;
  /** The request's own header table. */
  readonly typed: readonly KeyValueEntry[];
  /** Generated headers the request leaves out, by name, case-insensitive. Never a typed one. */
  readonly omit?: readonly string[] | undefined;
}

/** True when `omit` names `name`, case-insensitively. */
export function isOmitted(omit: readonly string[] | undefined, name: string): boolean {
  const key = name.toLowerCase();
  return omit?.some((omitted) => omitted.toLowerCase() === key) === true;
}

/**
 * True when an omitted `Authorization` drops this credential: a preemptive Basic one, whose header the
 * transport adds before the first attempt. A challenge-based credential is not a header to switch off.
 */
export function omittedBasic(transport: SendAuth | undefined, omit: readonly string[] | undefined): boolean {
  return transport?.type === 'basic' && transport.preemptive && isOmitted(omit, 'Authorization');
}

/**
 * Every header of the send, generated layers first and typed last.
 *
 * A typed header always wins — a user who typed a `Content-Type` meant it, even when the body kind
 * implies another — and a repeated typed name is joined with `, `, which RFC 9110 §5.3 says a
 * recipient must treat as two headers. Among the generated layers a higher one replaces a lower one
 * of the same name.
 */
export function restHeaderRows(layers: RestHeaderLayers): RestHeaderRow[] {
  const generated: { name: string; value: string; source: RestHeaderSource }[] = [
    ...Object.entries(layers.defaults).map(([name, value]) => ({ name, value, source: 'preference' as const })),
    ...Object.entries(layers.auth).map(([name, value]) => ({ name, value, source: 'auth' as const })),
    ...(layers.contentType !== undefined
      ? [{ name: 'Content-Type', value: layers.contentType, source: 'body' as const }]
      : []),
    ...(layers.cookie !== undefined ? [{ name: 'Cookie', value: layers.cookie, source: 'cookie' as const }] : []),
  ];

  const typed: { name: string; value: string }[] = [];
  for (const header of layers.typed) {
    if (!header.enabled || header.name === '') continue;
    const key = header.name.toLowerCase();
    const index = typed.findIndex((row) => row.name.toLowerCase() === key);
    const previous = typed[index];
    if (previous === undefined) {
      typed.push({ name: header.name, value: header.value });
    } else {
      typed[index] = { name: header.name, value: `${previous.value}, ${header.value}` };
    }
  }
  const typedNames = new Set(typed.map((row) => row.name.toLowerCase()));

  const rows: RestHeaderRow[] = generated.map((row, index) => {
    const key = row.name.toLowerCase();
    const replacedAbove = generated.slice(index + 1).some((later) => later.name.toLowerCase() === key);
    const state: RestHeaderState = typedNames.has(key)
      ? 'overridden'
      : isOmitted(layers.omit, row.name)
        ? 'omitted'
        : replacedAbove
          ? 'overridden'
          : 'sent';
    return { ...row, state };
  });
  return [...rows, ...typed.map((row) => ({ ...row, source: 'typed' as const, state: 'sent' as const }))];
}

/** The header map a send puts on the request: every row that is `sent`. */
export function headersOfRows(rows: readonly RestHeaderRow[]): Record<string, string> {
  return Object.fromEntries(rows.filter((row) => row.state === 'sent').map((row) => [row.name, row.value]));
}
