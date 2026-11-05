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
import type { AttachOutcome, ShareIdentity, ShareRegistry, SharePeer } from './registry.js';
import type { RelayJoin } from './relay.js';
import { TENANT_SUSPENDED } from '../tenancy/resolve.js';
import type { TenantScope } from '../tenancy/scope.js';

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
  /** The tenant the socket connected to: a share is joined only there. */
  readonly tenant: TenantScope;
  /**
   * A share this instance does not hold, relayed to the instance that does (spec §20.6): `relayed` once the socket is
   * the relay's. Absent in `single`, which never dials.
   */
  readonly relay?: (socket: WebSocket, join: RelayJoin) => Promise<'relayed' | 'not-found'>;
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

/** The close an attach outcome other than `owner` or `viewer` ends a socket with. */
function refusalOf(outcome: Exclude<AttachOutcome, 'owner' | 'viewer'>): { code: number; reason: string } {
  switch (outcome) {
    case 'not-found':
      return { code: TERMINAL_SHARE_CLOSE.notFound, reason: 'not found' };
    case 'removed':
      return { code: TERMINAL_SHARE_CLOSE.forbidden, reason: 'removed' };
    case 'owner-taken':
    case 'full':
      return { code: TERMINAL_SHARE_CLOSE.tooMany, reason: outcome };
  }
}

/** An attached socket's frame: binary output or a text message, handed to the registry. */
function attachedMessage(
  registry: ShareRegistry,
  peer: SharePeer,
  data: RawData,
  isBinary: boolean,
  end: (code: number, reason: string) => void,
): void {
  if (isBinary) {
    if (registry.output(peer, bytesOf(data)) === 'bad') end(TERMINAL_SHARE_CLOSE.badMessage, 'bad message');
    return;
  }
  const message = parse(bytesOf(data).toString('utf8'));
  if (message === undefined) {
    end(TERMINAL_SHARE_CLOSE.badMessage, 'bad message');
    return;
  }
  if (message.type === 'auth') {
    end(TERMINAL_SHARE_CLOSE.badMessage, 'out of order');
    return;
  }
  if (registry.message(peer, message) === 'bad') end(TERMINAL_SHARE_CLOSE.badMessage, 'not allowed');
}

/**
 * A viewer relayed from another instance (spec §20.6), on this holder's internal listener: its token was checked and
 * its identity is the token's, so it is attached at once, and the registry's limit, control and audit apply here.
 */
export function runRelayedViewer(
  ws: WebSocket,
  deps: {
    readonly registry: ShareRegistry;
    readonly tenant: TenantScope;
    readonly who: ShareIdentity;
    readonly workspaceId: string;
    readonly shareId: string;
  },
): void {
  const peer = peerOf(ws);
  const end = (code: number, reason: string): void => {
    if (ws.readyState === ws.OPEN) ws.close(code, reason);
  };
  let attached = false;
  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (attached) attachedMessage(deps.registry, peer, data, isBinary, end);
    else end(TERMINAL_SHARE_CLOSE.badMessage, 'out of order');
  });
  ws.on('pong', () => {
    deps.registry.pong(peer);
  });
  ws.on('close', () => {
    deps.registry.detach(peer);
  });
  const outcome = deps.registry.attach(deps.tenant, peer, deps.who, deps.workspaceId, deps.shareId);
  if (outcome === 'viewer') {
    attached = true;
    return;
  }
  if (outcome === 'owner') {
    // The owner's socket never comes through the relay: its own instance holds the share.
    deps.registry.detach(peer);
    end(TERMINAL_SHARE_CLOSE.tooMany, 'owner-taken');
    return;
  }
  const refusal = refusalOf(outcome);
  end(refusal.code, refusal.reason);
}

export function runShareSocket(ws: WebSocket, deps: ShareSocketDeps): void {
  const peer = peerOf(ws);
  let phase: 'pending' | 'checking' | 'ready' | 'relayed' = 'pending';
  const end = (code: number, reason: string): void => {
    if (ws.readyState === ws.OPEN) ws.close(code, reason);
  };
  const authTimer = deps.setTimer(() => {
    if (phase !== 'ready' && phase !== 'relayed') end(TERMINAL_SHARE_CLOSE.authTimeout, 'no auth in time');
  }, TERMINAL_SHARE_LIMITS.authTimeoutMs);

  const admit = async (message: Extract<TerminalShareClientMessage, { type: 'auth' }>): Promise<void> => {
    let found: TokenCaller;
    try {
      found = await deps.authenticate(message.token);
    } catch (error) {
      authTimer.cancel();
      if (error instanceof WirebenchError && REFUSED_SESSION.has(error.code)) {
        end(TERMINAL_SHARE_CLOSE.unauthenticated, 'unauthenticated');
      } else if (error instanceof WirebenchError && error.code === TENANT_SUSPENDED) {
        // The tenant stopped since the upgrade resolved it (hosted edition spec §22.7, review I1).
        end(TERMINAL_SHARE_CLOSE.forbidden, TENANT_SUSPENDED);
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
    const who: ShareIdentity = {
      userId: caller.id,
      name: found.displayName,
      tokenId: caller.tokenId,
      expiresAt: Date.parse(found.tokenCreatedAt) + deps.tokenMaxMs,
      source: {
        ...deps.request,
        actor: { kind: 'user', userId: caller.id, email: caller.email, tokenId: caller.tokenId },
      },
    };
    const outcome = deps.registry.attach(deps.tenant, peer, who, message.workspaceId, message.shareId);
    if (outcome === 'owner' || outcome === 'viewer') {
      phase = 'ready';
      return;
    }
    if (outcome === 'not-found' && deps.relay !== undefined) {
      const join = { tenant: deps.tenant, workspaceId: message.workspaceId, shareId: message.shareId, who };
      if ((await deps.relay(ws, join)) === 'relayed') {
        phase = 'relayed';
        return;
      }
      if (ws.readyState !== ws.OPEN) return;
    }
    const refusal = refusalOf(outcome);
    end(refusal.code, refusal.reason);
  };

  ws.on('message', (data: RawData, isBinary: boolean) => {
    // Relayed: the relay pipes every frame to the holder, unread here.
    if (phase === 'relayed') return;
    if (phase === 'ready') {
      attachedMessage(deps.registry, peer, data, isBinary, end);
      return;
    }
    if (isBinary) {
      end(TERMINAL_SHARE_CLOSE.badMessage, 'bad message');
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
    end(TERMINAL_SHARE_CLOSE.badMessage, 'out of order');
  });

  ws.on('pong', () => {
    deps.registry.pong(peer);
  });

  ws.on('close', () => {
    authTimer.cancel();
    deps.registry.detach(peer);
  });
}
