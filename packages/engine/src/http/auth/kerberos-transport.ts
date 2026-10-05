/**
 * Kerberos over HTTP Negotiate, Kerberos mechanism only (#40, R4). Two legs at most, on one
 * connection, as NTLM's are, because IIS ties an authenticated session to its socket:
 *
 *   leg 1  the real request, bare      → anything but 401 + Negotiate: that is the result
 *   leg 2  Authorization: Negotiate <token>, the real body again → the final response; a
 *          `WWW-Authenticate: Negotiate <reply>` on it is verified (mutual auth)
 *
 * The token is only made once the server asks, so an unchallenged send never loads the binding.
 * `preemptive` skips leg 1: an AP-REQ stands on its own, which an NTLM message does not.
 */

import type { Dispatcher } from 'undici';
import { HttpError } from '../../errors.js';
import { createSingleConnectionDispatcher, sendHttp } from '../client.js';
import { headerValue } from '../headers.js';
import type { HttpExchange, HttpRequest } from '../types.js';
import { defaultSpn, startKerberosContext, type KerberosSendAuth } from './kerberos-token.js';

export interface KerberosHandshakeResult {
  readonly http: HttpExchange;
  readonly attempts: 1 | 2;
  readonly challenged: boolean;
  readonly durationMs: number;
  /** The SPN asked for; before a token is made, the default in its written form. */
  readonly spn: string;
}

const EMPTY_BODY = new Uint8Array(0);

/** True when any challenge in the header is `Negotiate`, with or without a token. */
export function offersNegotiate(header: string | undefined): boolean {
  return header !== undefined && header.split(',').some((part) => /^\s*Negotiate(\s|$)/i.test(part));
}

/** The token in a `Negotiate <token>` challenge or reply, if there is one. */
export function negotiateToken(header: string | undefined): Uint8Array | undefined {
  for (const part of header?.split(',') ?? []) {
    const match = /^\s*Negotiate\s+([A-Za-z0-9+/=]+)\s*$/i.exec(part);
    if (match?.[1] !== undefined) return Buffer.from(match[1], 'base64');
  }
  return undefined;
}

export async function kerberosHandshake(
  request: HttpRequest,
  auth: KerberosSendAuth,
  options: { readonly now?: () => number; readonly dispatcher?: Dispatcher; readonly preemptive?: boolean } = {},
): Promise<KerberosHandshakeResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const remaining = (): number => request.timeoutMs - (now() - startedAt);
  const spnWanted = auth.spn ?? defaultSpn(request.url);

  let ownDispatcher: Dispatcher | undefined;
  let dispatcher = options.dispatcher;
  if (dispatcher === undefined) {
    ownDispatcher = createSingleConnectionDispatcher({
      ...(request.tls !== undefined ? { tls: request.tls } : {}),
      ...(request.proxy !== undefined ? { proxy: request.proxy } : {}),
      ...(request.localAddress !== undefined ? { localAddress: request.localAddress } : {}),
    });
    dispatcher = ownDispatcher;
  }
  const sendOptions = { dispatcher, ...(options.now !== undefined ? { now: options.now } : {}) };
  let durationMs = 0;
  const leg = async (headers: Readonly<Record<string, string>>): Promise<HttpExchange> => {
    const exchange = await sendHttp(
      { ...request, headers, body: request.body ?? EMPTY_BODY, timeoutMs: Math.max(1, remaining()) },
      sendOptions,
    );
    durationMs += exchange.timings.totalMs;
    return exchange;
  };

  try {
    let challenged = false;
    if (options.preemptive !== true) {
      const first = await leg(request.headers);
      if (first.status !== 401 || !offersNegotiate(headerValue(first.headers, 'www-authenticate'))) {
        return { http: first, attempts: 1, challenged: first.status === 401, durationMs, spn: spnWanted };
      }
      challenged = true;
      if (remaining() <= 0) return { http: first, attempts: 1, challenged, durationMs, spn: spnWanted };
    }

    const context = await startKerberosContext(spnWanted, auth);
    const final = await leg({ ...request.headers, Authorization: `Negotiate ${Buffer.from(context.token).toString('base64')}` });
    if (final.status === 401) {
      throw new HttpError('kerberos-rejected', `The server refused the Kerberos token for ${context.spn} (HTTP 401).`, {
        details: { spn: context.spn, status: 401 },
      });
    }
    const reply = negotiateToken(headerValue(final.headers, 'www-authenticate'));
    if (reply !== undefined) await context.verify(reply);
    return { http: final, attempts: options.preemptive === true ? 1 : 2, challenged, durationMs, spn: context.spn };
  } finally {
    if (ownDispatcher !== undefined) await ownDispatcher.close().catch(() => undefined);
  }
}
