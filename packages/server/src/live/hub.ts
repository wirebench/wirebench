/**
 * The live hub (live-updates spec §3.3). It records which open sockets belong to which session, user
 * and workspace, and decides what each announcement sends to whom. There is one per server, built in
 * the module's `register()`. Everything is held in memory, per process (ADR-0013, as amended by ADR-0037).
 *
 * The hub never parses a client message. `socket.ts` feeds it authenticated sessions and parsed
 * subscribes, and the after-commit announcements (§3.2) feed it events. It reaches the database only
 * through the two injected queries (§10), and it reads time only through the injected clock. A unit
 * test can therefore drive it with fake sockets and fake time.
 *
 * In a fleet (spec §20.3) the hub hears every instance's announcements through the notification bus. Presence is the
 * one state it shares: it announces its own users of each room as ids (`presenceChanged`), keeps the other holders'
 * lists, and sends the union, with the names it looks up in the tenant. After a lost bus, or on a `resync`, every
 * subscribed socket gets `head`, `access` and `presence`, which make any desktop run its ordinary fetch.
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
  PresenceChangedEvent,
  PresenceResetEvent,
  ResyncEvent,
  ScheduleRunFinishedEvent,
  SessionEndedEvent,
} from '../context.js';
import type { Listened } from '../operations/bus.js';
import { holdSession, type HeldSessions } from '../operations/sessions.js';
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

/** What the hub needs to share presence and resync in a fleet (spec §20.3). The module always passes it. */
export interface LiveHubCluster {
  /** This process's id: the `holder` of what it announces, and what it ignores when its own comes back. */
  readonly holder: string;
  readonly announcePresence: (event: PresenceChangedEvent) => void;
  readonly announceReset: (event: PresenceResetEvent) => void;
  /** The display names of those ids that are users in `tenant`. Never the emails. */
  readonly displayNames: (userIds: readonly string[], tenant: TenantScope) => Promise<ReadonlyMap<string, string>>;
  /** The workspace's current head, `null` while its branch is unborn. */
  readonly headOf: (workspaceId: string, tenant: TenantScope) => Promise<string | null>;
}

