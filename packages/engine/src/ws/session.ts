/**
 * One WebSocket connection from handshake to close, and the only file that touches undici's
 * WebSocket. It knows nothing about projects or containers: a saved WebSocket request opens one
 * through `call.ts`, and anything else that needs a socket — a subscription protocol layered on a
 * subprotocol, a contract check wrapped around `onFrame` — opens one the same way.
 *
 * Whatever the server does is a result. `done` never rejects: a refused handshake, a dropped
 * socket and a clean close all resolve with the exchange that records them.
 */
import diagnosticsChannel from 'node:diagnostics_channel';
import { ProxyAgent, WebSocket, type Dispatcher } from 'undici';
import { WsError } from '../errors.js';
import { createDispatcher, proxyAgentOptionsFor } from '../http/client.js';
import type { ProxyOptions, TlsOptions } from '../http/types.js';
import { sslInfoForSocket, type SslInfo, type TlsSocketLike } from '../http/tls.js';
import type { WsExchange, WsFrame, WsHandshake, WsOpcode } from './model.js';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;

/** Options for {@link openWsSession}. */
export interface WsSessionOptions {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** The connection fails if the server's response selects none of these. */
  readonly subprotocols?: readonly string[];
  readonly tls?: TlsOptions;
  readonly proxy?: ProxyOptions;
  readonly localAddress?: string;
  /** Default 30 000. */
  readonly handshakeTimeoutMs?: number;
  /** Default unlimited. A larger received message ends the session from this side. */
  readonly maxMessageBytes?: number;
  readonly signal?: AbortSignal;
}

/** Hooks {@link openWsSession} calls as the session runs, in addition to `done`. */
export interface WsSessionHooks {
  onHandshake?(handshake: WsHandshake): void;
  onFrame?(frame: WsFrame): void;
  onClosed?(exchange: WsExchange): void;
}

/** A live WebSocket session, as returned by {@link openWsSession}. */
export interface WsSessionHandle {
  /** @throws WsError `ws-session-closed` */
  send(data: string | Uint8Array): WsFrame;
  /** Idempotent. @throws WsError `ws-bad-close` for a code an application may not send. */
  close(code?: number, reason?: string): void;
  readonly isOpen: boolean;
  /** Never rejects. */
  readonly done: Promise<WsExchange>;
}

/** RFC 6455 §7.4, as the WHATWG API enforces it: 1000, or the 3000–4999 range. */
function assertCloseCode(code: number): void {
  if (code !== 1000 && !(code >= 3000 && code <= 4999)) {
    throw new WsError('ws-bad-close', `${code} is not a close code an application may send (1000, or 3000–4999)`, {
      details: { code },
    });
  }
}

// undici's WebSocket API reports a plain refusal (e.g. a 401) and a completed-but-mismatched
// handshake (a 101 whose Sec-WebSocket-Protocol selects none of what we offered) identically: an
// empty `error.message`. So this default text names the offered subprotocols whenever there were
// any, since that ambiguous case is the one where the extra detail actually helps the reader.
function defaultHandshakeError(subprotocols: readonly string[] | undefined): string {
  if (subprotocols !== undefined && subprotocols.length > 0) {
    return `The server refused the WebSocket handshake, or selected none of the offered subprotocols (${subprotocols.join(', ')})`;
  }
  return 'The server refused the WebSocket handshake';
}

