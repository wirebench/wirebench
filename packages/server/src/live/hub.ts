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
 *
 * Every index is keyed by tenant first (hosted edition spec §19.8 guard 5): a workspace's subscribers are a
 * *room*, `tenantId:workspaceId`, and users, tokens and catch URL windows are keyed `tenantId:id` too. An
 * announcement names its tenant, so it reaches only that tenant's sockets, whatever ids another tenant has.
 */
import type { FastifyBaseLogger } from 'fastify';
import {
  LIVE_CLOSE,
  LIVE_LIMITS,
  type LivePresenceUser,
  type LiveServerMessage,
  type WorkspaceRole,
} from '@wirebench/engine';
import type {
  AccessChangedEvent,
  CaptureReceivedEvent,
  HeadMovedEvent,
  HooksChangedEvent,
  ScheduleRunFinishedEvent,
  SessionEndedEvent,
} from '../context.js';
import type { TenantScope } from '../tenancy/scope.js';
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
  /** The tenant the socket authenticated in: the hub's two queries run there (spec §19.8 guard 6). */
  readonly tenant: TenantScope;
}

export interface LiveHubDeps {
  readonly effectiveRole: (userId: string, workspaceId: string, tenant: TenantScope) => Promise<Effective>;
  readonly workspaceIdsOfTeam: (teamId: string, tenant: TenantScope) => Promise<string[]>;
  readonly log: FastifyBaseLogger;
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };
}

/** Node's `setTimeout` fires at once past 2^31 − 1 ms (about 24.8 days), and the default maximum token age is 180 days. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Per catch URL, at most one `capture` per this many milliseconds (webhook-capture §3.6). */
export const CAPTURE_WINDOW_MS = 250;

/** A catch URL's open window: the newest capture announced since its last `capture`, if any. */
interface CaptureWindow {
  held: CaptureReceivedEvent | undefined;
  timer: { cancel(): void } | undefined;
}

const byName = new Intl.Collator('en', { sensitivity: 'base' });

type RefusedCode = Extract<LiveServerMessage, { type: 'refused' }>['code'];
/** A workspace's subscribers in one tenant: `tenantId:workspaceId`. A tenant id is a UUID, so it holds no `:`. */
type Room = string;
type Pair = readonly [room: Room, userId: string];