export interface LiveHubDeps {
  readonly effectiveRole: (userId: string, workspaceId: string, tenant: TenantScope) => Promise<Effective>;
  readonly workspaceIdsOfTeam: (teamId: string, tenant: TenantScope) => Promise<string[]>;
  readonly log: FastifyBaseLogger;
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };
  /** Without it (a unit test's hub) presence stays in this process and nothing resyncs. */
  readonly cluster?: LiveHubCluster;
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
  /** What {@link closeAll} closed with, for a socket authenticated after it. */
  private closedWith: { readonly code: number; readonly reason: string } = {
    code: LIVE_CLOSE.goingAway,
    reason: 'server shutting down',
  };
  /** The other holders' users, by room and then holder: user ids, as `presenceChanged` carried them (spec §20.3). */
  private readonly remote = new Map<Room, Map<string, readonly string[]>>();
  /** The display names of the other holders' users, by room, looked up in the room's tenant. */
  private readonly names = new Map<Room, Map<string, string>>();
  /** What this hub last announced of each room, as joined ids, so an unchanged list is not announced again. */
  private readonly announced = new Map<Room, string>();
  /**
   * A big list still arriving in parts, by holder and room (review M1): its `seq` and the parts so far. A part of a
   * newer `seq` gives the older list up, and a part of an older one is ignored.
   */
  private readonly partial = new Map<string, { readonly seq: number; readonly parts: (readonly string[])[] }>();

  constructor(private readonly deps: LiveHubDeps) {}

  /**
   * Binds an authenticated socket to its session (§3.3). The hub sends everything that follows.
   * - `'ok'`: the hub sent `ready` and armed the maximum-age timer. After {@link closeAll}, it closed
   *   the socket with that call's code instead (`1001`, or `1012` on a drain).
   * - `'too-many-sockets'`: the user already has 32 sockets, so the hub closed this one `4429` and
   *   kept nothing of it.
   */
  admit(socket: LiveSocket, session: LiveSession): 'ok' | 'too-many-sockets' {
    if (this.closed) {
      closeQuietly(socket, this.closedWith.code, this.closedWith.reason);
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

  /** `schedule-run` to every subscriber of the workspace: one of its scheduled runs ended (scheduled-runs §3.5). */
  scheduleRunFinished(event: ScheduleRunFinishedEvent): void {
    if (this.closed) return;
    const { workspaceId, scheduleId, runId, status } = event;
    this.deliver(this.byWorkspace.get(keyOf(event.tenantId, workspaceId)) ?? [], {
      type: 'schedule-run',
      workspaceId,
      scheduleId,
      runId,
      status,
    });
  }

  /**
   * Another holder's users of a room (spec §20.3). Its own come back from the bus's local delivery and are ignored.
   * The room's subscribers here get the union once the newcomers' names are known.
   */
  presenceChanged(event: PresenceChangedEvent): void {
    if (this.closed || this.cluster === undefined || event.holder === this.cluster.holder) return;
    const room = keyOf(event.tenantId, event.workspaceId);
    const users = this.wholeList(room, event);
    if (users === undefined) return;
    const lists = this.remote.get(room) ?? new Map<string, readonly string[]>();
    if ((lists.get(event.holder) ?? []).join(',') === users.join(',')) return;
    if (users.length === 0) lists.delete(event.holder);
    else lists.set(event.holder, users);
    this.storeLists(room, lists);
    const tenant = this.tenantOfRoom(room);
    if (tenant === undefined) return;
    void this.track(
      this.lookUpNames(room, tenant).then(() => {
        this.sendPresence([room]);
      }),
    );
  }

  /**
   * Drops every list `holder` announced: it lost its bus, or it is stopping (spec §20.3). Then this hub announces its
   * own lists again, so a holder that reset after a loss, or that just started, learns them.
   */
  presenceReset(event: PresenceResetEvent): void {
    if (this.closed || this.cluster === undefined || event.holder === this.cluster.holder) return;
    this.sendPresence(this.dropHolders((holder) => holder === event.holder));
    for (const room of this.byWorkspace.keys()) this.announceOwn(room, true);
  }

  /**
   * The holder's whole list for the room once it is complete: a list in one message at once, a list in parts when its
   * last part came (review M1); `undefined` while parts are missing.
   */
  private wholeList(room: Room, event: PresenceChangedEvent): readonly string[] | undefined {
    const key = `${event.holder}|${room}`;
    if (event.parts === undefined || event.part === undefined || event.seq === undefined) {
      this.partial.delete(key);
      return [...event.users];
    }
    let pending = this.partial.get(key);
    // A straggler of a list a newer one replaced is too old to apply.
    if (pending !== undefined && event.seq < pending.seq) return undefined;
    if (pending?.seq !== event.seq) {
      pending = { seq: event.seq, parts: [] };
      this.partial.set(key, pending);
    }
    pending.parts[event.part] = event.users;
    let count = 0;
    for (const part of pending.parts) if (part !== undefined) count++;
    if (count < event.parts) return undefined;
    this.partial.delete(key);
    return pending.parts.flat();
  }

  /** The authenticated sockets held here, by tenant id: the `wirebench.live.sockets` gauge (spec §20.8). */
  countsByTenant(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const { session } of this.bySocket.values()) {
      counts.set(session.tenant.tenantId, (counts.get(session.tenant.tenantId) ?? 0) + 1);
    }
    return counts;
  }

  /** The device tokens of the sockets held here, by tenant: what a resync re-validates (review I1). */
  heldSessions(): HeldSessions {
    const held: HeldSessions = new Map();
    for (const { session } of this.bySocket.values()) holdSession(held, session.tenant, session.tokenId);
    return held;
  }

  /** The holders whose lists this hub keeps: the heartbeat asks the instance table only when there are some. */
  otherHolders(): Set<string> {
    const holders = new Set<string>();
    for (const lists of this.remote.values()) for (const holder of lists.keys()) holders.add(holder);
    return holders;
  }

  /** Drops the lists of every holder not in `live`, the instance rows renewed within 60 s (spec §20.2). */
  keepHolders(live: ReadonlySet<string>): void {
    if (this.closed) return;
    this.sendPresence(this.dropHolders((holder) => !live.has(holder)));
  }

  /**
   * The bus listens (spec §20.3). Every time, the hub says `presenceReset` and announces its own lists afresh, and the
   * others answer with theirs. After a loss, the lists it kept may be stale, so they go too, and every room resyncs.
   */
  listened(listened: Listened): void {
    if (this.closed || this.cluster === undefined) return;
    if (listened.reconnected) {
      this.remote.clear();
      this.partial.clear();
      this.names.clear();
    }
    this.cluster.announceReset({ holder: this.cluster.holder });
    for (const room of this.byWorkspace.keys()) this.announceOwn(room, true);
    if (listened.reconnected) this.resyncRooms([...this.byWorkspace.keys()]);
  }

  /** The bus could not carry an event for the tenant: its rooms resync (spec §20.3). */
  resync(event: ResyncEvent): void {
    // A tenant-less one is the bus's missed marker, which reaches `listened` instead.
    if (this.closed || this.cluster === undefined || event.tenantId === undefined) return;
    this.resyncRooms([...this.byWorkspace.keys()].filter((room) => room.startsWith(`${event.tenantId}:`)));
  }

  /**
   * Shutdown (§3.3, §5.1): closes every socket `1001` and clears the indexes. A drain (hosted edition spec §20.5)
   * passes `1012` instead, and a socket authenticated afterwards is closed the same way. Later calls are no-ops.
   */
  closeAll(code: number = LIVE_CLOSE.goingAway, reason = 'server shutting down'): void {
    if (this.closed) return;
    this.closed = true;
    this.closedWith = { code, reason };
    // The others drop this holder's users at once, rather than when its row dies.
    if (this.announced.size > 0) this.cluster?.announceReset({ holder: this.cluster.holder });
    this.announced.clear();
    this.remote.clear();
    this.names.clear();
    const sockets = [...this.bySocket.keys()];
    for (const state of this.bySocket.values()) state.deadline?.cancel();
    for (const open of this.captureWindows.values()) open.timer?.cancel();
    this.captureWindows.clear();
    this.bySocket.clear();
    this.byWorkspace.clear();
    this.byUser.clear();
    this.byToken.clear();
    for (const socket of sockets) closeQuietly(socket, code, reason);
  }

  /**
   * The sockets of the tenants in `tenantIds` close with `code` and `reason`, the rest stay (hosted edition spec
   * §22.7: a suspended or deleting tenant's sockets close `4403 tenant-suspended`). They are detached first, so the
   * presence that follows reaches only the sockets left.
   */
  closeTenants(tenantIds: ReadonlySet<string>, code: number, reason: string): void {
    const sockets = [...this.bySocket].filter(([, state]) => tenantIds.has(state.session.tenant.tenantId));
    if (sockets.length === 0) return;
    const changed = this.detach(sockets.map(([socket]) => socket));
    for (const [socket] of sockets) closeQuietly(socket, code, reason);
    this.announcePresence(changed);
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
    const room = roomOf(state.session, workspaceId);
    if (found.role !== 'none') await this.lookUpNames(room, state.session.tenant);
    // While the queries ran, the socket may have closed, a repeat may have been admitted, or the session filled up.
    if (this.bySocket.get(socket) !== state || state.subs.has(workspaceId)) return;
    if (found.role === 'none') {
      this.refuse(socket, workspaceId, 'teams-workspace-not-found');
      return;
    }
    if (this.full(state.session)) {
      this.refuse(socket, workspaceId, LIVE_TOO_MANY_SUBSCRIPTIONS);
      return;
    }
    const arriving = !this.isPresent(room, state.session.userId);
    state.subs.set(workspaceId, found.role);
    addTo(this.byWorkspace, room, socket);
    if (arriving) this.announceOwn(room);
    const message: LiveServerMessage = { type: 'presence', workspaceId, users: this.presenceOf(room) };
    this.deliver(arriving ? (this.byWorkspace.get(room) ?? []) : [socket], message);
  }

  private get cluster(): LiveHubCluster | undefined {
    return this.deps.cluster;
  }

  /** The tenant of a room this hub holds sockets in, from one of its sessions. */
  private tenantOfRoom(room: Room): TenantScope | undefined {
    for (const socket of this.byWorkspace.get(room) ?? []) {
      const tenant = this.bySocket.get(socket)?.session.tenant;
      if (tenant !== undefined) return tenant;
    }
    return undefined;
  }

  private storeLists(room: Room, lists: Map<string, readonly string[]>): void {
    if (lists.size > 0) {
      this.remote.set(room, lists);
      return;
    }
    this.remote.delete(room);
    this.names.delete(room);
  }

  /** Drops the lists of the holders `drop` picks. Returns the rooms whose union changed. */
  private dropHolders(drop: (holder: string) => boolean): Room[] {
    const changed: Room[] = [];
    for (const key of [...this.partial.keys()]) if (drop(key.slice(0, key.indexOf('|')))) this.partial.delete(key);
    for (const [room, lists] of [...this.remote]) {
      const before = lists.size;
      for (const holder of [...lists.keys()]) if (drop(holder)) lists.delete(holder);
      if (lists.size === before) continue;
      this.storeLists(room, lists);
      changed.push(room);
    }
    return changed;
  }

  /**
   * Looks up, in one query, the names of the room's remote users this hub has no name for yet, and keeps them while
   * the room has remote lists. Never rejects; a failure leaves those users out of `presence` until the next try.
   */
  private async lookUpNames(room: Room, tenant: TenantScope): Promise<void> {
    const lists = this.remote.get(room);
    if (lists === undefined || this.cluster === undefined) return;
    const known = this.names.get(room);
    const missing = new Set<string>();
    for (const ids of lists.values()) for (const id of ids) if (known?.has(id) !== true) missing.add(id);
    if (missing.size === 0) return;
    try {
      const found = await this.cluster.displayNames([...missing], tenant);
      if (!this.remote.has(room)) return;
      const names = this.names.get(room) ?? new Map<string, string>();
      for (const [id, name] of found) names.set(id, name);
      this.names.set(room, names);
    } catch (error) {
      this.deps.log.warn({ err: error }, 'live presence names could not be read');
    }
  }

  /** `presenceChanged` with this hub's users of `room`, when they differ from what it last said, or always (`force`). */
  private announceOwn(room: Room, force = false): void {
    if (this.cluster === undefined) return;
    const users = [...new Set(this.localUserIds(room))].sort(compareIds);
    const joined = users.join(',');
    if (!force && (this.announced.get(room) ?? '') === joined) return;
    // An empty list goes out only for a room this hub had announced: the others then drop it.
    if (users.length === 0) this.announced.delete(room);
    else this.announced.set(room, joined);
    this.cluster.announcePresence({
      tenantId: room.slice(0, room.indexOf(':')),
      workspaceId: workspaceOf(room),
      holder: this.cluster.holder,
      users,
    });
  }

  private *localUserIds(room: Room): Iterable<string> {
    for (const socket of this.byWorkspace.get(room) ?? []) {
      const session = this.bySocket.get(socket)?.session;
      if (session !== undefined) yield session.userId;
    }
  }

  /**
   * Spec §20.3: per room, one head query, then `head` (when the branch is born), `access` and `presence` to each
   * subscribed socket, in that order, and last an access re-check of the room's tenant, since an `accessChanged` the
   * bus missed would otherwise leave a subscription its user lost. Rooms go one at a time, in the background.
   */
  private resyncRooms(rooms: readonly Room[]): void {
    const cluster = this.cluster;
    if (cluster === undefined || rooms.length === 0) return;
    const run = async (): Promise<void> => {
      const tenants = new Map<string, TenantScope>();
      for (const room of rooms) {
        const tenant = this.tenantOfRoom(room);
        if (tenant === undefined || this.closed) continue;
        tenants.set(tenant.tenantId, tenant);
        const workspaceId = workspaceOf(room);
        let head: string | null = null;
        try {
          head = await cluster.headOf(workspaceId, tenant);
        } catch (error) {
          this.deps.log.warn({ err: error, workspaceId }, 'live resync could not read the head');
        }
        await this.lookUpNames(room, tenant);
        if (this.closed) return;
        const sockets = [...(this.byWorkspace.get(room) ?? [])];
        if (head !== null) this.deliver(sockets, { type: 'head', workspaceId, head });
        this.deliver(sockets, { type: 'access', workspaceId });
        this.sendPresence([room]);
      }
      for (const tenant of tenants.values()) this.accessChanged({ tenantId: tenant.tenantId, tenant });
    };
    void this.track(
      run().catch((error: unknown) => {
        this.deps.log.warn({ err: error }, 'live resync failed');
      }),
    );
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
    const told = new Set<LiveSocket>();
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
      this.applyRoles(results, told);
    } catch (error) {
      // The desktop's safety-net fetch still converges (§3.3).
      this.deps.log.warn({ err: error, ...event }, 'live access re-check failed');
    }
    if (event.settings === true && event.workspaceId !== undefined && !this.closed) {
      // Settings changed for everyone on the workspace: the subscribers the role check did not already tell.
      const room = keyOf(event.tenantId, event.workspaceId);
      const rest = [...(this.byWorkspace.get(room) ?? [])].filter((socket) => !told.has(socket));
      this.deliver(rest, { type: 'access', workspaceId: event.workspaceId });
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
    told: Set<LiveSocket>,
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
        told.add(socket);
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
    // Spec §20.3: the other holders' users too, each once its name is known.
    const names = this.names.get(room);
    for (const ids of this.remote.get(room)?.values() ?? []) {
      for (const id of ids) {
        const name = names?.get(id);
        if (name !== undefined && !users.has(id)) users.set(id, { id, name });
      }
    }
    return [...users.values()].sort((a, b) => byName.compare(a.name, b.name) || compareIds(a.id, b.id));
  }

  /** This hub's users of `rooms` changed: it tells the other holders, then the rooms' subscribers here. */
  private announcePresence(rooms: Iterable<Room>): void {
    const list = [...rooms];
    for (const room of list) this.announceOwn(room);
    this.sendPresence(list);
  }

  /** `presence` to each room's subscribers here. */
  private sendPresence(rooms: Iterable<Room>): void {
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
