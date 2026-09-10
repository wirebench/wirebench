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
  /** Reserved for future HTTP/2 support; only '1.1' is implemented. */
  readonly httpVersion?: '1.1';
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
}

/** Stable, machine-readable classification for {@link HttpError}. */
export type HttpErrorCode =
  | 'timeout'
  | 'aborted'
  | 'connection-refused'
  | 'dns'
  | 'tls'
  | 'too-large'
  | 'too-many-redirects'
  | 'invalid-url'
  | 'proxy'
  | 'network';
