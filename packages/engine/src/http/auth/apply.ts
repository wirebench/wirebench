/**
 * Sending one request with credentials that may need a round trip of their own.
 *
 * Basic can be preemptive or answer a 401 challenge; NTLMv2 needs three legs on one connection;
 * Digest answers a challenge, or a remembered nonce straight away. All are transport concerns rather
 * than protocol ones, so this module owns them for every protocol: the SOAP send and the REST send
 * call it instead of each implementing the same flow. Kerberos (Negotiate) is a transport concern
 * too: see `kerberos-transport.ts`. So is AWS Signature v4, which must sign the request exactly as
 * it goes out — URL, merged headers and encoded body — and so is applied here, last.
 *
 * Every scheme that needs no round trip — a bearer token, an API key, an OAuth2 access token — is
 * applied by its own protocol layer as a plain header or query value and never reaches here.
 */

import { randomBytes } from 'node:crypto';
import type { Dispatcher } from 'undici';
import { sendHttp } from '../client.js';
import { headerValue, withoutHeader } from '../headers.js';
import type { HttpExchange, HttpRequest } from '../types.js';
import type { AuthSummary, SendAuth } from './send-auth.js';
import { basicAuthorization, isBasicChallenge, parseWwwAuthenticate } from './basic.js';
import { challengedRequest, withLegOneRedirects } from './challenged-hop.js';
import { digestAuthorization, DigestNonceCache, pickDigestChallenge } from './digest.js';
import { signSigV4 } from './sigv4.js';
import { kerberosHandshake } from './kerberos-transport.js';
import { ntlmHandshake } from './ntlm-transport.js';

/** Options for {@link sendWithAuth}: the same hooks `sendHttp` takes, for tests. */
export interface SendWithAuthOptions {
  readonly dispatcher?: Dispatcher;
  readonly now?: () => number;
  /** The Digest nonces to answer from; the process's own by default. */
  readonly digestNonces?: DigestNonceCache;
  /** Makes a Digest client nonce; random by default. */
  readonly cnonce?: () => string;
}

/** The Digest nonces this process has been issued, by origin: the desktop session's, or one CLI run's. */
const DIGEST_NONCES = new DigestNonceCache();

/** The request target Digest hashes: path and query, as on the request line. */
function requestTarget(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

/** `headers` with `added` set over them, replacing a header of the same name in any case. */
function withHeaders(
  headers: Readonly<Record<string, string>>,
  added: Readonly<Record<string, string>>,
): Record<string, string> {
  let out: Record<string, string> = { ...headers };
  for (const name of Object.keys(added)) out = withoutHeader(out, name);
  return { ...out, ...added };
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
  const kerberosAuth = auth?.type === 'kerberos' && !callerAuthorization ? auth : undefined;
  const sigv4Auth = auth?.type === 'aws-sigv4' && !callerAuthorization ? auth : undefined;
  const digestAuth = auth?.type === 'digest' && !callerAuthorization ? auth : undefined;

  const now = options?.now ?? Date.now;
  const startedAt = now();
  let headers: Record<string, string> = { ...request.headers };
  let firstRequest: HttpRequest = request;
  let signature: AuthSummary['signature'];
  if (basicAuth?.preemptive === true) {
    headers.Authorization = basicAuthorization(basicAuth.username, basicAuth.password);
  }
  if (sigv4Auth !== undefined) {
    // Signed over the URL as the transport serializes it, so the server reads the path that was signed.
    const signed = signSigV4(
      {
        method: request.method,
        url: new URL(request.url).href,
        headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
      },
      sigv4Auth,
      {
        now: startedAt,
        placement: sigv4Auth.placement,
        ...(sigv4Auth.expiresSeconds !== undefined ? { expiresSeconds: sigv4Auth.expiresSeconds } : {}),
      },
    );
    headers = withHeaders(headers, signed.headers);
    signature = { canonicalRequest: signed.canonicalRequest, stringToSign: signed.stringToSign };
    const presigned = [...new URL(signed.url).searchParams].filter(([name]) => name.startsWith('X-Amz-'));
    firstRequest = {
      ...request,
      url: signed.url,
      // The session token and a presigned URL's parameters are this origin's credentials, as an API key is.
      originCredentials: {
        headers: [
          ...(request.originCredentials?.headers ?? []),
          ...(sigv4Auth.sessionToken !== undefined && sigv4Auth.placement === 'header' ? ['X-Amz-Security-Token'] : []),
        ],
        query: [
          ...(request.originCredentials?.query ?? []),
          ...(sigv4Auth.placement === 'query' ? presigned.map(([name, value]) => ({ name, value })) : []),
        ],
      },
    };
  }
  const digestNonces = options?.digestNonces ?? DIGEST_NONCES;
  const cnonce = options?.cnonce ?? (() => randomBytes(16).toString('hex'));
  const remembered = digestAuth !== undefined ? digestNonces.next(new URL(request.url).origin) : undefined;
  if (digestAuth !== undefined && remembered !== undefined) {
    headers.Authorization = digestAuthorization({
      username: digestAuth.username,
      password: digestAuth.password,
      method: request.method,
      uri: requestTarget(request.url),
      challenge: remembered.challenge,
      nc: remembered.nc,
      cnonce: cnonce(),
    });
  }
  firstRequest = { ...firstRequest, headers };

  let http: HttpExchange;
  let durationMs: number;
  let challenged = false;
  let attempts: 1 | 2 | 3 = 1;
  let spn: string | undefined;

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
  } else if (kerberosAuth !== undefined) {
    // Kerberos owns its exchange too: at most two legs on one connection, its own dispatcher.
    const handshake = await kerberosHandshake(firstRequest, kerberosAuth, {
      ...(options?.now !== undefined ? { now: options.now } : {}),
      ...(options?.dispatcher !== undefined ? { dispatcher: options.dispatcher } : {}),
    });
    http = handshake.http;
    durationMs = handshake.durationMs;
    challenged = handshake.challenged;
    attempts = handshake.attempts;
    spn = handshake.spn;
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

  if (digestAuth !== undefined && http.status === 401) {
    const challenge = pickDigestChallenge(parseWwwAuthenticate(headerValue(http.headers, 'www-authenticate')));
    if (challenge !== undefined) {
      challenged = true;
      // A remembered nonce that drew a 401 for the same nonce, not stale, means the credentials are wrong.
      const answer = remembered === undefined || challenge.stale || challenge.nonce !== remembered.challenge.nonce;
      const remainingMs = request.timeoutMs - (now() - startedAt);
      if (answer && remainingMs > 0) {
        const target = challengedRequest(firstRequest, http, 'digest');
        const origin = new URL(target.url).origin;
        digestNonces.remember(origin, challenge);
        const nc = digestNonces.next(origin)?.nc ?? 1;
        attempts = 2;
        const retry = await sendHttp(
          {
            ...target,
            headers: withHeaders(target.headers, {
              Authorization: digestAuthorization({
                username: digestAuth.username,
                password: digestAuth.password,
                method: target.method,
                uri: requestTarget(target.url),
                challenge,
                nc,
                cnonce: cnonce(),
              }),
            }),
            timeoutMs: remainingMs,
          },
          options,
        );
        durationMs += retry.timings.totalMs;
        http = withLegOneRedirects(retry, http);
      }
    }
  }

  return {
    http,
    durationMs,
    ...(auth !== undefined
      ? {
          auth: {
            scheme: auth.type,
            challenged,
            attempts,
            ...(spn !== undefined ? { spn } : {}),
            ...(signature !== undefined ? { signature } : {}),
          },
        }
      : {}),
  };
}
