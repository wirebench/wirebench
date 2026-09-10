import diagnosticsChannel from 'node:diagnostics_channel';
import { sslInfoForSocket, type SslInfo, type TlsSocketLike } from './tls.js';
import type { Timings } from './types.js';

/** Default timer, injectable for deterministic tests. */
const defaultNow = (): number => performance.now();

/**
 * Number of `sendHttp` calls currently in flight, process-wide. `undici:client:*`
 * connect-level diagnostics_channel events carry no per-exchange correlation id,
 * so when more than one exchange is in flight we cannot tell which exchange a
 * given connect event belongs to. Rather than risk mis-attributing connect/TLS
 * timings to the wrong exchange, we only record them when exactly one exchange
 * is in flight; concurrent exchanges leave `connectMs`/`tlsMs` undefined
 * (a documented imprecision, not a bug).
 *
 * `tls` (the peer/protocol snapshot) is not subject to that restriction: it is
 * correlated by origin instead — see `onSendHeaders`.
 */
let inFlightCount = 0;

/** The shape `undici:client:connected` / `undici:client:sendHeaders` publish, as far as we read it. */
interface SocketMessage {
  readonly socket?: (TlsSocketLike & { readonly encrypted?: boolean }) | undefined;
  readonly request?: { readonly origin?: unknown } | undefined;
}

/** Narrows a diagnostics-channel payload to the TLS socket it carries, if it carries one. */
function encryptedSocketOf(message: unknown): (TlsSocketLike & { encrypted?: boolean }) | undefined {
  const socket = (message as SocketMessage | undefined)?.socket;
  return socket?.encrypted === true ? socket : undefined;
}

/** The `origin` string undici stamps on the request the event belongs to, when it has one. */
function requestOriginOf(message: unknown): string | undefined {
  const origin = (message as SocketMessage | undefined)?.request?.origin;
  if (typeof origin === 'string') return origin;
  // undici accepts a URL for `origin` too; both shapes normalise to the same string.
  return origin instanceof URL ? origin.origin : undefined;
}

/**
 * Tracks timings for exactly one physical HTTP exchange at a time (this
 * module never issues concurrent requests through the same dispatcher call,
 * so correlating "the next create/connect/headers event" to "this request"
 * is safe without threading opaque ids through undici).
 *
 * Sources:
 * - `connectMs`/`tlsMs`: `undici:client:beforeConnect` / `undici:client:connected`.
 *   Only observed when a *new* socket is opened for this exchange; a reused
 *   keep-alive connection leaves both undefined.
 * - `tls` (the {@link SslInfo} snapshot): `undici:client:sendHeaders`, which
 *   carries both the request and the socket its bytes were written to — so a
 *   request that reuses a warm keep-alive connection still gets the peer chain,
 *   which `undici:client:connected` alone (fresh connections only) cannot give.
 * - `ttfbMs`: `undici:request:headers` (response headers received).
 * - `downloadMs`: measured after headers, ended by our own body-read loop
 *   (not a diagnostics channel — undici doesn't expose a clean "body fully
 *   read" timestamp before trailers, and we already know when we finish reading).
 * - `dnsMs`: left undefined. Wiring a custom `connect.lookup` timer for this
 *   would require plumbing through every dispatcher construction path
 *   (including caller-supplied dispatchers for Task 35's NTLM `Client`), which
 *   is more invasive than this task's payoff justifies. Documented, not silently dropped.
 */
export class TimingTracker {
  private readonly now: () => number;
  private readonly startedAtMs: number;
  private readonly startedAtIso: string;
  private connectStart: number | undefined;
  private connectEnd: number | undefined;
  private tlsEnd: number | undefined;
  private headersAt: number | undefined;
  private ssl: SslInfo | undefined;
  /** The origin this exchange is currently talking to; a redirect moves it. */
  private origin: string | undefined;

  private readonly onBeforeConnect: (message: unknown) => void;
  private readonly onConnected: (message: unknown) => void;
  private readonly onSendHeaders: (message: unknown) => void;

  private disposed = false;

