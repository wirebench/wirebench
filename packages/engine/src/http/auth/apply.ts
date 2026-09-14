/**
 * Sending one request with credentials that may need a round trip of their own.
 *
 * Basic can be preemptive or answer a 401 challenge; NTLMv2 needs three legs on one connection.
 * Both are transport concerns rather than protocol ones, so this module owns them for every
 * protocol: the SOAP send and the REST send call it instead of each implementing the same flow.
 *
 * Every scheme that needs no round trip — a bearer token, an API key, an OAuth2 access token — is
 * applied by its own protocol layer as a plain header or query value and never reaches here.
 */

import type { Dispatcher } from 'undici';
import { sendHttp } from '../client.js';
import { headerValue } from '../headers.js';
import type { HttpExchange, HttpRequest } from '../types.js';
import type { AuthSummary, SendAuth } from '../../types.js';
import { basicAuthorization, isBasicChallenge } from './basic.js';
import { ntlmHandshake } from './ntlm-transport.js';

/** Options for {@link sendWithAuth}: the same hooks `sendHttp` takes, for tests. */
export interface SendWithAuthOptions {
  readonly dispatcher?: Dispatcher;
  readonly now?: () => number;
}

/** What one authenticated send did: the final exchange, and how it got there. */
export interface AuthenticatedExchange {
  readonly http: HttpExchange;
  /** Total time across every leg, which is what the UI shows as the send's duration. */
  readonly durationMs: number;
  /** Absent when there were no credentials to apply. */
  readonly auth?: AuthSummary;
}

/**
 * Sends `request`, applying `auth` if it is a scheme that needs the transport's help.
 *
 * A caller-supplied `Authorization` header is an explicit override and wins: two credentials on one
 * request is never what anyone meant. A Basic credential that is not preemptive is sent bare first
 * and retried once if the server answers with a 401 `Basic` challenge; both attempts share the one
 * timeout budget, so a challenged send cannot take twice as long as the user allowed. When the
 * budget is already spent the 401 is reported as the result rather than retried into a certain
 * timeout.
 */
export async function sendWithAuth(
  request: HttpRequest,
  auth: SendAuth | undefined,
  options?: SendWithAuthOptions,
): Promise<AuthenticatedExchange> {
  const callerAuthorization = headerValue(request.headers, 'authorization') !== undefined;
  const basicAuth = auth?.type === 'basic' && !callerAuthorization ? auth : undefined;
  const ntlmAuth = auth?.type === 'ntlm' && !callerAuthorization ? auth : undefined;

  const headers: Record<string, string> = { ...request.headers };
  if (basicAuth?.preemptive === true) {
    headers.Authorization = basicAuthorization(basicAuth.username, basicAuth.password);
  }
  const firstRequest: HttpRequest = { ...request, headers };

  const now = options?.now ?? Date.now;
  const startedAt = now();
  let http: HttpExchange;
  let durationMs: number;
  let challenged = false;
  let attempts: 1 | 2 | 3 = 1;

  if (ntlmAuth !== undefined) {
    // NTLM owns the whole exchange: three legs on one connection, its own dispatcher.
    const handshake = await ntlmHandshake(firstRequest, ntlmAuth, {
      ...(options?.now !== undefined ? { now: options.now } : {}),
      ...(options?.dispatcher !== undefined ? { dispatcher: options.dispatcher } : {}),
    });
    http = handshake.http;
    durationMs = handshake.durationMs;
    challenged = handshake.challenged;
    attempts = handshake.attempts;
  } else {
    http = await sendHttp(firstRequest, options);
    durationMs = http.timings.totalMs;
  }

  if (basicAuth !== undefined && basicAuth.preemptive !== true && isBasicChallenge(http)) {
    challenged = true;
    const remainingMs = request.timeoutMs - (now() - startedAt);
    if (remainingMs > 0) {
      attempts = 2;
      const retry = await sendHttp(
        {
          ...firstRequest,
          headers: { ...headers, Authorization: basicAuthorization(basicAuth.username, basicAuth.password) },
          timeoutMs: remainingMs,
        },
        options,
      );
      durationMs += retry.timings.totalMs;
      http = retry;
    }
  }

  return {
    http,
    durationMs,
    ...(auth !== undefined ? { auth: { scheme: auth.type, challenged, attempts } } : {}),
  };
}
