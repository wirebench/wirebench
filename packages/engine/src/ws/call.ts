/**
 * Turns a saved WebSocket request, plus the API it belongs to and the credentials the host has
 * already resolved, into the options `openWsSession` takes. Everything here is pure: no socket is
 * opened, nothing is read from disk or the keychain — that is `apiHeaders`, `material.auth` and
 * friends, all handed in already resolved.
 *
 * Layering, in order: API headers first, then the request's own headers (which override the API's
 * by case-insensitive name), then auth (which overrides both). An API key configured "in query"
 * lands in the URL's query string, exactly where REST puts it — `resolveWsUrl` appends it after
 * the request's own query rows.
 */

import type { SendAuth } from '../types.js';
import { applyAuth } from '../rest/auth.js';
import type { KeyValueEntry } from '../rest/model.js';
import type { ProxyOptions, TlsOptions } from '../http/types.js';
import { WsError } from '../errors.js';
import { resolveWsUrl } from './url.js';
import type { WsSessionOptions } from './session.js';
import type { WsCallInput } from './expand.js';

export type { WsCallInput } from './expand.js';

/**
 * Handshake header names undici either refuses or silently mangles when a caller sets them
 * itself: `sec-websocket-key`/`-version` end up sent *twice* (the caller's value and undici's own,
 * comma-joined on the wire — confirmed against `startTestWsServer`, which then sees a malformed
 * `Sec-WebSocket-Version: 99, 13`), `upgrade`/`connection` collide with the ones undici sets to
 * open the connection, and `sec-websocket-protocol` as a plain header does nothing at all — undici
 * only negotiates a subprotocol through its own `protocols` option, which `subprotocols` here
 * becomes. Dropping these rather than throwing keeps a pasted-in header harmless instead of fatal;
 * `sec-websocket-accept` is included for the same reason though it only ever appears in a
 * response, never a request.
 *
 * Exported for the unit test only — not part of the package's public surface.
 */
export const FORBIDDEN_HANDSHAKE_HEADERS: ReadonlySet<string> = new Set([
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-accept',
  'sec-websocket-protocol',
  'upgrade',
  'connection',
  'host',
]);

/** Merges header rows by case-insensitive name, later rows overriding earlier ones. */
function mergeHeaders(...layers: readonly (readonly KeyValueEntry[])[]): Record<string, string> {
  const byLowerName = new Map<string, { readonly name: string; readonly value: string }>();
  for (const layer of layers) {
    for (const row of layer) {
      if (!row.enabled || row.name === '') continue;
      byLowerName.set(row.name.toLowerCase(), { name: row.name, value: row.value });
    }
  }
  const result: Record<string, string> = {};
  for (const { name, value } of byLowerName.values()) {
    if (FORBIDDEN_HANDSHAKE_HEADERS.has(name.toLowerCase())) continue;
    result[name] = value;
  }
  return result;
}

/** What {@link toWsSessionOptions} additionally accepts beyond the call's own fields. */
export interface WsSessionMaterial {
  readonly auth: SendAuth;
  readonly tls?: TlsOptions;
  readonly proxy?: ProxyOptions;
  readonly signal?: AbortSignal;
}

/** Credentials resolved into the header (or headers) they become on the wire. */
function authHeadersAndQuery(auth: SendAuth): {
  readonly headers: Record<string, string>;
  readonly query: readonly KeyValueEntry[];
} {
  if (auth.type === 'ntlm') {
    throw new WsError(
      'ws-auth-unsupported',
      'NTLM authenticates a connection over several HTTP round trips, which a single WebSocket handshake cannot do. Use Basic, Bearer, an API key, or OAuth2 instead.',
      { details: { type: auth.type } },
    );
  }
  if (auth.type === 'basic') {
    // `rest/auth.ts`'s `applyAuth` deliberately leaves Basic to the HTTP transport's challenge
    // flow, because a REST send can retry after a 401. A WebSocket handshake gets exactly one
    // request, so there is no challenge to wait for: the header goes straight on, same as REST's
    // "preemptive" Basic.
    const encoded = Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64');
    return { headers: { Authorization: `Basic ${encoded}` }, query: [] };
  }
  const applied = applyAuth(auth);
  return { headers: { ...applied.headers }, query: applied.query };
}

/**
 * Builds the options `openWsSession` takes from a saved request: URL resolution, header merging,
 * auth, and the request's own transport settings. The project/preference settings ladder (trust
 * store, bind address, timeouts inherited from higher up) is a desktop concern handled later —
 * this reads only `input.request.settings`.
 *
 * @throws WsError `ws-auth-unsupported` for NTLM.
 * @throws WsError `ws-bad-url` (via `resolveWsUrl`) for a URL that cannot be resolved.
 */
export function toWsSessionOptions(input: WsCallInput, material: WsSessionMaterial): WsSessionOptions {
  const { headers: authHeaders, query: authQuery } = authHeadersAndQuery(material.auth);
  const query = [...input.request.query, ...authQuery];
  const url = resolveWsUrl(input.serverUrl, input.request.url, query);
  const headers = mergeHeaders(input.apiHeaders, input.request.headers, [
    ...Object.entries(authHeaders).map(([name, value]) => ({ name, value, enabled: true })),
  ]);

  const settings = input.request.settings;
  const tls: TlsOptions | undefined =
    settings.trustInvalid === true ? { ...material.tls, rejectUnauthorized: false } : material.tls;

  return {
    url,
    headers,
    ...(input.request.subprotocols.length > 0 ? { subprotocols: input.request.subprotocols } : {}),
    ...(tls !== undefined ? { tls } : {}),
    ...(material.proxy !== undefined ? { proxy: material.proxy } : {}),
    ...(settings.bindAddress !== undefined ? { localAddress: settings.bindAddress } : {}),
    ...(settings.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: settings.handshakeTimeoutMs } : {}),
    ...(settings.maxMessageBytes !== undefined ? { maxMessageBytes: settings.maxMessageBytes } : {}),
    ...(material.signal !== undefined ? { signal: material.signal } : {}),
  };
}
