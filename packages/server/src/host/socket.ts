/**
 * One browser's host socket (hosted edition spec §5.2, §17.3): the frames between a signed-in browser
 * tab and the user's host. The server speaks first, once the host is ready:
 *
 * - server → `{ type: 'hello', host: 'browser', capabilities, osTheme }`
 * - client → `{ id, channel, request }`, answered `{ id, ok, value | error }`
 * - server → `{ event, payload }`, a push from the host to this tab
 *
 * Calls that arrive before the host is ready wait for it. A frame that is not JSON text of that shape
 * closes the socket `4400`; past {@link HOST_LIMITS.maxInFlight} running calls, a call is answered
 * `host-busy` and the socket stays open. Nothing a frame carries is logged.
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

/**
 * Runs the socket. Listeners are attached synchronously, as `@fastify/websocket` requires, so no frame is
 * lost while the host is being built.
 */
export function runHostSocket(ws: WebSocket, deps: HostSocketDeps): void {
  const closedListeners = new Set<() => void>();
  let closed = false;
  let inFlight = 0;
  let host: ServerHost | undefined;
  /** Calls that came before the host was ready, in arrival order. */
  const waiting: HostCallFrame[] = [];

  const sendJson = (value: unknown): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(value));
  };
  const caller: HostCaller = {
    id: deps.callerId,
    send: (channel, payload) => {
      if (!closed) sendJson({ event: channel, payload });
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
      if (closed) return;
      if (ready === undefined) {
        if (ws.readyState === ws.OPEN) ws.close(HOST_CLOSE.goingAway, 'no host');
        return;
      }
      host = ready;
      ready.attach(caller);
      sendJson({ type: 'hello', host: 'browser', capabilities: ready.capabilities, osTheme: ready.osTheme });
      for (const frame of waiting.splice(0)) serve(ready, frame);
    },
    (error: unknown) => {
      deps.log('a host could not be started', error);
      if (ws.readyState === ws.OPEN) ws.close(HOST_CLOSE.serverError, 'server error');
    },
  );

  ws.on('message', (data: RawData, isBinary: boolean) => {
    const frame = isBinary ? undefined : parse(textOf(data));
    if (frame === undefined) {
      if (ws.readyState === ws.OPEN) ws.close(HOST_CLOSE.badFrame, 'bad frame');
      return;
    }
    if (host === undefined) {
      // Counted against the cap as if running: a client cannot queue past it either.
      if (waiting.length >= HOST_LIMITS.maxInFlight) sendJson(hostBusy(frame.id));
      else waiting.push(frame);
      return;
    }
    serve(host, frame);
  });

  // As a desktop window's close: the scope's quit path runs first (`detach`, with the caller already
  // closed, so it waits for no drafts), and only then do the caller's close listeners hear of it. The
  // other way round, the host's own listener would drop the scope before its quit path could run.
  ws.on('close', () => {
    if (closed) return;
    closed = true;
    waiting.length = 0;
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
  });
}
