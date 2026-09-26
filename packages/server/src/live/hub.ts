/**
 * The live hub (live-updates spec §3.3). It records which open sockets belong to which session, user
 * and workspace, and decides what each announcement sends to whom. There is one per server, built in
 * the module's `register()`. Everything is held in memory, which is why the server runs as a single
 * process (ADR-0013).
 *
 * The hub never parses a client message. `socket.ts` feeds it authenticated sessions and parsed
 * subscribes, and the after-commit announcements (§3.2) feed it events. It reaches the database only
 * through the two injected queries (§10), and it reads time only through the injected clock. A unit
 * test can therefore drive it with fake sockets and fake time.
 */
import type { FastifyBaseLogger } from 'fastify';
import {
  LIVE_CLOSE,
  LIVE_LIMITS,
  type LivePresenceUser,
  type LiveServerMessage,
  type WorkspaceRole,
} from '@wirebench/engine';
import type { AccessChanged, HeadMoved, SessionEnded } from '../context.js';
import type { Effective } from '../teams/roles.js';
import { LIVE_TOO_MANY_SUBSCRIPTIONS } from './errors.js';

/** The slice of a `ws` socket the hub uses. `socket.ts` adapts the real one, and tests pass a fake. */
export interface LiveSocket {
  send(text: string): void;
  close(code: number, reason?: string): void;
  /** Drops the connection without a close handshake, for a peer that stopped answering. */
  terminate(): void;
  /** A protocol-level ping. The peer's pong reaches {@link LiveHub.pong}. */
  ping(): void;
  readonly isOpen: boolean;
}

/** What `auth` bound a socket to (§3.3). */
export interface LiveSession {
  readonly tokenId: string;
  readonly userId: string;
  /** The display name presence shows. Never the email (§6). */
  readonly name: string;
  /** Milliseconds since the epoch: the token's `createdAt` plus `tokenMaxMs`, when the session ends by age. */
  readonly expiresAt: number;
}

export interface LiveHubDeps {
  readonly effectiveRole: (userId: string, workspaceId: string) => Promise<Effective>;
  readonly workspaceIdsOfTeam: (teamId: string) => Promise<string[]>;
  readonly log: FastifyBaseLogger;
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };
}

/** Node's `setTimeout` fires at once past 2^31 − 1 ms (about 24.8 days), and the default maximum token age is 180 days. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const byName = new Intl.Collator('en', { sensitivity: 'base' });

type RefusedCode = Extract<LiveServerMessage, { type: 'refused' }>['code'];
type Pair = readonly [workspaceId: string, userId: string];

/** Per authenticated socket. Its fields are mutable on purpose, because only the hub holds it. */
interface SocketState {
  readonly session: LiveSession;
  /** The role seen when each subscription was admitted or last re-checked (§3.1). */
  readonly subs: Map<string, WorkspaceRole>;
  deadline: { cancel(): void } | undefined;
  /** A heartbeat ping went out and no pong has come back yet. */
  awaitingPong: boolean;
}

export class LiveHub {
  private readonly bySocket = new Map<LiveSocket, SocketState>();
  private readonly byWorkspace = new Map<string, Set<LiveSocket>>();
  private readonly byUser = new Map<string, Set<LiveSocket>>();
  private readonly byToken = new Map<string, Set<LiveSocket>>();
  /** Subscribes and access re-checks still running, which {@link idle} waits for. */
  private readonly pending = new Set<Promise<void>>();
  private closed = false;

  constructor(private readonly deps: LiveHubDeps) {}

  /**
   * Binds an authenticated socket to its session (§3.3). The hub sends everything that follows.
   * - `'ok'`: the hub sent `ready` and armed the maximum-age timer. After {@link closeAll}, it closed
   *   the socket `1001` instead.
   * - `'too-many-sockets'`: the user already has 32 sockets, so the hub closed this one `4429` and
   *   kept nothing of it.
   */
  admit(socket: LiveSocket, session: LiveSession): 'ok' | 'too-many-sockets' {
    if (this.closed) {
      closeQuietly(socket, LIVE_CLOSE.goingAway, 'server shutting down');
      return 'ok';
    }
    if (this.bySocket.has(socket)) return 'ok';
    if ((this.byUser.get(session.userId)?.size ?? 0) >= LIVE_LIMITS.maxSocketsPerUser) {
      closeQuietly(socket, LIVE_CLOSE.tooManySockets, 'too many live connections');
      return 'too-many-sockets';
    }
    const state: SocketState = { session, subs: new Map(), deadline: undefined, awaitingPong: false };
    this.bySocket.set(socket, state);
    addTo(this.byUser, session.userId, socket);
    addTo(this.byToken, session.tokenId, socket);
    this.armDeadline(socket, state);
    this.deliver([socket], { type: 'ready' });
    return 'ok';
  }

