/**
 * One live socket's loop (live-updates spec §3.1, §5.1): the auth timer, parsing, and the hand-off to
 * the hub. The token arrives only in the first message and is never logged, and no message is ever
 * logged (§6). `maxPayload` makes `ws` itself close an oversized message `1009` before it reaches this
 * loop. Listeners are attached synchronously, as `@fastify/websocket` requires, so no early frame is
 * dropped while the token lookup runs.
 */
import {
  LIVE_CLOSE,
  LIVE_LIMITS,
  liveClientMessageSchema,
  WirebenchError,
  type LiveClientMessage,
  type LiveServerMessage,
} from '@wirebench/engine';
import type { FastifyBaseLogger } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import type { TokenCaller } from '../identity/guard.js';
import type { LiveHub, LiveHubDeps, LiveSocket } from './hub.js';

export interface SocketLoopDeps {
  readonly hub: LiveHub;
  /** Identity's `callerForToken`, bound to the module's database, settings and clock (§5.1). */
  readonly authenticate: (token: string) => Promise<TokenCaller>;
  /** Identity's `tokenMaxMs`: a session ends at its token's `createdAt` plus this (§3.3). */
  readonly tokenMaxMs: number;
  readonly setTimer: LiveHubDeps['setTimer'];
  readonly log: FastifyBaseLogger;
}

/** What identity throws for a token that cannot open a session: answered `4401`, as HTTP answers 401 (§3.1). */
const REFUSED_SESSION: ReadonlySet<string> = new Set(['identity-unauthenticated', 'identity-user-disabled']);

const PONG = JSON.stringify({ type: 'pong' } satisfies LiveServerMessage);

function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
}

/** A client message, or `undefined` for anything the protocol does not allow (§3.1: `4400`). */
function parse(text: string): LiveClientMessage | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const result = liveClientMessageSchema.safeParse(json);
  return result.success ? result.data : undefined;
}

/** The hub's view of one connection. Made once per connection: the hub keys its indexes on this object. */
function liveSocketOf(ws: WebSocket): LiveSocket {
  return {
    send: (text) => {
      ws.send(text);
    },
    close: (code, reason) => {
      ws.close(code, reason);
    },
    terminate: () => {
      ws.terminate();
    },
    ping: () => {
      ws.ping();
    },
    get isOpen() {
      return ws.readyState === ws.OPEN;
    },
  };
}

export function runLiveSocket(ws: WebSocket, deps: SocketLoopDeps): void {
  const socket = liveSocketOf(ws);
  /** `pending` until `auth` arrives, `authenticating` while identity looks the token up, then `ready`. */
  let phase: 'pending' | 'authenticating' | 'ready' = 'pending';
  let admitted = false;
  const end = (code: number, reason: string): void => {
    if (ws.readyState === ws.OPEN) ws.close(code, reason);
  };
  const authTimer = deps.setTimer(() => {
    if (phase !== 'ready') end(LIVE_CLOSE.authTimeout, 'no auth in time');
  }, LIVE_LIMITS.authTimeoutMs);

  const admit = async (token: string): Promise<void> => {
    let found: TokenCaller;
    try {
      found = await deps.authenticate(token);
    } catch (error) {
      authTimer.cancel();
      if (error instanceof WirebenchError && REFUSED_SESSION.has(error.code)) {
        end(LIVE_CLOSE.unauthenticated, 'unauthenticated');
      } else {
        deps.log.warn({ err: error }, 'live socket authentication failed');
        end(LIVE_CLOSE.serverError, 'server error');
      }
      return;
    }
    authTimer.cancel();
    // The client left, or the auth timer closed the socket, while the lookup ran: nothing to admit.
    if (ws.readyState !== ws.OPEN) return;
    // The hub answers `ready` itself, and itself closes 4429 past the user's socket limit, or 1001 once
    // it has shut down. It holds only authenticated sockets, so the loop's part ends here.
    const outcome = deps.hub.admit(socket, {
      tokenId: found.caller.tokenId,
      userId: found.caller.id,
      name: found.displayName,
      expiresAt: Date.parse(found.tokenCreatedAt) + deps.tokenMaxMs,
    });
    if (outcome === 'too-many-sockets') return;
    admitted = true;
    phase = 'ready';
  };

  ws.on('message', (data: RawData, isBinary: boolean) => {
    const message = isBinary ? undefined : parse(textOf(data));
    if (message === undefined) {
      end(LIVE_CLOSE.badMessage, 'bad message');
      return;
    }
    if (phase === 'pending' && message.type === 'auth') {
      phase = 'authenticating';
      admit(message.token).catch((error: unknown) => {
        deps.log.warn({ err: error }, 'live socket admission failed');
        end(LIVE_CLOSE.serverError, 'server error');
      });
      return;
    }
    // Anything before `ready`, and any later `auth`: a token is accepted only as the first message (§12).
    if (phase !== 'ready' || message.type === 'auth') {
      end(LIVE_CLOSE.badMessage, 'out of order');
      return;
    }
    switch (message.type) {
      case 'subscribe':
        // The hub closes 1011 itself when the role query fails; this only guards against a hub bug.
        deps.hub.subscribe(socket, message.workspaceId).catch((error: unknown) => {
          deps.log.warn({ err: error }, 'live subscribe failed');
          end(LIVE_CLOSE.serverError, 'server error');
        });
        return;
      case 'unsubscribe':
        deps.hub.unsubscribe(socket, message.workspaceId);
        return;
      case 'ping':
        socket.send(PONG);
        return;
    }
  });

  // The answer to the hub's protocol ping (§3.3 heartbeat); an unauthenticated socket has none to answer.
  ws.on('pong', () => {
    if (admitted) deps.hub.pong(socket);
  });

  ws.on('close', () => {
    authTimer.cancel();
    if (!admitted) return;
    admitted = false;
    deps.hub.remove(socket);
  });
}
