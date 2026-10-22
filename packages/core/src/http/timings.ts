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

/** The shape `undici:client:connected` / `undici:client:sendHeaders` / `undici:request:create` publish, as far as we read it. */
interface SocketMessage {
  readonly socket?: (TlsSocketLike & { readonly encrypted?: boolean }) | undefined;
  readonly request?: ({ readonly origin?: unknown } & object) | undefined;
}

/** Narrows a diagnostics-channel payload to the TLS socket it carries, if it carries one. */
function encryptedSocketOf(message: unknown): (TlsSocketLike & { encrypted?: boolean }) | undefined {
  const socket = (message as SocketMessage | undefined)?.socket;
  return socket?.encrypted === true ? socket : undefined;
}

/** The `request` object a diagnostics-channel payload carries, when it carries one. */
function requestOf(message: unknown): object | undefined {
  return (message as SocketMessage | undefined)?.request;
}

/** The `origin` string undici stamps on the request the event belongs to, when it has one. */
function requestOriginOf(message: unknown): string | undefined {
  const origin = (message as SocketMessage | undefined)?.request?.origin;
  if (typeof origin === 'string') return origin;
  // undici accepts a URL for `origin` too; both shapes normalise to the same string.
  return origin instanceof URL ? origin.origin : undefined;
}

/**
 * Tracks timings for one physical HTTP exchange. `connectMs`/`tlsMs` still rely on
 * this module never issuing concurrent requests through the same dispatcher call (so
 * "the next connect event" can only be this exchange's) — but `tls`, the peer/protocol
 * snapshot, does not get that luxury: two exchanges can easily be concurrently in
 * flight to the *same* origin on *different* sockets, and `undici:client:sendHeaders`
 * carries no correlation id of its own beyond the undici `Request` object reference.
 * `captureRequestFor` threads that reference through explicitly, so `onSendHeaders`
 * can match on it exactly instead of guessing from origin.
 *
 * Sources:
 * - `connectMs`/`tlsMs`: `undici:client:beforeConnect` / `undici:client:connected`.
 *   Only observed when a *new* socket is opened for this exchange; a reused
 *   keep-alive connection leaves both undefined.
 * - `tls` (the {@link SslInfo} snapshot): `undici:client:sendHeaders`, which carries
 *   the request, and the socket its bytes were written to — so a request that reuses a
 *   warm keep-alive connection still gets the peer chain, which `undici:client:connected`
 *   alone (fresh connections only) cannot give. Correlated by request identity (see
 *   {@link captureRequestFor}); origin matching is a fallback for the case where no
 *   identity was captured, not the primary mechanism.
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
  /**
   * The exact undici `Request` object this physical attempt is using, captured via
   * {@link captureRequestFor}. Compared by identity (`===`) in `onSendHeaders` — see
   * that handler for why this, rather than origin, is the correlation key.
   */
  private request: object | undefined;

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
      if (this.request !== undefined) {
        // Correlate by the exact undici `Request` object identity: `captureRequestFor`
        // records it synchronously from `undici:request:create`, which undici fires
        // inside the very call that starts this attempt, before any other exchange's
        // code can run (Node is single-threaded and nothing awaits in between). That
        // makes this exact — unlike origin matching, which conflates two concurrent
        // exchanges to the *same* origin on *different* sockets (they usually share a
        // certificate, but not always: see the concurrent-same-origin integration test).
        if (requestOf(message) !== this.request) return;
        this.ssl = sslInfoForSocket(socket);
        return;
      }
      // Fall back to origin matching only when no request identity was ever captured
      // for this exchange (defensive: `client.ts` always wraps its `undiciRequest()`
      // call in `captureRequestFor`, so in practice this branch is not expected to run).
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

  /**
   * Runs `fn` — a call that synchronously triggers undici's `undici:request:create`
   * diagnostics event, as every plain `undiciRequest()` call does — while listening for
   * that event, so `this.request` becomes the exact undici `Request` object this
   * physical attempt is using. Call this wrapping the `undiciRequest()` call itself
   * (not a `.then()`/`await` of it): the create event fires inside the synchronous
   * portion of that call, before it returns a pending promise, which is what makes the
   * capture race-free even when another exchange's own send is interleaved via
   * `Promise.all` — no other code runs between this subscribe and unsubscribe.
   */
  captureRequestFor<T>(fn: () => T): T {
    const channel = diagnosticsChannel.channel('undici:request:create');
    const onCreate = (message: unknown): void => {
      const request = requestOf(message);
      if (request !== undefined) this.request = request;
    };
    channel.subscribe(onCreate);
    try {
      return fn();
    } finally {
      channel.unsubscribe(onCreate);
    }
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
