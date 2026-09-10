import diagnosticsChannel from 'node:diagnostics_channel';
import type { Timings } from './types.js';

/** Default timer, injectable for deterministic tests. */
const defaultNow = (): number => performance.now();

interface TrackedSocketInfo {
  readonly connectedProtocol?: string;
  readonly connectedCipher?: string;
  readonly connectedAuthorized?: boolean;
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
  private socketInfo: TrackedSocketInfo = {};

  private readonly onBeforeConnect: (message: unknown) => void;
  private readonly onConnected: (message: unknown) => void;

  constructor(now: () => number = defaultNow) {
    this.now = now;
    this.startedAtMs = now();
    this.startedAtIso = new Date().toISOString();

    this.onBeforeConnect = () => {
      if (this.connectStart === undefined) this.connectStart = this.now();
    };
    this.onConnected = (message: unknown) => {
      this.connectEnd = this.now();
      const socket = (
        message as {
          socket?: {
            encrypted?: boolean;
            getProtocol?: () => string | null;
            getCipher?: () => { name?: string } | undefined;
            authorized?: boolean;
          };
        }
      ).socket;
      if (socket?.encrypted === true) {
        this.tlsEnd = this.connectEnd;
        const protocol = socket.getProtocol?.() ?? undefined;
        const cipher = socket.getCipher?.()?.name;
        this.socketInfo = {
          ...(protocol !== undefined && protocol !== null ? { connectedProtocol: protocol } : {}),
          ...(cipher !== undefined ? { connectedCipher: cipher } : {}),
          ...(socket.authorized !== undefined ? { connectedAuthorized: socket.authorized } : {}),
        };
      }
    };

    diagnosticsChannel.channel('undici:client:beforeConnect').subscribe(this.onBeforeConnect);
    diagnosticsChannel.channel('undici:client:connected').subscribe(this.onConnected);
  }

  /** Call when the response headers arrive (time-to-first-byte). */
  markHeaders(): void {
    this.headersAt = this.now();
  }

  /** Stops listening to diagnostics channels. Always call this, even on error paths. */
  dispose(): void {
    diagnosticsChannel.channel('undici:client:beforeConnect').unsubscribe(this.onBeforeConnect);
    diagnosticsChannel.channel('undici:client:connected').unsubscribe(this.onConnected);
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

  /** Best-effort TLS socket info observed during connect, if any. */
  tlsInfo(): { protocol?: string; cipher?: string; authorized?: boolean } | undefined {
    const { connectedProtocol, connectedCipher, connectedAuthorized } = this.socketInfo;
    if (connectedProtocol === undefined && connectedCipher === undefined && connectedAuthorized === undefined) {
      return undefined;
    }
    return {
      ...(connectedProtocol !== undefined ? { protocol: connectedProtocol } : {}),
      ...(connectedCipher !== undefined ? { cipher: connectedCipher } : {}),
      ...(connectedAuthorized !== undefined ? { authorized: connectedAuthorized } : {}),
    };
  }
}
