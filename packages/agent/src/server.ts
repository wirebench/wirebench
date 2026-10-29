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
 * Then the hello goes out and calls are served, `agent.*` only (`allowlist.ts`). The browser caller gets
 * no scope on the embedder's host: nothing of the desktop's own windows, workspaces or channels is its.
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
  serveCall,
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

/** What an `agent.*` handler gets: who asked, and the pairing its tab proved itself with. */
export interface AgentCallContext {
  readonly caller: Caller;
  readonly pairing: Pairing;
}

/** An agent-local channel: run by the agent itself, never by the embedder's host. */
export type AgentHandler = (request: unknown, context: AgentCallContext) => Promise<unknown>;

export interface StartAgentOptions {
  /** The embedder's host; a browser caller reaches none of its channels (the allowlist answers for it). */
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
  const sockets = new Set<HostSocket>();
  const reports = new Set<Promise<void>>();
  let nextCallerId = AGENT_CALLER_ID_BASE;
  let port = 0;

  const pairedOrigin = (origin: string | undefined): boolean =>
    origin !== undefined && store.list().some((pairing) => pairing.origin === origin);

  const http = createServer((request: IncomingMessage, response: ServerResponse) => {
    const origin = header(request, 'origin');
    if (request.method === 'OPTIONS' && pathOf(request) === SOCKET_PATH && pairedOrigin(origin)) {
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
    const local = isAgentChannel(frame.channel) ? handlers.get(frame.channel) : undefined;
    // Everything else goes to the host's own dispatch, which answers `host-capability-missing` for any
    // channel the allowlist refuses: one refusal, spelled once.
    if (local === undefined) return serveCall(host, caller, frame, isAgentChannel);
    try {
      return { id: frame.id, ok: true, value: await local(frame.request, { caller, pairing }) };
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
    const socket = runHostSocket(ws, {
      ready,
      callerId,
      limits: HOST_LIMITS,
      log,
      authTimeoutMs: options.authTimeoutMs ?? HOST_AUTH_TIMEOUT_MS,
      onClosed: () => {
        sockets.delete(socket);
        admit(undefined);
      },
      beforeReady: async (frame) => {
        const auth = authFrameSchema.safeParse(frame);
        if (!auth.success) return false;
        const pairing = store.get(auth.data.pairingId);
        // A tab proves itself only for a pairing of the origin it came from.
        if (pairing === undefined || pairing.origin !== origin) return false;
        try {
          await redeemNonce(pairing, auth.data.nonce, store, fetch);
        } catch (error) {
          log('a tab could not be let in', error);
          return false;
        }
        // Unpaired while the redeem ran.
        if (store.get(pairing.pairingId) === undefined) return false;
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
    sockets.add(socket);
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

  for (const candidate of ports) {
    if (await listenOn(http, candidate)) {
      port = candidate;
      break;
    }
  }
  if (port === 0) throw new AgentPortsBusyError(ports);

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
        for (const socket of [...sockets]) socket.end(HOST_CLOSE.goingAway, 'agent stopping');
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