  /**
   * Admits a subscription at the role `effectiveRole` reports (§3.1).
   * - `none` answers `refused` with the HTTP code, so an id reveals nothing.
   * - A session's 201st subscription answers `live-too-many-subscriptions`.
   * - An admitted one sends this socket `presence`. Every subscriber gets it when this user is new to
   *   the workspace.
   * - A repeat, or a socket the hub does not hold, is a no-op.
   *
   * It never rejects. A failed query is logged and closes the socket `1011`.
   */
  subscribe(socket: LiveSocket, workspaceId: string): Promise<void> {
    return this.track(this.admitSubscription(socket, workspaceId));
  }

  /** Silent to the socket leaving. The others get `presence` if its user has no other socket there (§3.1). */
  unsubscribe(socket: LiveSocket, workspaceId: string): void {
    const state = this.bySocket.get(socket);
    if (state === undefined || !state.subs.delete(workspaceId)) return;
    removeFrom(this.byWorkspace, workspaceId, socket);
    this.announcePresence(this.whoLeft([[workspaceId, state.session.userId]]));
  }

  /** The socket closed. Idempotent: a socket the hub already ended, dropped or never held changes nothing. */
  remove(socket: LiveSocket): void {
    this.announcePresence(this.detach([socket]));
  }

  /** Every 30 s (§3.3): a protocol ping to each socket, and termination for one that missed the previous ping. */
  heartbeat(): void {
    const silent: LiveSocket[] = [];
    for (const [socket, state] of this.bySocket) {
      if (state.awaitingPong) {
        silent.push(socket);
        continue;
      }
      state.awaitingPong = true;
      try {
        socket.ping();
      } catch {
        silent.push(socket);
      }
    }
    if (silent.length > 0) this.discard(silent);
  }

  /** The peer answered the last protocol ping. */
  pong(socket: LiveSocket): void {
    const state = this.bySocket.get(socket);
    if (state !== undefined) state.awaitingPong = false;
  }

  /** `head` to every subscriber of the workspace except the pushing session's sockets (§3.1). */
  headMoved(event: HeadMoved): void {
    const targets = [...(this.byWorkspace.get(event.workspaceId) ?? [])].filter(
      (socket) => this.bySocket.get(socket)?.session.tokenId !== event.tokenId,
    );
    this.deliver(targets, { type: 'head', workspaceId: event.workspaceId, head: event.head });
  }

  /**
   * Re-checks the affected subscriptions in the background, so the announcement returns at once
   * (§3.3). Nothing subscribed means nothing to re-check and no query.
   */
  accessChanged(event: AccessChanged): void {
    if (this.byWorkspace.size === 0) return;
    void this.track(this.recheck(event));
  }

  /** `session-ended`, then close `4401`, for a token's sockets or a user's, minus `exceptTokenId` (§3.1). */
  sessionEnded(event: SessionEnded): void {
    const sockets =
      'tokenId' in event
        ? [...(this.byToken.get(event.tokenId) ?? [])]
        : [...(this.byUser.get(event.userId) ?? [])].filter(
            (socket) => this.bySocket.get(socket)?.session.tokenId !== event.exceptTokenId,
          );
    if (sockets.length > 0) this.end(sockets);
  }

  /** Shutdown (§3.3, §5.1): closes every socket `1001` and clears the indexes. Later calls are no-ops. */
  closeAll(): void {
    this.closed = true;
    const sockets = [...this.bySocket.keys()];
    for (const state of this.bySocket.values()) state.deadline?.cancel();
    this.bySocket.clear();
    this.byWorkspace.clear();
    this.byUser.clear();
    this.byToken.clear();
    for (const socket of sockets) closeQuietly(socket, LIVE_CLOSE.goingAway, 'server shutting down');
  }

