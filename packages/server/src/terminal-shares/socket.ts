/**
 * One shared-terminal socket's loop (team sessions spec B1): the auth timer, the checks on its first
 * message, and the hand-off to the registry. The token arrives only in the first message and is never
 * logged; no output or input is ever logged either. Listeners are attached synchronously, as
 * `@fastify/websocket` requires, so no early frame is lost while the checks run.
 */
import {
  TERMINAL_SHARE_CLOSE,
  TERMINAL_SHARE_LIMITS,
  terminalShareClientMessageSchema,
  WirebenchError,
  type TerminalShareClientMessage,
} from '@wirebench/engine';
import type { FastifyBaseLogger } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import type { AuditSource } from '../context.js';
import type { TokenCaller } from '../identity/guard.js';
import type { ShareRegistry, SharePeer } from './registry.js';

export interface ShareSocketDeps {
  readonly registry: ShareRegistry;
  readonly authenticate: (token: string) => Promise<TokenCaller>;
  readonly tokenMaxMs: number;
  /** The license has `terminal-sharing`. */
  readonly featureOn: () => Promise<boolean>;
  readonly canView: (userId: string, workspaceId: string) => Promise<boolean>;
  readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };
  readonly log: FastifyBaseLogger;
  /** The upgrade request's IP and user agent, for audit rows. */
  readonly request: Omit<AuditSource, 'actor'>;
}

const REFUSED_SESSION: ReadonlySet<string> = new Set(['identity-unauthenticated', 'identity-user-disabled']);

function bytesOf(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function parse(text: string): TerminalShareClientMessage | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const result = terminalShareClientMessageSchema.safeParse(json);
  return result.success ? result.data : undefined;
}

function peerOf(ws: WebSocket): SharePeer {
  return {
    sendText: (text) => {
      if (ws.readyState === ws.OPEN) ws.send(text);
    },
    sendBinary: (data) => {
      if (ws.readyState === ws.OPEN) ws.send(data, { binary: true });
    },
    close: (code, reason) => {
      if (ws.readyState === ws.OPEN) ws.close(code, reason);
    },
    terminate: () => {
      ws.terminate();
    },
    ping: () => {
      if (ws.readyState === ws.OPEN) ws.ping();
    },
    get isOpen() {
      return ws.readyState === ws.OPEN;
    },
  };
}

export function runShareSocket(ws: WebSocket, deps: ShareSocketDeps): void {
  const peer = peerOf(ws);
  let phase: 'pending' | 'checking' | 'ready' = 'pending';
  const end = (code: number, reason: string): void => {
    if (ws.readyState === ws.OPEN) ws.close(code, reason);
  };
  const authTimer = deps.setTimer(() => {
    if (phase !== 'ready') end(TERMINAL_SHARE_CLOSE.authTimeout, 'no auth in time');
  }, TERMINAL_SHARE_LIMITS.authTimeoutMs);

  const admit = async (message: Extract<TerminalShareClientMessage, { type: 'auth' }>): Promise<void> => {
    let found: TokenCaller;
    try {
      found = await deps.authenticate(message.token);
    } catch (error) {
      authTimer.cancel();
      if (error instanceof WirebenchError && REFUSED_SESSION.has(error.code)) {
        end(TERMINAL_SHARE_CLOSE.unauthenticated, 'unauthenticated');
      } else {
        deps.log.warn({ err: error }, 'terminal share authentication failed');
        end(TERMINAL_SHARE_CLOSE.serverError, 'server error');
      }
      return;
    }
    const allowed = (await deps.featureOn()) && (await deps.canView(found.caller.id, message.workspaceId));
    authTimer.cancel();
    if (ws.readyState !== ws.OPEN) return;
    if (!allowed) {
      end(TERMINAL_SHARE_CLOSE.forbidden, 'forbidden');
      return;
    }
    const { caller } = found;
    const outcome = deps.registry.attach(
      peer,
      {
        userId: caller.id,
        name: found.displayName,
        tokenId: caller.tokenId,
        expiresAt: Date.parse(found.tokenCreatedAt) + deps.tokenMaxMs,
        source: {
          ...deps.request,
          actor: { kind: 'user', userId: caller.id, email: caller.email, tokenId: caller.tokenId },
        },
      },
      message.workspaceId,
      message.shareId,
    );
    switch (outcome) {
      case 'owner':
      case 'viewer':
        phase = 'ready';
        return;
      case 'not-found':
        end(TERMINAL_SHARE_CLOSE.notFound, 'not found');
        return;
      case 'removed':
        end(TERMINAL_SHARE_CLOSE.forbidden, 'removed');
        return;
      case 'owner-taken':
      case 'full':
        end(TERMINAL_SHARE_CLOSE.tooMany, outcome);
        return;
    }
  };

  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      if (phase !== 'ready' || deps.registry.output(peer, bytesOf(data)) === 'bad') {
        end(TERMINAL_SHARE_CLOSE.badMessage, 'bad message');
      }
      return;
    }
    const message = parse(bytesOf(data).toString('utf8'));
    if (message === undefined) {
      end(TERMINAL_SHARE_CLOSE.badMessage, 'bad message');
      return;
    }
    if (phase === 'pending' && message.type === 'auth') {
      phase = 'checking';
      admit(message).catch((error: unknown) => {
        deps.log.warn({ err: error }, 'terminal share admission failed');
        end(TERMINAL_SHARE_CLOSE.serverError, 'server error');
      });
      return;
    }
    if (phase !== 'ready' || message.type === 'auth') {
      end(TERMINAL_SHARE_CLOSE.badMessage, 'out of order');
      return;
    }
    if (deps.registry.message(peer, message) === 'bad') end(TERMINAL_SHARE_CLOSE.badMessage, 'not allowed');
  });

  ws.on('pong', () => {
    deps.registry.pong(peer);
  });

  ws.on('close', () => {
    authTimer.cancel();
    deps.registry.detach(peer);
  });
}
