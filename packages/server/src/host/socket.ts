/**
 * One browser's host socket (hosted edition spec §5.2, §17.3): the frames between a signed-in browser
 * tab and the user's host. The server speaks first, once the host is ready:
 *
 * - server → `{ type: 'hello', host: 'browser', capabilities, osTheme }`
 * - client → `{ id, channel, request }`, answered `{ id, ok, value | error }`
 * - server → `{ event, payload }`, a push from the host to this tab
 *
 * Calls that arrive before the host is ready wait for it, up to {@link HOST_LIMITS.maxQueuedBytes} in
 * all (past it the socket closes `1009`). A frame that is not JSON text of that shape closes the socket
 * `4400`; past {@link HOST_LIMITS.maxInFlight} running calls, a call is answered `host-busy` and the
 * socket stays open. Once the server ends a socket nothing more is served or pushed on it, whether or
 * not the peer has answered the close. Nothing a frame carries is logged.
 */
import { z } from 'zod';
import type { RawData, WebSocket } from 'ws';
import { HOST_CLOSE, HOST_LIMITS, hostBusy } from './errors.js';
import type { HostCaller, HostCallFrame, ServerHost } from './host-runtime.js';

/** A client frame; `request` is the channel's to check, so it is taken as it comes. */
const callFrameSchema = z
  .object({
    id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    channel: z.string().min(1).max(200),
    request: z.unknown().optional(),
  })
  .strict();

export interface HostSocketDeps {
  /**
   * The user's host, once built; a rejection closes the socket `1011`. `undefined` when no host was
   * built for this socket (it closed, its session ended or the server is stopping while it waited).
   */
  readonly host: Promise<ServerHost | undefined>;
  /** This socket's caller id on that host, unique within it. */
  readonly callerId: number;
  /** The allowlist (`allowlist.ts`). */
  readonly allowed: (channel: string) => boolean;
  readonly log: (message: string, error: unknown) => void;
  /** Runs once the socket has closed and its scope is gone. */
  readonly onClosed: () => void;
}

function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
}

function parse(text: string): HostCallFrame | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const result = callFrameSchema.safeParse(json);
  return result.success
    ? { id: result.data.id, channel: result.data.channel, request: result.data.request }
    : undefined;
}

/** What the server holds of a running socket. */
export interface HostSocket {
  /**
   * Ends the socket now, as its close event would: nothing it sent since is served, nothing more is
   * pushed to it, its scope is detached and `onClosed` runs, all without waiting for the peer to answer
   * the close (a `ws` keeps emitting `message` while closing, up to its 30-second close timeout). Then
   * starts the close handshake with `code`. A second call, or one after the close, does nothing.
   */
  end(code: number, reason: string): void;
}

function byteLengthOf(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((sum, one) => sum + one.length, 0);
  return Buffer.isBuffer(data) ? data.length : data.byteLength;
}

/**
 * Runs the socket. Listeners are attached synchronously, as `@fastify/websocket` requires, so no frame is
 * lost while the host is being built.
 */
export function runHostSocket(ws: WebSocket, deps: HostSocketDeps): HostSocket {
  const closedListeners = new Set<() => void>();
  let closed = false;
  let inFlight = 0;
  let host: ServerHost | undefined;
  /** Calls that came before the host was ready, in arrival order, and their size in bytes. */
  const waiting: HostCallFrame[] = [];
  let waitingBytes = 0;

  const sendJson = (value: unknown): void => {
    if (!closed && ws.readyState === ws.OPEN) ws.send(JSON.stringify(value));
  };
  const caller: HostCaller = {
    id: deps.callerId,
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
    waiting.length = 0;
    waitingBytes = 0;
    const detached = host === undefined ? Promise.resolve() : host.detach(deps.callerId);
    detached
      .catch((error: unknown) => {
        deps.log('a host scope could not be closed', error);
      })
      .finally(() => {
        for (const listener of [...closedListeners]) {
          try {
            listener();
          } catch (error) {
            deps.log('a host socket close listener failed', error);
          }
        }
        closedListeners.clear();
        deps.onClosed();
      });
  };
  const end = (code: number, reason: string): void => {
    finish();
    if (ws.readyState === ws.OPEN) ws.close(code, reason);
  };

  const serve = (ready: ServerHost, frame: HostCallFrame): void => {
    if (inFlight >= HOST_LIMITS.maxInFlight) {
      sendJson(hostBusy(frame.id));
      return;
    }
    inFlight += 1;
    // `serve` never rejects; the guard is for a host that breaks that promise.
    ready
      .serve(caller, frame, deps.allowed)
      .then(sendJson, (error: unknown) => {
        deps.log('a host call failed', error);
        sendJson({ id: frame.id, ok: false, error: { code: 'internal-error', message: 'The call failed' } });
      })
      .finally(() => {
        inFlight -= 1;
      });
  };

  deps.host.then(
    (ready) => {
      // Ended while the host was being built: it never joins the host, so there is nothing to detach.
      if (closed) return;
      if (ready === undefined) {
        end(HOST_CLOSE.goingAway, 'no host');
        return;
      }
      host = ready;
      ready.attach(caller);
      sendJson({ type: 'hello', host: 'browser', capabilities: ready.capabilities, osTheme: ready.osTheme });
      waitingBytes = 0;
      for (const frame of waiting.splice(0)) serve(ready, frame);
    },
    (error: unknown) => {
      deps.log('a host could not be started', error);
      end(HOST_CLOSE.serverError, 'server error');
    },
  );

  ws.on('message', (data: RawData, isBinary: boolean) => {
    // Nothing is served once the socket is ending, whether or not the peer has answered the close.
    if (closed || ws.readyState !== ws.OPEN) return;
    const frame = isBinary ? undefined : parse(textOf(data));
    if (frame === undefined) {
      end(HOST_CLOSE.badFrame, 'bad frame');
      return;
    }
    if (host === undefined) {
      const size = byteLengthOf(data);
      // Counted against the cap as if running: a client cannot queue past it either.
      if (waiting.length >= HOST_LIMITS.maxInFlight) {
        sendJson(hostBusy(frame.id));
      } else if (waitingBytes + size > HOST_LIMITS.maxQueuedBytes) {
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
