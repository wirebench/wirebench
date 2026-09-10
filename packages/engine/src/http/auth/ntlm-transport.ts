/**
 * The NTLM three-leg handshake over HTTP. NTLM authenticates the *connection*, so every leg
 * has to travel over one socket: this module opens a dedicated single-connection dispatcher,
 * runs the legs sequentially over it, and closes it again.
 *
 *   leg 1  bare request, the real body   → 200 (no auth needed), or 401 + `WWW-Authenticate: NTLM`
 *   leg 2  Type 1, empty body            → 401 + `WWW-Authenticate: NTLM <Type 2>`
 *   leg 3  Type 3, the real body again   → the final response
 *
 * Leg 1 *is* the caller's real request — most servers never challenge it, so the common
 * case pays for the envelope exactly once. The empty-body optimisation applies only to leg
 * 2, the Type 1 token, which never carries a body of its own; a server that does challenge
 * causes the envelope to cross the wire a second time, on leg 3.
 */

import { randomBytes } from 'node:crypto';
import type { Dispatcher } from 'undici';
import { createSingleConnectionDispatcher } from '../client.js';
import { sendHttp } from '../client.js';
import { headerValue, withoutHeader } from '../headers.js';
import type { HttpExchange, HttpRequest } from '../types.js';
import {
  createType1,
  createType3,
  encodeNtlmAuthorization,
  offersNtlm,
  parseNtlmChallengeHeader,
  parseType2,
  toFileTime,
} from './ntlm.js';

/** The NTLM credentials, as resolved by the caller. The password is never logged or stored. */
export interface NtlmCredentials {
  readonly username: string;
  readonly password: string;
  readonly domain?: string;
  readonly workstation?: string;
}

/** The outcome of {@link ntlmHandshake}: the final exchange plus how it was reached. */
export interface NtlmHandshakeResult {
  /** The exchange of the last leg actually made — its raw capture is the one to surface. */
  readonly http: HttpExchange;
  /** 1 (no challenge), 2 (challenge without a usable Type 2) or 3 (full handshake). */
  readonly attempts: 1 | 2 | 3;
  /** True once the server answered any leg with an NTLM challenge. */
  readonly challenged: boolean;
  /** The summed wall time of every leg, so a handshake reports its true cost. */
  readonly durationMs: number;
}

const EMPTY_BODY = new Uint8Array(0);

/** Injection points for tests: the clock, the client nonce and the timestamp in the NTLMv2 blob. */
export interface NtlmHandshakeOptions {
  readonly now?: () => number;
  /** The 8-byte client challenge; random when omitted. */
  readonly clientChallenge?: Uint8Array;
  /** The NTLMv2 blob timestamp as a Windows FILETIME; `now()` when omitted. */
  readonly timestamp?: bigint;
  /**
   * A dispatcher to run the legs on instead of a freshly created single-connection one.
   * Only tests pass this; it is the caller's to close.
   */
  readonly dispatcher?: Dispatcher;
}

/**
 * Runs the NTLM handshake for `request` and returns the final exchange.
 *
 * All legs share the one `request.timeoutMs` budget (each leg gets what is left of it) and
 * the caller's `AbortSignal`; a budget already spent stops the handshake and reports the
 * last exchange as it stands, rather than firing a leg doomed to time out immediately.
 * A 401 from the final leg (a wrong password, typically) is returned as a normal exchange,
 * not thrown.
 *
 * @param request the fully-built request, including the real body for the final leg
 * @param credentials the NTLM account to authenticate as
 * @param options injected clock/nonce/dispatcher, for deterministic tests
 */
export async function ntlmHandshake(
  request: HttpRequest,
  credentials: NtlmCredentials,
  options?: NtlmHandshakeOptions,
): Promise<NtlmHandshakeResult> {
  const now = options?.now ?? Date.now;
  const startedAt = now();
  const budgetMs = request.timeoutMs;
  const remaining = (): number => budgetMs - (now() - startedAt);

  let ownDispatcher: Dispatcher | undefined;
  let dispatcher = options?.dispatcher;
  if (dispatcher === undefined) {
    ownDispatcher = createSingleConnectionDispatcher({
      ...(request.tls !== undefined ? { tls: request.tls } : {}),
      ...(request.proxy !== undefined ? { proxy: request.proxy } : {}),
      ...(request.localAddress !== undefined ? { localAddress: request.localAddress } : {}),
    });
    dispatcher = ownDispatcher;
  }
  const sendOptions = { dispatcher, ...(options?.now !== undefined ? { now: options.now } : {}) };

  let durationMs = 0;
  const leg = async (headers: Readonly<Record<string, string>>, body: Uint8Array): Promise<HttpExchange> => {
    const exchange = await sendHttp({ ...request, headers, body, timeoutMs: Math.max(1, remaining()) }, sendOptions);
    durationMs += exchange.timings.totalMs;
    return exchange;
  };

  try {
    // Leg 1: the real request, real body. A server that needs no auth answers here and we
    // are done — the envelope has already made it, so nothing is resent.
    const first = await leg(request.headers, request.body ?? EMPTY_BODY);
    if (first.status !== 401 || !offersNtlm(headerValue(first.headers, 'www-authenticate'))) {
      return { http: first, attempts: 1, challenged: false, durationMs };
    }
    if (remaining() <= 0) {
      return { http: first, attempts: 1, challenged: true, durationMs };
    }

    // Leg 2: the Type 1 negotiate message, bodyless. Strip any content-encoding/length
    // that described leg 1's body — a gzip-declared zero-length body can trip up a strict
    // server — the server answers with its Type 2 challenge.
    const type1 = createType1({
      ...(credentials.domain !== undefined ? { domain: credentials.domain } : {}),
      ...(credentials.workstation !== undefined ? { workstation: credentials.workstation } : {}),
    });
    const type1Headers = withoutHeader(
      withoutHeader({ ...request.headers, Authorization: encodeNtlmAuthorization(type1) }, 'content-encoding'),
      'content-length',
    );
    const second = await leg(type1Headers, EMPTY_BODY);
    const challengeBytes = parseNtlmChallengeHeader(headerValue(second.headers, 'www-authenticate'));
    if (challengeBytes === undefined || remaining() <= 0) {
      return { http: second, attempts: 2, challenged: true, durationMs };
    }

    // Leg 3: the Type 3 authenticate message, this time carrying the real body.
    const type2 = parseType2(challengeBytes);
    const type3 = createType3({
      username: credentials.username,
      password: credentials.password,
      ...(credentials.domain !== undefined ? { domain: credentials.domain } : {}),
      ...(credentials.workstation !== undefined ? { workstation: credentials.workstation } : {}),
      type2,
      clientChallenge: options?.clientChallenge ?? new Uint8Array(randomBytes(8)),
      timestamp: options?.timestamp ?? toFileTime(now()),
    });
    const third = await leg(
      { ...request.headers, Authorization: encodeNtlmAuthorization(type3.message) },
      request.body ?? EMPTY_BODY,
    );
    return { http: third, attempts: 3, challenged: true, durationMs };
  } finally {
    if (ownDispatcher !== undefined) await ownDispatcher.close().catch(() => undefined);
  }
}