  constructor(now: () => number = defaultNow) {
    this.now = now;
    this.startedAtMs = now();
    this.startedAtIso = new Date().toISOString();
    inFlightCount += 1;

    this.onBeforeConnect = () => {
      if (inFlightCount !== 1) return; // another exchange is concurrently in flight; can't attribute safely
      if (this.connectStart === undefined) this.connectStart = this.now();
    };

    this.onConnected = (message: unknown) => {
      const socket = encryptedSocketOf(message);
      // Warm the per-socket cache while the handshake is fresh, whatever else we
      // can or cannot attribute: a *later* exchange reusing this very socket
      // reads it back through `sendHeaders`.
      if (socket !== undefined) sslInfoForSocket(socket);
      if (inFlightCount !== 1) return; // another exchange is concurrently in flight; can't attribute safely
      if (this.connectStart === undefined) return; // beforeConnect for this exchange was never observed
      this.connectEnd = this.now();
      if (socket !== undefined) {
        this.tlsEnd = this.connectEnd;
        this.ssl = sslInfoForSocket(socket);
      }
    };

    this.onSendHeaders = (message: unknown) => {
      const socket = encryptedSocketOf(message);
      if (socket === undefined) return;
      // Correlate by origin rather than by "nothing else is in flight": two
      // exchanges to the *same* origin share a server certificate anyway, so a
      // match is either this exchange's socket or one indistinguishable from it.
      // With no origin to compare against, fall back to the single-in-flight rule.
      const origin = requestOriginOf(message);
      const matches = this.origin !== undefined && origin !== undefined ? origin === this.origin : inFlightCount === 1;
      if (!matches) return;
      this.ssl = sslInfoForSocket(socket);
    };

    diagnosticsChannel.channel('undici:client:beforeConnect').subscribe(this.onBeforeConnect);
    diagnosticsChannel.channel('undici:client:connected').subscribe(this.onConnected);
    diagnosticsChannel.channel('undici:client:sendHeaders').subscribe(this.onSendHeaders);
  }

  /** Records which origin the next physical request goes to, so TLS events can be attributed to it. */
  setOrigin(origin: string): void {
    this.origin = origin;
  }

  /** Call when the response headers arrive (time-to-first-byte). */
  markHeaders(): void {
    this.headersAt = this.now();
  }

  /**
   * Stops listening to diagnostics channels and decrements the in-flight
   * counter. Always call this, even on error paths — idempotent, so it is
   * safe to call more than once (e.g. from a `finally` after an early throw).
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    diagnosticsChannel.channel('undici:client:beforeConnect').unsubscribe(this.onBeforeConnect);
    diagnosticsChannel.channel('undici:client:connected').unsubscribe(this.onConnected);
    diagnosticsChannel.channel('undici:client:sendHeaders').unsubscribe(this.onSendHeaders);
    inFlightCount -= 1;
  }

  /** Finalizes the timing record. Call once the response body is fully read (or the exchange failed). */
  finish(): Timings {
    const end = this.now();
    const connectMs =
      this.connectStart !== undefined && this.connectEnd !== undefined
        ? this.connectEnd - this.connectStart
        : undefined;
    const tlsMs =
      this.connectStart !== undefined && this.tlsEnd !== undefined ? this.tlsEnd - this.connectStart : undefined;
    const ttfbMs = this.headersAt !== undefined ? this.headersAt - this.startedAtMs : undefined;
    const downloadMs = this.headersAt !== undefined ? end - this.headersAt : undefined;

    return {
      startedAt: this.startedAtIso,
      totalMs: end - this.startedAtMs,
      ...(connectMs !== undefined ? { connectMs } : {}),
      ...(tlsMs !== undefined ? { tlsMs } : {}),
      ...(ttfbMs !== undefined ? { ttfbMs } : {}),
      ...(downloadMs !== undefined ? { downloadMs } : {}),
    };
  }

  /** The TLS peer/protocol snapshot for the connection this exchange used, if it was a TLS one. */
  tlsInfo(): SslInfo | undefined {
    return this.ssl;
  }
}
