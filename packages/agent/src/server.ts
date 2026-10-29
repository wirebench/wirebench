/**
 * The agent's loopback server (hosted edition spec §18.3): `ws://127.0.0.1:<port>/host`, for a browser tab
 * at a paired Wirebench Server. Nothing is served to a socket before all of these hold:
 *
 * 1. The upgrade's `Host` is `127.0.0.1:<port>` or `localhost:<port>`: a page that rebinds its own name to
 *    127.0.0.1 sends its own name, and is refused before the WebSocket handshake.
 * 2. Its `Origin` is a paired origin, or the socket closes `4403` before any frame.
 * 3. Its first frame is `{ type: 'auth', pairingId, nonce }` for a pairing of that origin, and the agent
 *    itself redeemed the nonce at that pairing's server, signed with its key; otherwise `4401`. The peer
 *    has {@link HOST_AUTH_TIMEOUT_MS} to get there.
 *
 * Then the hello goes out and calls are served: the agent's own `agent.*` handlers only (`allowlist.ts`),
 * never the embedder's host table. The browser caller gets no scope on that host: nothing of the desktop's
 * own windows, workspaces or channels is its. A pairing that goes away (unpaired here, or removed from the
 * pairings file by another process) ends its sockets `4401`; the file is re-read on every preflight,
 * upgrade and auth frame, and every {@link AGENT_REFRESH_INTERVAL_MS} besides.
 *
 * Plain HTTP answers only the private-network preflight (`OPTIONS /host`) for a paired origin; anything
 * else is a bare `404`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import {
  HOST_AUTH_TIMEOUT_MS,
  HOST_CLOSE,
  HOST_LIMITS,
  runHostSocket,
  type CallFrame,
  type Caller,
  type Host,
  type HostPlatform,
  type HostSocket,
  type HostSocketReady,
  type ReplyFrame,
} from '@wirebench/host';
import { browserCapabilities, isAgentChannel } from './allowlist.js';
import { redeemNonce, reportPort, type AgentFetch } from './pair.js';
import type { Pairing, PairingStore } from './pairings.js';
import { AGENT_PORTS } from './ports.js';

/**
 * The first browser caller's id. A host's callers share one id space with the desktop's windows, whose ids
 * are Electron's `webContents` ids (small, counting up from 1), so the agent's start far above them.
 */
export const AGENT_CALLER_ID_BASE = 1_000_000;

/** Sockets the agent holds open at once, every tab together; the next closes `4429`. */
export const AGENT_MAX_SOCKETS = 16;

/** How often a running agent re-reads its pairings file. */
export const AGENT_REFRESH_INTERVAL_MS = 2_000;

/** How long `close()` waits for peers to answer the close before cutting them off. */
const CLOSE_GRACE_MS = 1_000;

/** The path of the socket. */
const SOCKET_PATH = '/host';

const authFrameSchema = z
  .object({
    type: z.literal('auth'),
    pairingId: z.string().min(1).max(128),
    nonce: z.string().min(1).max(128),
  })
  .strict();

/** What an `agent.*` handler gets: who asked, the pairing its tab proved itself with, and the embedder's host. */
export interface AgentCallContext {
  readonly caller: Caller;
  readonly pairing: Pairing;
  /** For a handler's own use (a send bundle may need the host's services); never a channel the tab calls. */
  readonly host: Host;
}

/** An agent-local channel: run by the agent itself, never by the embedder's host. */
export type AgentHandler = (request: unknown, context: AgentCallContext) => Promise<unknown>;

export interface StartAgentOptions {
  /** The embedder's host, handed to `agent.*` handlers; a browser caller reaches none of its channels. */
  readonly host: Host;
  readonly platform: Pick<HostPlatform, 'capabilities' | 'app'>;
  readonly store: PairingStore;
  readonly fetch?: AgentFetch;
  /** The ports to try, in order; {@link AGENT_PORTS} when absent. */
  readonly ports?: readonly number[];
  /** The time a socket has to pass its `auth` frame; {@link HOST_AUTH_TIMEOUT_MS} when absent. */
  readonly authTimeoutMs?: number;
  /** More `agent.*` handlers (`agent.send` and the rest come with the send bundle). */
  readonly handlers?: ReadonlyMap<string, AgentHandler>;
  /**
   * How often the pairings file is re-read while the agent runs, so a pairing another process removed ends
   * its sockets without a request coming in; {@link AGENT_REFRESH_INTERVAL_MS} when absent. The file is also
   * re-read on every preflight, upgrade and auth frame.
   */
  readonly refreshIntervalMs?: number;
  /** Where a failure goes; never handed a frame, a nonce or a key. */
  readonly log?: (message: string, error: unknown) => void;
}

