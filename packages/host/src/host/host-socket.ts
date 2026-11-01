/**
 * The transport-generic half of a host socket (hosted edition spec §5.2, §17.3, §18.3), shared by the
 * Wirebench Server's `/api/v1/host` and the local agent, so both speak one wire:
 *
 * - host → `hello` (whatever the embedder's {@link HostSocketReady.hello} is), once the host is ready
 * - peer → `{ id, channel, request }`, answered `{ id, ok, value | error }`
 * - host → `{ event, payload }`, a push to this peer
 *
 * Calls that arrive before the host is ready wait for it, up to {@link HostLimits.maxQueuedBytes} in all
 * (past it the socket closes `1009`). A frame that is not JSON text of that shape closes the socket
 * `4400`; past {@link HostLimits.maxInFlight} running calls, a call is answered `host-busy` and the
 * socket stays open. Once the embedder ends a socket nothing more is served or pushed on it, whether or
 * not the peer has answered the close. Nothing a frame carries is logged.
 *
 * What stays with the embedder: who may open the socket, which host it gets, when it must end.
 */
import { z } from 'zod';
import type { CallFrame, ReplyFrame } from './serve-call.js';
import type { Caller } from './platform.js';

/**
 * The host socket's close codes (hosted edition spec §5.2, §17.3), spelled once. They follow the live
 * socket's: `4401` is HTTP's 401, `4403` its 403, `4400` a frame the protocol does not allow.
 */
export const HOST_CLOSE = {
  /** The embedder is shutting down. */
  goingAway: 1001,
  /**
   * A frame over {@link HOST_LIMITS.maxFrameBytes} (`ws` sends it itself), or calls queued before the host
   * was ready past {@link HOST_LIMITS.maxQueuedBytes}.
   */
  tooBig: 1009,
  serverError: 1011,
  badFrame: 4400,
  /** No signed-in browser session at the upgrade, or it ended since; or the peer failed its first frame. */
  unauthenticated: 4401,
  /** Another site's page, or a caller that is not a browser session. */
  forbidden: 4403,
  /** The user already has {@link HOST_LIMITS.maxSocketsPerUser} host sockets open (HTTP's 429). */
  tooManySockets: 4429,
  /**
   * The embedder cannot build this user's host for a reason only its operator can fix (HTTP's 503): the server's
   * secrets key no longer opens the stored data key. Reconnecting does not help until the key is restored.
   */
  unavailable: 4503,
} as const;

export const HOST_LIMITS = {
  /** A frame either way: a sync transfer of a large workspace is the biggest call. */
  maxFrameBytes: 32 * 1024 * 1024,
  /** Calls a socket may have running; past it a call is answered `host-busy`, not served. */
  maxInFlight: 64,
  /** Host sockets one user may have open at once, every tab and window together; the next closes `4429`. */
  maxSocketsPerUser: 8,
  /**
   * Bytes of calls a socket may queue while its host is being built; the frame that passes it closes the
   * socket {@link HOST_CLOSE.tooBig}. Without it, 64 queued frames of 32 MiB would each be held.
   */
  maxQueuedBytes: 64 * 1024 * 1024,
} as const;

/**
 * How long a peer has to pass `beforeReady`, counted from the socket's start, when the embedder names no
 * other time. A peer that sends nothing, or whose check is still running, is closed `4401` past it.
 */
export const HOST_AUTH_TIMEOUT_MS = 10_000;

/** The two limits {@link runHostSocket} enforces; an embedder may pass tighter ones. */
export interface HostLimits {
  readonly maxInFlight: number;
  readonly maxQueuedBytes: number;
}

/** The reply to a call past `maxInFlight`: the socket stays open, the call is not run. */
export function hostBusy(
  id: number,
  maxInFlight: number = HOST_LIMITS.maxInFlight,
): {
  readonly id: number;
  readonly ok: false;
  readonly error: { readonly code: 'host-busy'; readonly message: string };
} {
  return {
    id,
    ok: false,
    error: { code: 'host-busy', message: `At most ${maxInFlight} calls may run at once; wait for one to finish` },
  };
}

/** What a `ws` message carries, structurally. */
export type RawFrameData = Buffer | ArrayBuffer | Buffer[];

/**
 * The part of a WebSocket the loop uses, so the host package needs no `ws` types. A `ws` `WebSocket`
 * satisfies it. `close` only starts the handshake.
 */
