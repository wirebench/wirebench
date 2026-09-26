/**
 * A bare WebSocket with Wirebench's transport options (live-updates spec §5.2, R5), for a caller that
 * speaks its own protocol over it: the desktop's live-updates client.
 *
 * Why not the WHATWG constructor: it takes no TLS or proxy options. A server trusted through
 * Wirebench's CA bundle, or reached through the configured proxy, would then work over HTTP but never
 * over the socket. undici's `WebSocket` takes a `dispatcher` instead, built here by
 * {@link wsDispatcher}, the same function `openWsSession` uses.
 *
 * How it differs from `openWsSession`:
 * - it records no frames and writes no History;
 * - the socket is returned as is, and the caller owns its events;
 * - the handshake carries no `Origin` and no credentials, so whatever authenticates the socket
 *   travels in its first message (§6).
 */
import diagnosticsChannel from 'node:diagnostics_channel';
import { ProxyAgent, WebSocket, type Dispatcher } from 'undici';
import { WsError } from '../errors.js';
import { createDispatcher, proxyAgentOptionsFor } from '../http/client.js';
import type { ProxyOptions, TlsOptions } from '../http/types.js';

/** Options for {@link connectWebSocket}: the TLS and proxy settings an HTTP call to the same server gets. */
export interface ConnectOptions {
  readonly tls?: TlsOptions;
  readonly proxy?: ProxyOptions;
}

/** A socket from {@link connectWebSocket}, and what to call once finished with it. */
export interface ConnectedWebSocket {
  /** undici's WHATWG `WebSocket`, already connecting. */
  readonly socket: WebSocket;
  /**
   * The HTTP status that refused the upgrade (e.g. `404` from a server without the endpoint), once the
   * socket has failed without opening. `undefined` for an opened socket and for a network or TLS
   * failure.
   *
   * The WHATWG API reports every refusal as the same bare `error`, so this is the only way a caller can
   * tell "this server has no such endpoint" from "try again later". Two sockets opened to the same URL
   * at the same moment could read each other's status; the live client keeps one socket per server.
   */
  refusedStatus(): number | undefined;
  /**
   * Closes the socket with `1000` if it is still connecting or open, and releases a dispatcher this
   * call built. Idempotent (the same promise every time), and it never rejects.
   */
  dispose(): Promise<void>;
}

/** The transport options a WebSocket handshake's dispatcher is built from. */
export interface WsTransportOptions {
  readonly tls?: TlsOptions;
  readonly proxy?: ProxyOptions;
  readonly localAddress?: string;
}

/** A handshake's dispatcher, and whether the caller owns (and so must close) it. */
export interface WsDispatcher {
  readonly dispatcher: Dispatcher;
  readonly owned: boolean;
}

/**
 * The dispatcher for one WebSocket handshake. It is shared by `openWsSession` and
 * {@link connectWebSocket}, so the two can never reach a server differently.
 *
 * Why a proxied socket owns its own `ProxyAgent`: `createDispatcher({ proxy })` does not CONNECT-tunnel
 * a WebSocket handshake. undici rewrites `ws:`/`wss:` to `http:`/`https:` before it dispatches, and
 * `ProxyAgent` tunnels `http:` only when it is built with `proxyTunnel: true`.
 *
 * When an unproxied socket owns its dispatcher: only when it asked for TLS or bind-address options.
 * With neither, `createDispatcher` hands back the shared keep-alive agent, which the caller must never
 * close.
 *
 * Not part of the package's public surface: `index.ts` does not re-export it.
 */
export function wsDispatcher(options: WsTransportOptions): WsDispatcher {
  const connect = {
    ...(options.tls !== undefined ? { tls: options.tls } : {}),
    ...(options.localAddress !== undefined ? { localAddress: options.localAddress } : {}),
  };
  if (options.proxy !== undefined) {
    const agent = new ProxyAgent(proxyAgentOptionsFor(options.proxy, connect, false, { proxyTunnel: true }));
    return { dispatcher: agent, owned: true };
  }
  return {
    dispatcher: createDispatcher(connect),
    owned: options.tls !== undefined || options.localAddress !== undefined,
  };
}

/**
 * The status in `message` (an `undici:request:headers` payload) when it answers this socket's own
 * upgrade request: the request asked for `websocket`, and its origin, path and query are the socket's.
 * undici hands a `101` to `onUpgrade` and never publishes it here, so any status seen here is a
 * refusal.
 */
function refusalStatusFor(message: unknown, httpOrigin: string, pathAndSearch: string): number | undefined {
  const m = message as {
    request?: { upgrade?: unknown; origin?: unknown; path?: unknown };
    response?: { statusCode?: unknown };
  };
  if (m.request?.upgrade !== 'websocket' || m.request.path !== pathAndSearch) return undefined;
  const origin =
    typeof m.request.origin === 'string'
      ? m.request.origin
      : m.request.origin instanceof URL
        ? m.request.origin.origin
        : undefined;
  if (origin !== httpOrigin) return undefined;
  return typeof m.response?.statusCode === 'number' ? m.response.statusCode : undefined;
}

/**
 * Opens `url` (`ws:` or `wss:`) through a dispatcher built from `options`.
 *
 * @throws WsError `ws-bad-options` for a URL or an option the constructor refuses. When it throws,
 *   nothing is left subscribed or open.
 */
export function connectWebSocket(url: string, options: ConnectOptions = {}): ConnectedWebSocket {
  let target: URL;
  try {
    target = new URL(url);
  } catch (err) {
    throw new WsError('ws-bad-options', `"${url}" is not a valid URL`, { cause: err, details: { url } });
  }
  const httpOrigin = `${target.protocol === 'wss:' ? 'https:' : 'http:'}//${target.host}`;
  const pathAndSearch = `${target.pathname}${target.search}`;

  let refused: number | undefined;
  const onResponseHeaders = (message: unknown): void => {
    refused ??= refusalStatusFor(message, httpOrigin, pathAndSearch);
  };
  const stopWatching = (): void => {
    diagnosticsChannel.unsubscribe('undici:request:headers', onResponseHeaders);
  };

  let transport: WsDispatcher | undefined;
  let socket: WebSocket;
  try {
    transport = wsDispatcher(options);
    // Subscribed before the socket exists: undici starts the handshake inside the constructor.
    diagnosticsChannel.subscribe('undici:request:headers', onResponseHeaders);
    socket = new WebSocket(url, { dispatcher: transport.dispatcher });
  } catch (err) {
    stopWatching();
    if (transport?.owned === true) void transport.dispatcher.close().catch(() => undefined);
    const reason = err instanceof Error ? err.message : String(err);
    throw new WsError('ws-bad-options', `The WebSocket options for "${url}" are invalid: ${reason}`, {
      cause: err,
      details: { url },
    });
  }
  // The handshake has an answer once any of these fires; nothing later can be this socket's refusal.
  socket.addEventListener('open', stopWatching, { once: true });
  socket.addEventListener('error', stopWatching, { once: true });
  socket.addEventListener('close', stopWatching, { once: true });

  const { dispatcher, owned } = transport;
  const ws = socket;
  let disposed: Promise<void> | undefined;
  return {
    socket: ws,
    refusedStatus: () => refused,
    dispose() {
      disposed ??= (async () => {
        stopWatching();
        // On a connecting socket this fails the handshake and aborts its request, so the graceful
        // dispatcher close below has nothing in flight to wait for.
        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close(1000);
        if (owned) await dispatcher.close().catch(() => undefined);
      })();
      return disposed;
    },
  };
}