const keyOf = (tenantId: string, id: string): string => `${tenantId}:${id}`;
const workspaceOf = (room: Room): string => room.slice(room.indexOf(':') + 1);

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
  /** The open coalescing windows, by catch URL id (webhook-capture §3.6). */
  private readonly captureWindows = new Map<string, CaptureWindow>();
  /** Subscribes and access re-checks still running, which {@link idle} waits for. */
  private readonly pending = new Set<Promise<void>>();
  /**
   * The access re-checks, one after another. Each writes back the role its query saw, so two
   * overlapping checks could otherwise record the older answer last and misreport the next change.
   */
  private rechecks: Promise<void> = Promise.resolve();
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
    if ((this.byUser.get(userKey(session))?.size ?? 0) >= LIVE_LIMITS.maxSocketsPerUser) {
      closeQuietly(socket, LIVE_CLOSE.tooManySockets, 'too many live connections');
      return 'too-many-sockets';
    }
    const state: SocketState = { session, subs: new Map(), deadline: undefined, awaitingPong: false };
    this.bySocket.set(socket, state);
    addTo(this.byUser, userKey(session), socket);
    addTo(this.byToken, tokenKey(session), socket);
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
    const room = roomOf(state.session, workspaceId);
    removeFrom(this.byWorkspace, room, socket);
    this.announcePresence(this.whoLeft([[room, state.session.userId]]));
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
  headMoved(event: HeadMovedEvent): void {
    const targets = [...(this.byWorkspace.get(keyOf(event.tenantId, event.workspaceId)) ?? [])].filter(
      (socket) => this.bySocket.get(socket)?.session.tokenId !== event.tokenId,
    );
    this.deliver(targets, { type: 'head', workspaceId: event.workspaceId, head: event.head });
  }

  /**
   * Re-checks the affected subscriptions in the background, so the announcement returns at once
   * (§3.3). Checks run one at a time, in the order the events came. Nothing subscribed means nothing
   * to re-check and no query.
   */
  accessChanged(event: AccessChangedEvent): void {
    if (![...this.byWorkspace.keys()].some((room) => room.startsWith(`${event.tenantId}:`))) return;
    this.rechecks = this.rechecks
      .then(() => this.recheck(event))
      .catch((error: unknown) => {
        this.deps.log.warn({ err: error }, 'live access re-check failed');
      });
    void this.track(this.rechecks);
  }

  /** `session-ended`, then close `4401`, for a token's sockets or a user's, minus `exceptTokenId` (§3.1). */
  sessionEnded(event: SessionEndedEvent): void {
    const sockets =
      'tokenId' in event
        ? [...(this.byToken.get(keyOf(event.tenantId, event.tokenId)) ?? [])]
        : [...(this.byUser.get(keyOf(event.tenantId, event.userId)) ?? [])].filter(
            (socket) => this.bySocket.get(socket)?.session.tokenId !== event.exceptTokenId,
          );
    if (sockets.length > 0) this.end(sockets);
  }

  /**
   * `capture` to every subscriber of the workspace (webhook-capture §3.6). A quiet catch URL's first
   * capture goes out at once and opens a 250 ms window; the window holds the newest capture announced
   * meanwhile and sends it when it ends. The desktop fetches everything after what it holds, so the
   * merged ones are not lost.
   */
  captureReceived(event: CaptureReceivedEvent): void {
    if (this.closed) return;
    const open = this.captureWindows.get(keyOf(event.tenantId, event.hookId));
    if (open === undefined) {
      this.sendCapture(event);
      return;
    }
    // Ids are monotonic, so the largest is the newest even if two announcements crossed.
    if (open.held === undefined || event.captureId > open.held.captureId) open.held = event;
  }

  /** `hooks` to every subscriber of the workspace: its catch URLs changed (webhook-capture §3.6). */
  hooksChanged(event: HooksChangedEvent): void {
    if (this.closed) return;
    this.deliver(this.byWorkspace.get(keyOf(event.tenantId, event.workspaceId)) ?? [], {
      type: 'hooks',
      workspaceId: event.workspaceId,
    });
  }

  /**
   * `schedule-run` to every subscriber of the workspace: one of its scheduled runs ended (scheduled-runs §3.5).
   * The executor's announcement has no tenant until Task 13 runs it per tenant: it then reaches the workspace's
   * rooms in every tenant, which before `0021` is the one tenant a workspace id can belong to.
   */
  scheduleRunFinished(event: ScheduleRunFinishedEvent): void {
    if (this.closed) return;
    const { workspaceId, scheduleId, runId, status } = event;
    const targets =
      event.tenantId !== undefined
        ? (this.byWorkspace.get(keyOf(event.tenantId, workspaceId)) ?? [])
        : [...this.byWorkspace]
            .filter(([room]) => workspaceOf(room) === workspaceId)
            .flatMap(([, sockets]) => [...sockets]);
    this.deliver(targets, {
      type: 'schedule-run',
      workspaceId,
      scheduleId,
      runId,
      status,
    });
  }

  /** Shutdown (§3.3, §5.1): closes every socket `1001` and clears the indexes. Later calls are no-ops. */
  closeAll(): void {
    this.closed = true;
    const sockets = [...this.bySocket.keys()];
    for (const state of this.bySocket.values()) state.deadline?.cancel();
    for (const open of this.captureWindows.values()) open.timer?.cancel();
    this.captureWindows.clear();
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
    if (this.full(state.session)) {
      this.refuse(socket, workspaceId, LIVE_TOO_MANY_SUBSCRIPTIONS);
      return;
    }
    let found: Effective;
    try {
      found = await this.deps.effectiveRole(state.session.userId, workspaceId, state.session.tenant);
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
    if (this.full(state.session)) {
      this.refuse(socket, workspaceId, LIVE_TOO_MANY_SUBSCRIPTIONS);
      return;
    }
    const room = roomOf(state.session, workspaceId);
    const arriving = !this.isPresent(room, state.session.userId);
    state.subs.set(workspaceId, found.role);
    addTo(this.byWorkspace, room, socket);
    const message: LiveServerMessage = { type: 'presence', workspaceId, users: this.presenceOf(room) };
    this.deliver(arriving ? (this.byWorkspace.get(room) ?? []) : [socket], message);
  }

  private refuse(socket: LiveSocket, workspaceId: string, code: RefusedCode): void {
    this.deliver([socket], { type: 'refused', workspaceId, code });
  }

  /** Sends `event` and opens its catch URL's window; the window re-sends what it held when it ends. */
  private sendCapture(event: CaptureReceivedEvent): void {
    const { workspaceId, hookId, captureId } = event;
    this.deliver(this.byWorkspace.get(keyOf(event.tenantId, workspaceId)) ?? [], {
      type: 'capture',
      workspaceId,
      hookId,
      captureId,
    });
    const slot: CaptureWindow = { held: undefined, timer: undefined };
    const windowKey = keyOf(event.tenantId, hookId);
    this.captureWindows.set(windowKey, slot);
    slot.timer = this.deps.setTimer(() => {
      this.captureWindows.delete(windowKey);
      if (slot.held !== undefined) this.sendCapture(slot.held);
    }, CAPTURE_WINDOW_MS);
  }

  /** §3.3: a session has at most 200 subscriptions across its sockets. */
  private full(session: LiveSession): boolean {
    let count = 0;
    for (const socket of this.byToken.get(tokenKey(session)) ?? []) count += this.bySocket.get(socket)?.subs.size ?? 0;
    return count >= LIVE_LIMITS.maxSubscriptionsPerSession;
  }

  private async recheck(event: AccessChangedEvent): Promise<void> {
    try {
      const pairs = new Map<
        string,
        { readonly userId: string; readonly workspaceId: string; readonly tenant: TenantScope }
      >();
      const rooms = await this.scope(event);
      if (this.closed) return;
      for (const room of rooms) {
        const workspaceId = workspaceOf(room);
        for (const socket of this.byWorkspace.get(room) ?? []) {
          const session = this.bySocket.get(socket)?.session;
          if (session === undefined || (event.userId !== undefined && event.userId !== session.userId)) continue;
          pairs.set(`${room} ${session.userId}`, {
            userId: session.userId,
            workspaceId,
            tenant: session.tenant,
          });
        }
      }
      const results: { readonly room: Room; readonly userId: string; readonly role: WorkspaceRole | 'none' }[] = [];
      // One query at a time: a team-wide change costs one per subscribed member, in the background (§15).
      for (const pair of pairs.values()) {
        if (this.closed) return; // closeAll() dropped every subscription: nothing is left to ask about
        const found = await this.deps.effectiveRole(pair.userId, pair.workspaceId, pair.tenant);
        results.push({ room: keyOf(pair.tenant.tenantId, pair.workspaceId), userId: pair.userId, role: found.role });
      }
      this.applyRoles(results);
    } catch (error) {
      // The desktop's safety-net fetch still converges (§3.3).
      this.deps.log.warn({ err: error, ...event }, 'live access re-check failed');
    }
  }

  /**
   * The subscribed rooms of the event's tenant an `AccessChanged` can touch (§3.2): its workspace, or its
   * team's. With only a user set, every workspace of that tenant is in scope.
   */
  private async scope(event: AccessChangedEvent): Promise<Room[]> {
    const rooms = new Set<Room>();
    if (event.workspaceId !== undefined) rooms.add(keyOf(event.tenantId, event.workspaceId));
    if (event.teamId !== undefined) {
      const teamWorkspaceIds = await this.deps.workspaceIdsOfTeam(event.teamId, event.tenant);
      if (this.closed) return [];
      for (const id of teamWorkspaceIds) rooms.add(keyOf(event.tenantId, id));
    }
    if (event.workspaceId === undefined && event.teamId === undefined) {
      for (const room of this.byWorkspace.keys()) if (room.startsWith(`${event.tenantId}:`)) rooms.add(room);
    }
    return [...rooms].filter((room) => this.byWorkspace.has(room));
  }

  /**
   * Step 3 of §3.3, on the indexes as they are now. Each subscription whose recorded role differs gets
   * `access`. Then it is dropped when the new role is `none`, or keeps the new role otherwise.
   * A socket found dead is discarded only after the loop, together with the drops, so one presence
   * goes out per workspace and none reaches a socket about to lose access.
   */
  private applyRoles(
    results: readonly { readonly room: Room; readonly userId: string; readonly role: WorkspaceRole | 'none' }[],
  ): void {
    const left: Pair[] = [];
    const dead: LiveSocket[] = [];
    for (const { room, userId, role } of results) {
      const workspaceId = workspaceOf(room);
      for (const socket of [...(this.byWorkspace.get(room) ?? [])]) {
        const state = this.bySocket.get(socket);
        const recorded = state?.subs.get(workspaceId);
        if (state === undefined || state.session.userId !== userId || recorded === undefined || recorded === role)
          continue;
        if (!trySend(socket, JSON.stringify({ type: 'access', workspaceId } satisfies LiveServerMessage))) {
          dead.push(socket);
          continue;
        }
        if (role === 'none') {
          state.subs.delete(workspaceId);
          removeFrom(this.byWorkspace, room, socket);
          left.push([room, userId]);
        } else {
          state.subs.set(workspaceId, role);
        }
      }
    }
    this.terminate(dead);
    const changed = this.detach(dead);
    for (const room of this.whoLeft(left)) changed.add(room);
    this.announcePresence(changed);
  }

  /** Ends a session by age, in steps no longer than a timer can wait (§3.3). */
  private armDeadline(socket: LiveSocket, state: SocketState): void {
    const remaining = state.session.expiresAt - this.deps.now();
    state.deadline =
      remaining > MAX_TIMER_MS
        ? this.deps.setTimer(() => {
            if (this.bySocket.get(socket) === state) this.armDeadline(socket, state);
          }, MAX_TIMER_MS)
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
    this.terminate(sockets);
    this.announcePresence(this.detach(sockets));
  }

  private terminate(sockets: readonly LiveSocket[]): void {
    for (const socket of sockets) {
      try {
        socket.terminate();
      } catch {
        // Already gone: the removal that follows is what matters.
      }
    }
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

  /** Takes sockets out of every index and cancels their timers. Returns the rooms whose user list changed. */
  private detach(sockets: Iterable<LiveSocket>): Set<Room> {
    const left: Pair[] = [];
    for (const socket of sockets) {
      const state = this.bySocket.get(socket);
      if (state === undefined) continue;
      state.deadline?.cancel();
      this.bySocket.delete(socket);
      removeFrom(this.byUser, userKey(state.session), socket);
      removeFrom(this.byToken, tokenKey(state.session), socket);
      for (const workspaceId of state.subs.keys()) {
        const room = roomOf(state.session, workspaceId);
        removeFrom(this.byWorkspace, room, socket);
        left.push([room, state.session.userId]);
      }
    }
    return this.whoLeft(left);
  }

  /** Of the (room, user) pairs that just lost a socket, the rooms where that user now has none. */
  private whoLeft(pairs: readonly Pair[]): Set<Room> {
    const changed = new Set<Room>();
    for (const [room, userId] of pairs) {
      if (!this.isPresent(room, userId)) changed.add(room);
    }
    return changed;
  }

  private isPresent(room: Room, userId: string): boolean {
    for (const socket of this.byWorkspace.get(room) ?? []) {
      if (this.bySocket.get(socket)?.session.userId === userId) return true;
    }
    return false;
  }

  /** §3.1: the distinct users subscribed, the recipient included, sorted by name and then id. */
  private presenceOf(room: Room): LivePresenceUser[] {
    const users = new Map<string, LivePresenceUser>();
    for (const socket of this.byWorkspace.get(room) ?? []) {
      const session = this.bySocket.get(socket)?.session;
      if (session !== undefined && !users.has(session.userId)) {
        users.set(session.userId, { id: session.userId, name: session.name });
      }
    }
    return [...users.values()].sort((a, b) => byName.compare(a.name, b.name) || compareIds(a.id, b.id));
  }

  private announcePresence(rooms: Iterable<Room>): void {
    for (const room of rooms) {
      const sockets = this.byWorkspace.get(room);
      if (sockets === undefined) continue;
      this.deliver(sockets, { type: 'presence', workspaceId: workspaceOf(room), users: this.presenceOf(room) });
    }
  }
}

const roomOf = (session: LiveSession, workspaceId: string): Room => keyOf(session.tenant.tenantId, workspaceId);
const userKey = (session: LiveSession): string => keyOf(session.tenant.tenantId, session.userId);
const tokenKey = (session: LiveSession): string => keyOf(session.tenant.tenantId, session.tokenId);

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