export interface RunningAgent {
  readonly port: number;
  /** Ends every socket (`1001`), stops listening and waits for port reports already started. */
  close(): Promise<void>;
}

/** No port in the range was free. */
export class AgentPortsBusyError extends Error {
  constructor(readonly ports: readonly number[]) {
    super(`No port from ${String(ports[0])} to ${String(ports.at(-1))} is free on 127.0.0.1`);
    this.name = 'AgentPortsBusyError';
  }
}

function listenOn(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
      else reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port, host: '127.0.0.1', exclusive: true });
  });
}

/** The one value of a header, or `undefined` when it is missing or repeated. */
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function pathOf(request: IncomingMessage): string {
  const url = request.url ?? '';
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

function refuseUpgrade(socket: Duplex, status: 403 | 404): void {
  const text = status === 403 ? 'Forbidden' : 'Not Found';
  socket.end(`HTTP/1.1 ${String(status)} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** The answer to every channel a browser caller may not reach, `agent.*` without a local handler included. */
function refused(frame: CallFrame): ReplyFrame {
  const dot = frame.channel.indexOf('.');
  const capability = dot === -1 ? frame.channel : frame.channel.slice(0, dot);
  return {
    id: frame.id,
    ok: false,
    error: {
      code: 'host-capability-missing',
      message: `This host does not serve ${capability} calls`,
      details: { capability },
    },
  };
}

/**
 * Starts the agent on the first free port of `ports`, on `127.0.0.1` only. It starts with no pairings as
 * readily as with some; the embedder decides when. A pairing whose server has not been told this port is
 * told it, signed, in the background.
 */
export async function startAgent(options: StartAgentOptions): Promise<RunningAgent> {
  const { host, platform, store } = options;
  const fetch: AgentFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const log = options.log ?? (() => undefined);
  const ports = options.ports ?? AGENT_PORTS;
  /** Every open socket, and the pairing it proved itself with once it has. */
  const sockets = new Map<HostSocket, { pairingId?: string }>();
  const reports = new Set<Promise<void>>();
  let nextCallerId = AGENT_CALLER_ID_BASE;
  let port = 0;

  const pairedOrigin = (origin: string | undefined): boolean =>
    origin !== undefined && store.list().some((pairing) => pairing.origin === origin);

  /** The pairings as they are on disk now; on a read failure, as last read. */
  const fresh = (): Promise<void> =>
    store.refresh().catch((error: unknown) => {
      log('the pairings file could not be read again', error);
    });

  // A pairing that is gone (unpaired here, or removed from the file by another process) ends its tabs.
  const prune = (): void => {
    for (const [socket, bound] of sockets) {
      if (bound.pairingId !== undefined && store.get(bound.pairingId) === undefined) {
        socket.end(HOST_CLOSE.unauthenticated, 'unpaired');
      }
    }
  };
  const unsubscribe = store.onChange(prune);
  const refresher = setInterval(() => {
    void fresh();
  }, options.refreshIntervalMs ?? AGENT_REFRESH_INTERVAL_MS);
  refresher.unref();

  const http = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const origin = header(request, 'origin');
      const preflight = request.method === 'OPTIONS' && pathOf(request) === SOCKET_PATH;
      if (preflight) await fresh();
      if (preflight && pairedOrigin(origin)) {
        response.writeHead(204, {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Private-Network': 'true',
          Vary: 'Origin',
        });
        response.end();
        return;
      }
      response.writeHead(404, { 'Content-Length': '0' });
      response.end();
    })();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: HOST_LIMITS.maxFrameBytes });

  const handlers = new Map<string, AgentHandler>([
    [
      'agent.hello',
      (_request, { pairing }) =>
        Promise.resolve({
          capabilities: browserCapabilities(platform.capabilities),
          version: platform.app.version(),
          sshOptIn: pairing.sshOptIn,
        }),
    ],
    ...(options.handlers ?? []),
  ]);

  const serve = async (caller: Caller, pairing: Pairing, frame: CallFrame): Promise<ReplyFrame> => {
    // Only the agent's own handlers are reachable: never the host's table, not even for an `agent.*` name.
    const local = isAgentChannel(frame.channel) ? handlers.get(frame.channel) : undefined;
    if (local === undefined) return refused(frame);
    try {
      return { id: frame.id, ok: true, value: await local(frame.request, { caller, pairing, host }) };
    } catch (error) {
      log('an agent call failed', error);
      return { id: frame.id, ok: false, error: { code: 'internal-error', message: 'The call failed' } };
    }
  };

  const accept = (ws: WebSocket, origin: string): void => {
    const callerId = nextCallerId;
    nextCallerId += 1;
    let admit: (ready: HostSocketReady | undefined) => void = () => undefined;
    const ready = new Promise<HostSocketReady | undefined>((resolve) => {
      admit = resolve;
    });
    const bound: { pairingId?: string } = {};
    // The redeem stops when the socket does (its deadline passed, or the peer went).
    const abort = new AbortController();
    const socket = runHostSocket(ws, {
      ready,
      callerId,
      limits: HOST_LIMITS,
      log,
      authTimeoutMs: options.authTimeoutMs ?? HOST_AUTH_TIMEOUT_MS,
      onClosed: () => {
        sockets.delete(socket);
        abort.abort();
        admit(undefined);
      },
      beforeReady: async (frame) => {
        const auth = authFrameSchema.safeParse(frame);
        if (!auth.success) return false;
        await fresh();
        const pairing = store.get(auth.data.pairingId);
        // A tab proves itself only for a pairing of the origin it came from.
        if (pairing === undefined || pairing.origin !== origin) return false;
        try {
          await redeemNonce(pairing, auth.data.nonce, store, fetch, abort.signal);
        } catch (error) {
          log('a tab could not be let in', error);
          return false;
        }
        // Unpaired while the redeem ran.
        if (store.get(pairing.pairingId) === undefined) return false;
        bound.pairingId = pairing.pairingId;
        admit({
          hello: {
            type: 'hello',
            host: 'agent',
            capabilities: browserCapabilities(platform.capabilities),
            sshOptIn: pairing.sshOptIn,
          },
          // No scope on the host: a browser caller reaches nothing of it.
          attach: () => undefined,
          serve: (caller, call) => serve(caller, pairing, call),
          detach: () => Promise.resolve(),
        });
        return true;
      },
    });
    sockets.set(socket, bound);
  };

  http.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => undefined);
    const hostHeader = header(request, 'host');
    if (pathOf(request) !== SOCKET_PATH) {
      refuseUpgrade(socket, 404);
      return;
    }
    // DNS rebinding: a page whose name now points at 127.0.0.1 still sends that name.
    if (hostHeader !== `127.0.0.1:${String(port)}` && hostHeader !== `localhost:${String(port)}`) {
      refuseUpgrade(socket, 403);
      return;
    }
    void fresh().then(() => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.on('error', () => undefined);
        const origin = header(request, 'origin');
        if (origin === undefined || !pairedOrigin(origin)) {
          ws.close(HOST_CLOSE.forbidden, 'forbidden');
          return;
        }
        if (sockets.size >= AGENT_MAX_SOCKETS) {
          ws.close(HOST_CLOSE.tooManySockets, 'too many sockets');
          return;
        }
        accept(ws, origin);
      });
    });
  });

  for (const candidate of ports) {
    if (await listenOn(http, candidate)) {
      port = candidate;
      break;
    }
  }
  if (port === 0) {
    clearInterval(refresher);
    unsubscribe();
    throw new AgentPortsBusyError(ports);
  }

  for (const pairing of store.list()) {
    if (pairing.port === port) continue;
    const report = reportPort(pairing, port, store, fetch)
      .catch((error: unknown) => {
        log('a paired server could not be told the agent port', error);
      })
      .finally(() => {
        reports.delete(report);
      });
    reports.add(report);
  }

  let closing: Promise<void> | undefined;
  return {
    port,
    close: () => {
      closing ??= (async () => {
        clearInterval(refresher);
        unsubscribe();
        for (const socket of [...sockets.keys()]) socket.end(HOST_CLOSE.goingAway, 'agent stopping');
        // A peer gets a moment to answer the close; one that does not is cut off.
        await Promise.race([
          Promise.all(
            [...wss.clients].map(
              (client) =>
                new Promise<void>((resolve) => {
                  if (client.readyState === client.CLOSED) resolve();
                  else client.once('close', () => resolve());
                }),
            ),
          ),
          new Promise<void>((resolve) => setTimeout(resolve, CLOSE_GRACE_MS).unref()),
        ]);
        for (const client of wss.clients) client.terminate();
        await new Promise<void>((resolve) => {
          wss.close(() => {
            resolve();
          });
        });
        http.closeAllConnections();
        await new Promise<void>((resolve) => {
          http.close(() => {
            resolve();
          });
        });
        await Promise.allSettled([...reports]);
      })();
      return closing;
    },
  };
}
