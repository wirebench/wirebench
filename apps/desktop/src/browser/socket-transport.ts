/**
 * The browser client's transport (hosted edition spec §3.1, §17.6): `invoke` and `on` for `buildApi`, over
 * one WebSocket to the server's host (`/api/v1/host`). The wire is the IPC contract's:
 *
 * - server → `{ type: 'hello', host: 'browser', capabilities, osTheme }`, first, once the host is ready
 * - client → `{ id, channel, request }`, answered `{ id, ok, value | error }`
 * - server → `{ event, payload }`, a push
 *
 * The same transport carries the tab's second socket, to the paired local agent (spec §18.3): its
 * `firstFrame` option is sent as soon as each socket opens, before the hello is awaited (the agent's auth
 * frame), and is made afresh for every attempt (a new single-use nonce each time).
 *
 * A dropped socket reopens with backoff (1 s, doubling to 30 s, back to 1 s after a hello). A reopen
 * re-sends nothing: a call pending at the drop, or made while the socket is down, is answered
 * `host-disconnected` as an ordinary failed `IpcResult`, so the renderer shows it as it shows any other
 * failed call. Event listeners belong to the transport, not to one socket, so they outlive reconnects.
 *
 * Kept free of zod, React and the renderer: it runs before either is loaded.
 */
import { ALL_CAPABILITIES, type Capability } from '@wirebench/wire/capabilities';
import type { Invoke, On } from '../preload/build-api.js';

/** The host's first frame on a socket: the server's (`browser`) or the paired agent's (`agent`). */
export interface Hello {
  readonly type: 'hello';
  readonly host: 'browser' | 'agent';
  readonly capabilities: readonly Capability[];
  readonly osTheme: 'dark' | 'light';
}

/** What the transport needs of a WebSocket; the browser's own satisfies it. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface SocketTransportOptions {
  /** Opens a socket; `new WebSocket(url)` unless a test passes its own. */
  readonly createSocket?: (url: string) => SocketLike;
  /** Each hello, the first one included (it also resolves `ready`). */
  readonly onHello?: (hello: Hello) => void;
  /**
   * Each time a socket closes other than by {@link SocketTransport.close}: its close code, and whether a
   * hello arrived on it. The next attempt is already scheduled unless the listener calls `close()`.
   */
  readonly onClosed?: (code: number, helloSeen: boolean) => void;
  /**
   * Each time opening a socket throws (a URL the page may not connect to, say). The next attempt is
   * already scheduled, on the same backoff as after a close.
   */
  readonly onOpenFailed?: (error: unknown) => void;
  /**
   * Makes the frame each socket sends first, once it opens and before its hello: asked once per attempt,
   * before the socket is created. A rejection fails that attempt like a socket that would not open
   * (`onOpenFailed`, then the next attempt on the backoff), so a failing source is asked at most once per
   * attempt.
   */
  readonly firstFrame?: () => Promise<unknown>;
  /** What a call answers while the socket is down; {@link HOST_DISCONNECTED} unless given. */
  readonly disconnected?: { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };
}

export interface SocketTransport {
  /** The first hello. Never rejects: a socket that fails before it is retried like any other. */
  readonly ready: Promise<Hello>;
  readonly invoke: Invoke;
  readonly on: On;
  /** Closes the socket for good: no reconnect, pending calls answered `host-disconnected`. */
  close(): void;
}

/** The first reconnect delay and its ceiling. */
export const RECONNECT_DELAY = { firstMs: 1_000, maxMs: 30_000 } as const;

/** `WebSocket.OPEN`, spelled out so the transport does not need the global to exist. */
const OPEN = 1;

/** The answer to a call the socket could not carry. */
export const HOST_DISCONNECTED = {
  ok: false,
  error: {
    code: 'host-disconnected',
    message: 'The connection to the server was lost before this call was answered; try again once it is back',
  },
} as const;