  /** Settles once every subscribe and access re-check under way has finished. Tests use it in place of sleeping. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private track(work: Promise<void>): Promise<void> {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
    return work;
  }

  private async admitSubscription(socket: LiveSocket, workspaceId: string): Promise<void> {
    const state = this.bySocket.get(socket);
    if (state === undefined || state.subs.has(workspaceId)) return;
    if (this.full(state.session.tokenId)) {
      this.refuse(socket, workspaceId, LIVE_TOO_MANY_SUBSCRIPTIONS);
      return;
    }
    let found: Effective;
    try {
      found = await this.deps.effectiveRole(state.session.userId, workspaceId);
    } catch (error) {
      this.deps.log.warn({ err: error, workspaceId }, 'live subscribe role check failed');
      if (this.bySocket.get(socket) === state) this.fail(socket);
      return;
    }
    // While the query ran, the socket may have closed, a repeat may have been admitted, or the session filled up.
    if (this.bySocket.get(socket) !== state || state.subs.has(workspaceId)) return;
    if (found.role === 'none') {
      this.refuse(socket, workspaceId, 'teams-workspace-not-found');
      return;
    }
    if (this.full(state.session.tokenId)) {
      this.refuse(socket, workspaceId, LIVE_TOO_MANY_SUBSCRIPTIONS);
      return;
    }
    const arriving = !this.isPresent(workspaceId, state.session.userId);
    state.subs.set(workspaceId, found.role);
    addTo(this.byWorkspace, workspaceId, socket);
    const message: LiveServerMessage = { type: 'presence', workspaceId, users: this.presenceOf(workspaceId) };
    this.deliver(arriving ? (this.byWorkspace.get(workspaceId) ?? []) : [socket], message);
  }

  private refuse(socket: LiveSocket, workspaceId: string, code: RefusedCode): void {
    this.deliver([socket], { type: 'refused', workspaceId, code });
  }

  /** §3.3: a session has at most 200 subscriptions across its sockets. */
  private full(tokenId: string): boolean {
    let count = 0;
    for (const socket of this.byToken.get(tokenId) ?? []) count += this.bySocket.get(socket)?.subs.size ?? 0;
    return count >= LIVE_LIMITS.maxSubscriptionsPerSession;
  }

  private async recheck(event: AccessChanged): Promise<void> {
    try {
      const pairs = new Map<string, { readonly userId: string; readonly workspaceId: string }>();
      for (const workspaceId of await this.scope(event)) {
        for (const socket of this.byWorkspace.get(workspaceId) ?? []) {
          const userId = this.bySocket.get(socket)?.session.userId;
          if (userId === undefined || (event.userId !== undefined && event.userId !== userId)) continue;
          pairs.set(`${userId} ${workspaceId}`, { userId, workspaceId });
        }
      }
      const results: {
        readonly userId: string;
        readonly workspaceId: string;
        readonly role: WorkspaceRole | 'none';
      }[] = [];
      // One query at a time: a team-wide change costs one per subscribed member, in the background (§15).
      for (const pair of pairs.values()) {
        const found = await this.deps.effectiveRole(pair.userId, pair.workspaceId);
        results.push({ ...pair, role: found.role });
      }
      this.applyRoles(results);
    } catch (error) {
      // The desktop's safety-net fetch still converges (§3.3).
      this.deps.log.warn({ err: error, ...event }, 'live access re-check failed');
    }
  }

  /**
   * The subscribed workspaces an `AccessChanged` can touch (§3.2): its workspace, or its team's. With
   * only a user set, every workspace is in scope.
   */
  private async scope(event: AccessChanged): Promise<string[]> {
    const ids = new Set<string>();
    if (event.workspaceId !== undefined) ids.add(event.workspaceId);
    if (event.teamId !== undefined) {
      for (const id of await this.deps.workspaceIdsOfTeam(event.teamId)) ids.add(id);
    }
    if (event.workspaceId === undefined && event.teamId === undefined) {
      for (const id of this.byWorkspace.keys()) ids.add(id);
    }
    return [...ids].filter((id) => this.byWorkspace.has(id));
  }

  /**
   * Step 3 of §3.3, on the indexes as they are now. Each subscription whose recorded role differs gets
   * `access`. Then it is dropped when the new role is `none`, or keeps the new role otherwise.
   */
  private applyRoles(
    results: readonly {
      readonly userId: string;
      readonly workspaceId: string;
      readonly role: WorkspaceRole | 'none';
    }[],
  ): void {
    const left: Pair[] = [];
    for (const { userId, workspaceId, role } of results) {
      for (const socket of [...(this.byWorkspace.get(workspaceId) ?? [])]) {
        const state = this.bySocket.get(socket);
        const recorded = state?.subs.get(workspaceId);
        if (state === undefined || state.session.userId !== userId || recorded === undefined || recorded === role)
          continue;
        this.deliver([socket], { type: 'access', workspaceId });
        if (this.bySocket.get(socket) !== state) continue; // the send found it dead, and it is already gone
        if (role === 'none') {
          state.subs.delete(workspaceId);
          removeFrom(this.byWorkspace, workspaceId, socket);
          left.push([workspaceId, userId]);
        } else {
          state.subs.set(workspaceId, role);
        }
      }
    }
    this.announcePresence(this.whoLeft(left));
  }

  /** Ends a session by age, in steps no longer than a timer can wait (§3.3). */
  private armDeadline(socket: LiveSocket, state: SocketState): void {
    const remaining = state.session.expiresAt - this.deps.now();
    state.deadline =
      remaining > MAX_TIMER_MS
        ? this.deps.setTimer(() => this.armDeadline(socket, state), MAX_TIMER_MS)
        : this.deps.setTimer(
            () => {
              if (this.bySocket.get(socket) === state) this.end([socket]);
            },
            Math.max(0, remaining),
          );
  }