export function openWsSession(options: WsSessionOptions, hooks: WsSessionHooks = {}): WsSessionHandle {
  const startedMs = performance.now();
  const startedAt = new Date().toISOString();
  const timeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  // `createDispatcher({ proxy })` does not CONNECT-tunnel a WebSocket handshake: undici rewrites
  // `ws:`/`wss:` to `http:`/`https:` before dispatching, and `ProxyAgent` only tunnels `http:`
  // when built with `proxyTunnel: true`. So a proxied session always owns its own `ProxyAgent`;
  // an unproxied one owns a dispatcher only when it asked for TLS/bind-address options that
  // `createDispatcher` would otherwise hand back the shared keep-alive agent for.
  const ownsDispatcher = options.proxy !== undefined || options.tls !== undefined || options.localAddress !== undefined;
  const dispatcher: Dispatcher =
    options.proxy !== undefined
      ? new ProxyAgent(
          proxyAgentOptionsFor(
            options.proxy,
            {
              ...(options.tls !== undefined ? { tls: options.tls } : {}),
              ...(options.localAddress !== undefined ? { localAddress: options.localAddress } : {}),
            },
            false,
            { proxyTunnel: true },
          ),
        )
      : createDispatcher({
          ...(options.tls !== undefined ? { tls: options.tls } : {}),
          ...(options.localAddress !== undefined ? { localAddress: options.localAddress } : {}),
        });
  const target = new URL(options.url);
  const httpOrigin = `${target.protocol === 'wss:' ? 'https:' : 'http:'}//${target.host}`;
  const frames: WsFrame[] = [];
  const counts = { sent: 0, received: 0, bytesSent: 0, bytesReceived: 0 };
  let handshake: WsHandshake | undefined;
  let rawRequestHead: string | undefined;
  let tls: SslInfo | undefined;
  let closedBy: 'client' | 'server' | 'error' | undefined;
  let failure: string | undefined;
  let settled = false;

  const record = (
    direction: WsFrame['direction'],
    opcode: WsOpcode,
    payload: string | Uint8Array,
    close?: WsFrame['close'],
  ): WsFrame => {
    const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
    const binaryish = opcode === 'binary' || ((opcode === 'ping' || opcode === 'pong') && bytes.length > 0);
    const frame: WsFrame = {
      index: frames.length,
      direction,
      opcode,
      at: Math.round(performance.now() - startedMs),
      size: bytes.length,
      ...(opcode === 'text' ? { text: bytes.toString('utf8') } : {}),
      ...(binaryish ? { base64: bytes.toString('base64') } : {}),
      ...(close !== undefined ? { close } : {}),
    };
    frames.push(frame);
    if (opcode === 'text' || opcode === 'binary') {
      if (direction === 'sent') {
        counts.sent += 1;
        counts.bytesSent += bytes.length;
      } else {
        counts.received += 1;
        counts.bytesReceived += bytes.length;
      }
    }
    hooks.onFrame?.(frame);
    return frame;
  };

  const buildHandshake = (extra: {
    [K in 'status' | 'statusText' | 'responseHeaders' | 'protocol' | 'extensions' | 'remoteAddress' | 'error']?:
      WsHandshake[K] | undefined;
  }): WsHandshake => ({
    url: options.url,
    requestHeaders: { ...(options.headers ?? {}) },
    requestedSubprotocols: [...(options.subprotocols ?? [])],
    ...(rawRequestHead !== undefined ? { rawRequestHead } : {}),
    startedAt,
    durationMs: Math.round(performance.now() - startedMs),
    ...(tls !== undefined ? { tls } : {}),
    // The filter drops every `undefined`/empty-string entry at runtime, which is what makes this
    // safe under `exactOptionalPropertyTypes`; the cast says so, since `Object.fromEntries` can't
    // carry that through its own type.
    ...(Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined && v !== '')) as Partial<
      Pick<
        WsHandshake,
        'status' | 'statusText' | 'responseHeaders' | 'protocol' | 'extensions' | 'remoteAddress' | 'error'
      >
    >),
  });

  // Subscribed before the socket exists: undici starts the handshake inside the constructor.
  // The request head and the TLS session come from the channel `TimingTracker` reads, matched on
  // origin and path rather than identity because the request object is undici's own.
  const onSendHeaders = (message: unknown): void => {
    const m = message as {
      headers?: unknown;
      socket?: TlsSocketLike & { encrypted?: boolean };
      request?: { origin?: unknown; path?: string };
    };
    const origin =
      typeof m.request?.origin === 'string'
        ? m.request.origin
        : m.request?.origin instanceof URL
          ? m.request.origin.origin
          : undefined;
    if (rawRequestHead !== undefined || origin !== httpOrigin) return;
    if (m.request?.path !== `${target.pathname}${target.search}`) return;
    if (typeof m.headers === 'string') rawRequestHead = m.headers;
    if (m.socket?.encrypted === true) tls = sslInfoForSocket(m.socket);
  };
  // Subscribed (and `socket` declared) before `new WebSocket(...)` runs: if a diagnostics channel
  // ever delivered its payload before the assignment below completed, this ordering is what keeps
  // the `m.websocket !== socket` identity checks below safe rather than comparing against `undefined`.
  // `let`, not `const`: it is assigned exactly once, below, but declared here so those handlers'
  // identity comparisons stay safe even if a diagnostics channel delivered its payload early.
  // eslint-disable-next-line prefer-const
  let socket: WebSocket | undefined;
  const onOpenChannel = (message: unknown): void => {
    const m = message as {
      websocket?: unknown;
      address?: { address?: string; port?: number };
      protocol?: string;
      extensions?: string;
      handshakeResponse?: { status: number; statusText: string; headers: Record<string, string> };
    };
    if (m.websocket !== socket) return;
    handshake = buildHandshake({
      status: m.handshakeResponse?.status,
      statusText: m.handshakeResponse?.statusText,
      responseHeaders: m.handshakeResponse?.headers,
      protocol: m.protocol,
      extensions: m.extensions,
      remoteAddress: m.address?.address !== undefined ? `${m.address.address}:${m.address.port ?? ''}` : undefined,
    });
    hooks.onHandshake?.(handshake);
  };
  const onPing = (message: unknown): void => {
    const m = message as { websocket?: unknown; payload?: Uint8Array };
    if (m.websocket !== socket) return;
    const payload = m.payload ?? new Uint8Array();
    record('received', 'ping', payload);
    record('sent', 'pong', payload); // undici answers a ping itself, with the same payload
  };
  const onPong = (message: unknown): void => {
    const m = message as { websocket?: unknown; payload?: Uint8Array };
    if (m.websocket === socket) record('received', 'pong', m.payload ?? new Uint8Array());
  };
  const unsubscribeAll = (): void => {
    diagnosticsChannel.unsubscribe('undici:client:sendHeaders', onSendHeaders);
    diagnosticsChannel.unsubscribe('undici:websocket:open', onOpenChannel);
    diagnosticsChannel.unsubscribe('undici:websocket:ping', onPing);
    diagnosticsChannel.unsubscribe('undici:websocket:pong', onPong);
  };
  diagnosticsChannel.subscribe('undici:client:sendHeaders', onSendHeaders);
  diagnosticsChannel.subscribe('undici:websocket:open', onOpenChannel);
  diagnosticsChannel.subscribe('undici:websocket:ping', onPing);
  diagnosticsChannel.subscribe('undici:websocket:pong', onPong);

  socket = new WebSocket(options.url, {
    dispatcher,
    ...(options.headers !== undefined ? { headers: { ...options.headers } } : {}),
    ...(options.subprotocols !== undefined && options.subprotocols.length > 0
      ? { protocols: [...options.subprotocols] }
      : {}),
  });
  socket.binaryType = 'arraybuffer';
  const ws = socket;

  let resolveDone!: (exchange: WsExchange) => void;
  const done = new Promise<WsExchange>((resolve) => {
    resolveDone = resolve;
  });

  /** Settles the session exactly once, from whichever path gets there first. */
  const settle = (code: number, reason: string, wasClean: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    unsubscribeAll();
    const clean = wasClean && handshake !== undefined;
    const by = closedBy ?? (clean ? 'server' : 'error');
    if (clean) record('received', 'close', reason, { code, reason });
    let settledHandshake =
      handshake ?? buildHandshake({ error: failure ?? defaultHandshakeError(options.subprotocols) });
    if (by === 'error' && settledHandshake.error === undefined && failure !== undefined) {
      settledHandshake = { ...settledHandshake, error: failure };
    }
    const exchange: WsExchange = {
      kind: 'websocket',
      url: options.url,
      handshake: settledHandshake,
      frames,
      closed: { code, reason, by },
      counts: { ...counts },
      durationMs: Math.round(performance.now() - startedMs),
    };
    if (ownsDispatcher) void dispatcher.close();
    hooks.onClosed?.(exchange);
    resolveDone(exchange);
  };

  /** Ends a session the server never ended: a timeout, or an abort. */
  const fail = (message: string): void => {
    failure ??= message;
    closedBy ??= 'error';
    // There is no abort for a connecting socket; close() on one fails the handshake, which is the point.
    ws.close();
  };
  const timer = setTimeout(() => {
    if (handshake === undefined) fail(`The server did not answer the handshake within ${timeoutMs} ms`);
  }, timeoutMs);
  const onAbort = (): void => fail('The connection was cancelled');
  if (options.signal?.aborted === true) queueMicrotask(onAbort);
  options.signal?.addEventListener('abort', onAbort, { once: true });

  ws.addEventListener('message', (event) => {
    const data = event.data as string | ArrayBuffer;
    const frame =
      typeof data === 'string' ? record('received', 'text', data) : record('received', 'binary', new Uint8Array(data));
    if (options.maxMessageBytes !== undefined && frame.size > options.maxMessageBytes && closedBy === undefined) {
      // 1009 is the code for this, and an application may not send it; 1000 with the reason is what it can say.
      closedBy = 'client';
      record('sent', 'close', 'message too big', { code: 1000, reason: 'message too big' });
      ws.close(1000, 'message too big');
    }
  });
  ws.addEventListener('error', (event) => {
    const eventMessage = (event as { message?: unknown }).message;
    failure ??= (typeof eventMessage === 'string' ? eventMessage : '') || defaultHandshakeError(options.subprotocols);
    // A refused handshake may never fire `close` when the origin's connection is pooled: `error`
    // alone is authoritative for it. Settle on the next macrotask so a `close` that does arrive
    // (as it does when this is the first connection to the origin) wins and carries its own code.
    if (handshake === undefined) {
      setTimeout(() => settle(1006, '', false), 0);
    }
  });
  ws.addEventListener('close', (event) => {
    settle(event.code, event.reason, event.wasClean);
  });

  return {
    get isOpen() {
      return ws.readyState === WebSocket.OPEN;
    },
    done,
    send(data) {
      if (ws.readyState !== WebSocket.OPEN) throw new WsError('ws-session-closed', 'The connection is closed');
      ws.send(data);
      return record('sent', typeof data === 'string' ? 'text' : 'binary', data);
    },
    close(code = 1000, reason = '') {
      if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return;
      assertCloseCode(code);
      closedBy ??= 'client';
      if (ws.readyState === WebSocket.OPEN) record('sent', 'close', reason, { code, reason });
      ws.close(code, reason);
    },
  };
}