const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(ALL_CAPABILITIES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A hello frame, or `undefined`. Capabilities the client does not know are dropped. */
function helloOf(frame: Record<string, unknown>): Hello | undefined {
  if (frame['type'] !== 'hello' || !Array.isArray(frame['capabilities'])) return undefined;
  const capabilities = frame['capabilities'].filter(
    (one): one is Capability => typeof one === 'string' && KNOWN_CAPABILITIES.has(one),
  );
  return {
    type: 'hello',
    host: frame['host'] === 'agent' ? 'agent' : 'browser',
    capabilities,
    osTheme: frame['osTheme'] === 'light' ? 'light' : 'dark',
  };
}

/** A reply frame as the `IpcResult` the renderer reads. */
function resultOf(frame: Record<string, unknown>): unknown {
  if (frame['ok'] === true) return { ok: true, value: frame['value'] };
  const error = frame['error'];
  if (isRecord(error) && typeof error['code'] === 'string' && typeof error['message'] === 'string') {
    return { ok: false, error };
  }
  return { ok: false, error: { code: 'internal-error', message: 'The server sent a reply the client cannot read' } };
}

/** The host socket's URL for a page: same origin, `wss:` under https. */
export function hostSocketUrl(location: { readonly protocol: string; readonly host: string }): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/v1/host`;
}

export function createSocketTransport(url: string, options: SocketTransportOptions = {}): SocketTransport {
  const createSocket = options.createSocket ?? ((target: string) => new WebSocket(target) as SocketLike);
  const disconnected = options.disconnected ?? HOST_DISCONNECTED;
  const pending = new Map<number, (result: unknown) => void>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let nextId = 1;
  let socket: SocketLike | undefined;
  /** A hello arrived on the current socket, and it has not closed since. */
  let connected = false;
  let stopped = false;
  let delay: number = RECONNECT_DELAY.firstMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveReady: (hello: Hello) => void = () => undefined;
  let readyResolved = false;
  const ready = new Promise<Hello>((resolve) => {
    resolveReady = resolve;
  });

  const failPending = (): void => {
    const answers = [...pending.values()];
    pending.clear();
    for (const answer of answers) answer(disconnected);
  };

  /** Handles one frame; `true` when it was a hello. */
  const onFrame = (frame: Record<string, unknown>): boolean => {
    const hello = helloOf(frame);
    if (hello !== undefined) {
      connected = true;
      delay = RECONNECT_DELAY.firstMs;
      if (!readyResolved) {
        readyResolved = true;
        resolveReady(hello);
      }
      options.onHello?.(hello);
      return true;
    }
    if (typeof frame['id'] === 'number' && typeof frame['ok'] === 'boolean') {
      const answer = pending.get(frame['id']);
      if (typeof answer !== 'function') return false;
      pending.delete(frame['id']);
      answer(resultOf(frame));
      return false;
    }
    if (typeof frame['event'] === 'string') {
      for (const listener of [...(listeners.get(frame['event']) ?? [])]) {
        try {
          listener(frame['payload']);
        } catch (error) {
          // One listener's fault is not the socket's: the others still hear the event.
          console.error('a host event listener failed:', frame['event'], error);
        }
      }
    }
    return false;
  };

  /** Schedules the next attempt and doubles the wait for the one after, up to the ceiling. */
  const retry = (): void => {
    timer = setTimeout(connect, delay);
    delay = Math.min(delay * 2, RECONNECT_DELAY.maxMs);
  };

  const connect = (): void => {
    timer = undefined;
    if (stopped) return;
    const source = options.firstFrame;
    if (source === undefined) {
      open(undefined);
      return;
    }
    source().then(
      (frame) => {
        if (!stopped) open(JSON.stringify(frame));
      },
      (error: unknown) => {
        if (stopped) return;
        retry();
        options.onOpenFailed?.(error);
      },
    );
  };

  /** Opens one socket; `first`, when given, is sent the moment it opens. */
  const open = (first: string | undefined): void => {
    let current: SocketLike;
    try {
      current = createSocket(url);
    } catch (error) {
      retry();
      options.onOpenFailed?.(error);
      return;
    }
    socket = current;
    let helloSeen = false;
    current.onopen = () => {
      if (socket !== current || first === undefined) return;
      try {
        current.send(first);
      } catch {
        // A socket that cannot take its first frame closes; the close handler retries.
      }
    };
    current.onmessage = (event) => {
      if (socket !== current || typeof event.data !== 'string') return;
      let frame: unknown;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!isRecord(frame)) return;
      if (onFrame(frame)) helloSeen = true;
    };
    current.onclose = (event) => {
      if (socket !== current || stopped) return;
      socket = undefined;
      connected = false;
      failPending();
      // Scheduled before the listener runs, so a listener that gives up can still cancel it with close().
      retry();
      options.onClosed?.(event.code, helloSeen);
    };
    // A failed socket also closes; the close handler does the work.
    current.onerror = () => undefined;
  };

  const invoke: Invoke = (channel, request) => {
    const current = socket;
    if (!connected || current === undefined || current.readyState !== OPEN) {
      return Promise.resolve(disconnected);
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      try {
        current.send(JSON.stringify({ id, channel, request }));
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const on: On = (eventName, listener) => {
    let set = listeners.get(eventName);
    if (set === undefined) {
      set = new Set();
      listeners.set(eventName, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };

  const close = (): void => {
    if (stopped) return;
    stopped = true;
    connected = false;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const current = socket;
    socket = undefined;
    current?.close(1000, 'closed');
    failPending();
  };

  connect();
  return { ready, invoke, on, close };
}
