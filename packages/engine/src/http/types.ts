/**
 * Wire-level types for the HTTP transport (Task 10). These are transport
 * concerns only: no auth, no MIME/SOAP semantics. Auth (Task 49) and WS-Security
 * layer on top by producing headers/body before `sendHttp` is called.
 */

import type { SslInfo } from './tls.js';

/** An HTTP request as fully resolved bytes/headers, ready to send. */
export interface HttpRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'PATCH';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly timeoutMs: number;
  readonly followRedirects: boolean;
  /** Maximum number of redirects to follow. Default 5. */
  readonly maxRedirects?: number;
  /**
   * Keep the method and body across a 301 or 302 that would otherwise become a bodyless `GET`.
   *
   * Browsers downgrade those two, which is why the default does too (RFC 9110 §15.4.3 notes the
   * practice), but a REST client talking to an API that answers a `POST` with a 302 to the created
   * resource needs the choice. 303 always becomes a `GET`: that is what the status means.
   */
  readonly preserveMethodOnRedirect?: boolean;
  /**
   * Credentials the caller put on this request for its own origin only, beyond the `Authorization`,
   * `Proxy-Authorization` and `Cookie` headers every cross-origin hop drops anyway: an API key's
   * custom header, or the query parameter carrying it.
   *
   * On a redirect hop to any other origin the named headers are removed and a parameter with the
   * given name *and* value is stripped from the `Location`, so a server that echoes the key into it
   * cannot pass it on. On a hop back to the original origin they are applied again: the headers
   * with their values as sent on the first request, and the parameter appended when the `Location`
   * does not already carry it.
   */
  readonly originCredentials?: OriginCredentials;
  /** Maximum response body size to buffer, in bytes. Undefined = unlimited. */
  readonly maxSizeBytes?: number;
  readonly signal?: AbortSignal;
  /**
   * Local interface address to bind the outgoing socket to. Passed straight to the connector;
   * an address the host does not own makes the connection fail, which is the intended feedback.
   */
  readonly localAddress?: string;
  readonly tls?: TlsOptions;
  readonly proxy?: ProxyOptions;
  /** Whether to transparently decompress a gzip/deflate/br response body. Default true. */
  readonly decompress?: boolean;
  /**
   * Offer HTTP/2 in the TLS ALPN handshake. Off by default: HTTP/2 changes how headers reach
   * the wire (and so what the raw view can faithfully reconstruct), so it is opt-in. Plain
   * HTTP is always HTTP/1.1 — there is no ALPN to negotiate over.
   */
  readonly allowH2?: boolean;
  /**
   * Opt-in streaming. When set, the final (non-redirect) response is offered to the hook; a sink it
   * returns receives the body as it arrives instead of it being buffered, the request's deadline
   * stops applying once the headers are in, and `maxSizeBytes` does not apply. A hook that returns
   * `undefined` leaves the response buffered exactly as without one.
   */
  readonly stream?: HttpStreamHook;
}

/** What {@link HttpRequest.originCredentials} names: the credential headers and query parameters. */
export interface OriginCredentials {
  /** Header names, matched case-insensitively. */
  readonly headers?: readonly string[];
  /** Query parameters as the caller added them to the URL, before encoding. */
  readonly query?: readonly { readonly name: string; readonly value: string }[];
}

/** Where an accepted stream's body goes, chunk by chunk, already decompressed when `decompress` is on. */
export interface HttpStreamSink {
  onChunk(bytes: Uint8Array): void;
}

/** Decides, from the final response's status and headers, whether its body is streamed. */
export interface HttpStreamHook {
  /** Called once with the final (non-redirect) response; returning a sink switches to streaming. */
  accept(status: number, headers: Readonly<Record<string, string>>): HttpStreamSink | undefined;
}

/**
 * TLS options, passed through to undici's connector. The Task 49 UI will
 * populate these; this task only wires the pass-through.
 */
export interface TlsOptions {
  readonly rejectUnauthorized?: boolean;
  readonly ca?: readonly string[];
  readonly cert?: string;
  readonly key?: string;
  readonly passphrase?: string;
  readonly minVersion?: 'TLSv1.2' | 'TLSv1.3';
  readonly servername?: string;
}

/**
 * Proxy options, passed through to undici's `ProxyAgent`. The Task 49 UI
 * will populate these; this task only wires the pass-through.
 */
export interface ProxyOptions {
  readonly url: string;
  readonly auth?: { readonly username: string; readonly password: string };
}

/** Timing breakdown for one HTTP exchange. Every field but `totalMs` is best-effort. */
export interface Timings {
  readonly startedAt: string;
  readonly totalMs: number;
  readonly dnsMs?: number;
  readonly connectMs?: number;
  readonly tlsMs?: number;
  readonly ttfbMs?: number;
  readonly downloadMs?: number;
}

/** The full record of one HTTP request/response exchange, including raw wire bytes. */
export interface HttpExchange {
  readonly request: {
    readonly url: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
  };
  readonly status: number;
  readonly statusText: string;
  /** Lower-cased header names; multi-values joined with ', ' except `set-cookie`, which keeps only the first. */
  readonly headers: Readonly<Record<string, string>>;
  readonly rawHeaders: readonly (readonly [string, string])[];
  /** Decoded response body (decompressed when `decompress` was requested). */
  readonly body: Uint8Array;
  /** Response body exactly as received on the wire, possibly still compressed. */
  readonly rawBody: Uint8Array;
  /**
   * The protocol the exchange actually travelled over, from the negotiated ALPN: `2` only when
   * the caller offered HTTP/2 and the server took it. Labels the raw view.
   */
  readonly httpVersion: '1.1' | '2';
  /** True when the body was cut short because it exceeded `maxSizeBytes`. */
  readonly truncated: boolean;
  /**
   * Set when the response body failed to decompress (e.g. malformed gzip).
   * When present, `body` equals `rawBody` (decompression was not applied)
   * rather than throwing.
   */
  readonly decodeError?: string;
  readonly timings: Timings;
  /** Reconstructed request line + headers + body, as it was (or would be) sent on the wire. */
  readonly rawRequest: Uint8Array;
  /** Reconstructed status line + headers + body, as received on the wire. */
  readonly rawResponse: Uint8Array;
  readonly redirects: readonly { readonly url: string; readonly status: number }[];
  /**
   * The TLS connection this exchange travelled over: protocol, cipher, whether the
   * peer chain verified, and the chain itself. Absent for plain HTTP.
   */
  readonly tls?: SslInfo;
  /**
   * Present only when a stream hook accepted the response: who ended the stream. `body` and
   * `rawBody` are then empty and `rawResponse` holds the status line and headers only.
   */
  readonly streamEnd?: { readonly by: 'server' | 'client' | 'error'; readonly error?: string };
}

/** Stable, machine-readable classification for {@link HttpError}. */
export type HttpErrorCode =
  | 'timeout'
  | 'aborted'
  | 'connection-refused'
  | 'dns'
  | 'tls'
  /** The peer chain did not verify against the trust store in use; `details.peerSubject` names the leaf. */
  | 'tls-untrusted'
  | 'too-large'
  | 'too-many-redirects'
  | 'invalid-url'
  | 'proxy'
  | 'network';
