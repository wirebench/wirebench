/**
 * One browser's host socket (hosted edition spec §5.2, §17.3): the frames between a signed-in browser
 * tab and the user's host. The wire (hello, calls, replies, pushes, the queue before the host is ready,
 * the in-flight cap, the close codes) is the shared loop in `@wirebench/host`, the same one the local
 * agent runs; it reaches the server through the host bundle (`host-runtime.ts`). This file is the
 * server's side of it: the user's host, the allowlist, and the browser's hello.
 *
 * The server speaks first, once the host is ready: `{ type: 'hello', host: 'browser', capabilities,
 * osTheme }`. Nothing a frame carries is logged.
 */
import type { WebSocket } from 'ws';
import type { RunSharedHostSocket, ServerHost } from './host-runtime.js';
import { HOST_LIMITS } from './errors.js';

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

/**
 * Runs the socket on `run`, the shared loop. Listeners are attached synchronously, as
 * `@fastify/websocket` requires, so no frame is lost while the host is being built.
 */
export function runHostSocket(run: RunSharedHostSocket, ws: WebSocket, deps: HostSocketDeps): HostSocket {
  return run(ws, {
    ready: deps.host.then((host) =>
      host === undefined
        ? undefined
        : {
            hello: { type: 'hello', host: 'browser', capabilities: host.capabilities, osTheme: host.osTheme },
            attach: (caller) => {
              host.attach(caller);
            },
            serve: (caller, frame) => host.serve(caller, frame, deps.allowed),
            detach: () => host.detach(deps.callerId),
          },
    ),
    callerId: deps.callerId,
    limits: HOST_LIMITS,
    log: deps.log,
    onClosed: deps.onClosed,
  });
}