  /** `session-ended` and `4401`. The sockets are detached first, so the presence that follows never reaches them. */
  private end(sockets: readonly LiveSocket[]): void {
    const changed = this.detach(sockets);
    const text = JSON.stringify({ type: 'session-ended' } satisfies LiveServerMessage);
    for (const socket of sockets) {
      trySend(socket, text);
      closeQuietly(socket, LIVE_CLOSE.unauthenticated, 'session ended');
    }
    this.announcePresence(changed);
  }

  /** `1011`: this socket hit a server error. It reconnects with back-off (§3.1). */
  private fail(socket: LiveSocket): void {
    const changed = this.detach([socket]);
    closeQuietly(socket, LIVE_CLOSE.serverError, 'server error');
    this.announcePresence(changed);
  }

  /** Terminates dead or silent sockets and removes them. One dead socket never affects another (§3.3). */
  private discard(sockets: readonly LiveSocket[]): void {
    for (const socket of sockets) {
      try {
        socket.terminate();
      } catch {
        // Already gone: the removal below is what matters.
      }
    }
    this.announcePresence(this.detach(sockets));
  }

  /** Sends one message to each target. A socket that is not open, or whose send throws, is discarded afterwards. */
  private deliver(targets: Iterable<LiveSocket>, message: LiveServerMessage): void {
    const text = JSON.stringify(message);
    const dead: LiveSocket[] = [];
    for (const socket of [...targets]) {
      if (!trySend(socket, text)) dead.push(socket);
    }
    if (dead.length > 0) this.discard(dead);
  }

  /** Takes sockets out of every index and cancels their timers. Returns the workspaces whose user list changed. */
  private detach(sockets: Iterable<LiveSocket>): Set<string> {
    const left: Pair[] = [];
    for (const socket of sockets) {
      const state = this.bySocket.get(socket);
      if (state === undefined) continue;
      state.deadline?.cancel();
      this.bySocket.delete(socket);
      removeFrom(this.byUser, state.session.userId, socket);
      removeFrom(this.byToken, state.session.tokenId, socket);
      for (const workspaceId of state.subs.keys()) {
        removeFrom(this.byWorkspace, workspaceId, socket);
        left.push([workspaceId, state.session.userId]);
      }
    }
    return this.whoLeft(left);
  }

  /** Of the (workspace, user) pairs that just lost a socket, the workspaces where that user now has none. */
  private whoLeft(pairs: readonly Pair[]): Set<string> {
    const changed = new Set<string>();
    for (const [workspaceId, userId] of pairs) {
      if (!this.isPresent(workspaceId, userId)) changed.add(workspaceId);
    }
    return changed;
  }

  private isPresent(workspaceId: string, userId: string): boolean {
    for (const socket of this.byWorkspace.get(workspaceId) ?? []) {
      if (this.bySocket.get(socket)?.session.userId === userId) return true;
    }
    return false;
  }

  /** §3.1: the distinct users subscribed, the recipient included, sorted by name and then id. */
  private presenceOf(workspaceId: string): LivePresenceUser[] {
    const users = new Map<string, LivePresenceUser>();
    for (const socket of this.byWorkspace.get(workspaceId) ?? []) {
      const session = this.bySocket.get(socket)?.session;
      if (session !== undefined && !users.has(session.userId)) {
        users.set(session.userId, { id: session.userId, name: session.name });
      }
    }
    return [...users.values()].sort((a, b) => byName.compare(a.name, b.name) || compareIds(a.id, b.id));
  }

  private announcePresence(workspaceIds: Iterable<string>): void {
    for (const workspaceId of workspaceIds) {
      const sockets = this.byWorkspace.get(workspaceId);
      if (sockets === undefined) continue;
      this.deliver(sockets, { type: 'presence', workspaceId, users: this.presenceOf(workspaceId) });
    }
  }
}

function addTo<K>(index: Map<K, Set<LiveSocket>>, key: K, socket: LiveSocket): void {
  const sockets = index.get(key);
  if (sockets === undefined) index.set(key, new Set([socket]));
  else sockets.add(socket);
}

function removeFrom<K>(index: Map<K, Set<LiveSocket>>, key: K, socket: LiveSocket): void {
  const sockets = index.get(key);
  if (sockets === undefined) return;
  sockets.delete(socket);
  if (sockets.size === 0) index.delete(key);
}

/** §3.3 *Send*: `false` when the socket is not open or its send throws; the caller discards it. */
function trySend(socket: LiveSocket, text: string): boolean {
  if (!socket.isOpen) return false;
  try {
    socket.send(text);
    return true;
  } catch {
    return false;
  }
}

function closeQuietly(socket: LiveSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Already closed: nothing more to tell the peer.
  }
}

/** Code-unit order: deterministic, and ids are ASCII. */
function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