export interface WebSocketLike {
  readonly readyState: number;
  /** The `readyState` of an open socket. */
  readonly OPEN: number;
  send(data: string): void;
  close(code: number, reason: string): void;
  on(event: 'message', listener: (data: RawFrameData, isBinary: boolean) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
}

/** A host that is ready to serve this socket. */
export interface HostSocketReady {
  /** Sent as the first frame, once the host is ready (and `beforeReady`, if any, has passed). */
  readonly hello: unknown;
  /** The socket opened: gives it its scope on the host. */
  attach(caller: Caller): void;
  /** Serves one frame as `caller`; never rejects (a rejection is answered `internal-error`). */
  serve(caller: Caller, frame: CallFrame): Promise<ReplyFrame>;
  /** The socket closed: runs its scope's quit path; resolves once it is done. */
  detach(): Promise<void>;
}

export interface HostSocketOptions {
  /**
   * The host, once built. A rejection closes the socket `1011`. `undefined` when no host was built for
   * this socket (it closed, its session ended or the embedder is stopping while it waited): the socket
   * closes `1001`.
   */
  readonly ready: Promise<HostSocketReady | undefined>;
  /** This socket's caller id on that host, unique within it. */
  readonly callerId: number;
  readonly limits: HostLimits;
  readonly log: (message: string, error: unknown) => void;
  /** Runs once the socket has closed and its scope is gone. */
  readonly onClosed: () => void;
  /**
   * The peer's first frame, parsed JSON of any shape, before anything else is read, served or sent (the
   * agent's `auth` frame). `true` lets the socket go on to its hello; `false` or a throw closes it `4401`.
   * Any other frame while it is pending, a binary or non-JSON first frame, closes `4400`. Absent, the
   * socket starts with the hello and the first frame is a call.
   */
  readonly beforeReady?: (frame: unknown) => Promise<boolean>;
  /**
   * With `beforeReady`: the milliseconds the peer has, from now, to send its first frame and pass the
   * check; past them the socket closes `4401`. {@link HOST_AUTH_TIMEOUT_MS} when absent. Without
   * `beforeReady` (the server, whose caller is authenticated at the upgrade) there is no deadline.
   */
  readonly authTimeoutMs?: number;
}

/** What the embedder holds of a running socket. */
export interface HostSocket {
  /**
   * Ends the socket now, as its close event would: nothing it sent since is served, nothing more is
   * pushed to it, its scope is detached and `onClosed` runs, all without waiting for the peer to answer
   * the close (a `ws` keeps emitting `message` while closing, up to its 30-second close timeout). Then
   * starts the close handshake with `code`. A second call, or one after the close, does nothing.
   */
  end(code: number, reason: string): void;
}

/** A peer's call; `request` is the channel's to check, so it is taken as it comes. */
const callFrameSchema = z
  .object({
    id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    channel: z.string().min(1).max(200),
    request: z.unknown().optional(),
  })
  .strict();

function textOf(data: RawFrameData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
}

function byteLengthOf(data: RawFrameData): number {
  if (Array.isArray(data)) return data.reduce((sum, one) => sum + one.length, 0);
  return Buffer.isBuffer(data) ? data.length : data.byteLength;
}

function parseJson(text: string): { readonly value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

function toCall(json: unknown): CallFrame | undefined {
  const result = callFrameSchema.safeParse(json);
  return result.success
    ? { id: result.data.id, channel: result.data.channel, request: result.data.request }
    : undefined;
}

/**
 * Runs the socket. Listeners are attached synchronously, as `@fastify/websocket` requires, so no frame is
 * lost while the host is being built.
 */
export function runHostSocket(ws: WebSocketLike, options: HostSocketOptions): HostSocket {
  const { callerId, limits, log } = options;
  const closedListeners = new Set<() => void>();
  let closed = false;
  let inFlight = 0;
  /** The `beforeReady` deadline, until the peer passes it or the socket ends. */
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let host: HostSocketReady | undefined;
  /** The host's answer, once it came; held until `beforeReady` has passed. */
  let built: { readonly value: HostSocketReady | undefined } | undefined;
  let authorised = options.beforeReady === undefined;
  let checking = false;
  /** Calls that came before the host was ready, in arrival order, and their size in bytes. */
  const waiting: CallFrame[] = [];
  let waitingBytes = 0;

  const sendJson = (value: unknown): void => {
    if (!closed && ws.readyState === ws.OPEN) ws.send(JSON.stringify(value));
  };
  const caller: Caller = {
    id: callerId,
    send: (channel, payload) => {
      sendJson({ event: channel, payload });
    },
    isClosed: () => closed,
    // A socket never starts over: a drop is a close.
    onReset: () => () => undefined,
    onClosed: (listener) => {
      if (closed) {
        let cancelled = false;
        queueMicrotask(() => {
          if (!cancelled) listener();
        });
        return () => {
          cancelled = true;
        };
      }
      closedListeners.add(listener);
      return () => {
        closedListeners.delete(listener);
      };
    },
  };

  // As a desktop window's close: the scope's quit path runs first (`detach`, with the caller already
  // closed, so it waits for no drafts), and only then do the caller's close listeners hear of it. The
  // other way round, the host's own listener would drop the scope before its quit path could run.
  const finish = (): void => {
    if (closed) return;
    closed = true;
    if (deadline !== undefined) clearTimeout(deadline);
    waiting.length = 0;
    waitingBytes = 0;
    const detached = host === undefined ? Promise.resolve() : host.detach();
    detached
      .catch((error: unknown) => {
        log('a host scope could not be closed', error);
      })
      .finally(() => {
        for (const listener of [...closedListeners]) {
          try {
            listener();
          } catch (error) {
            log('a host socket close listener failed', error);
          }
        }
        closedListeners.clear();
        options.onClosed();
      });
  };
  const end = (code: number, reason: string): void => {
    finish();
    if (ws.readyState === ws.OPEN) ws.close(code, reason);
  };

  const serve = (ready: HostSocketReady, frame: CallFrame): void => {
    if (inFlight >= limits.maxInFlight) {
      sendJson(hostBusy(frame.id, limits.maxInFlight));
      return;
    }
    inFlight += 1;
    // `serve` never rejects; the guard is for a host that breaks that promise.
    ready
      .serve(caller, frame)
      .then(sendJson, (error: unknown) => {
        log('a host call failed', error);
        sendJson({ id: frame.id, ok: false, error: { code: 'internal-error', message: 'The call failed' } });
      })
      .finally(() => {
        inFlight -= 1;
      });
  };

  /** Goes live once the host has answered and the peer is let in, in whichever order those happen. */
  const start = (): void => {
    if (closed || !authorised || built === undefined) return;
    const ready = built.value;
    if (ready === undefined) {
      end(HOST_CLOSE.goingAway, 'no host');
      return;
    }
    host = ready;
    ready.attach(caller);
    sendJson(ready.hello);
    waitingBytes = 0;
    for (const frame of waiting.splice(0)) serve(ready, frame);
  };

  options.ready.then(
    (ready) => {
      // Ended while the host was being built: it never joins the host, so there is nothing to detach.
      if (closed) return;
      built = { value: ready };
      start();
    },
    (error: unknown) => {
      log('a host could not be started', error);
      end(HOST_CLOSE.serverError, 'server error');
    },
  );

  // A peer that never proves itself does not hold the socket (and its slot) open.
  if (options.beforeReady !== undefined) {
    deadline = setTimeout(() => {
      if (!authorised) end(HOST_CLOSE.unauthenticated, 'unauthenticated');
    }, options.authTimeoutMs ?? HOST_AUTH_TIMEOUT_MS);
    deadline.unref();
  }

  const admit = (frame: unknown): void => {
    const check = options.beforeReady;
    if (check === undefined) return;
    checking = true;
    // Through a promise, so a check that throws synchronously closes the socket like one that rejects,
    // rather than escaping the socket's message listener.
    Promise.resolve(frame)
      .then(check)
      .then(
        (ok) => {
          if (closed) return;
          if (!ok) {
            end(HOST_CLOSE.unauthenticated, 'unauthenticated');
            return;
          }
          authorised = true;
          checking = false;
          if (deadline !== undefined) clearTimeout(deadline);
          start();
        },
        (error: unknown) => {
          log('a host socket could not check its first frame', error);
          end(HOST_CLOSE.unauthenticated, 'unauthenticated');
        },
      );
  };

  ws.on('message', (data: RawFrameData, isBinary: boolean) => {
    // Nothing is served once the socket is ending, whether or not the peer has answered the close.
    if (closed || ws.readyState !== ws.OPEN) return;
    const json = isBinary ? undefined : parseJson(textOf(data));
    if (!authorised) {
      // The first frame is the peer's to prove itself with; anything else before it passes is not allowed.
      if (json === undefined || checking) end(HOST_CLOSE.badFrame, 'bad frame');
      else admit(json.value);
      return;
    }
    const frame = json === undefined ? undefined : toCall(json.value);
    if (frame === undefined) {
      end(HOST_CLOSE.badFrame, 'bad frame');
      return;
    }
    if (host === undefined) {
      const size = byteLengthOf(data);
      // Counted against the cap as if running: a peer cannot queue past it either.
      if (waiting.length >= limits.maxInFlight) {
        sendJson(hostBusy(frame.id, limits.maxInFlight));
      } else if (waitingBytes + size > limits.maxQueuedBytes) {
        end(HOST_CLOSE.tooBig, 'too much queued');
      } else {
        waiting.push(frame);
        waitingBytes += size;
      }
      return;
    }
    serve(host, frame);
  });

  ws.on('close', finish);

  return { end };
}
