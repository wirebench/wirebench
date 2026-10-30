/**
 * The shares a server relays, held in memory only (team session logs and sharing spec B1). A share has one
 * owner socket, which sends the masked screen, and up to {@link TERMINAL_SHARE_LIMITS.maxViewers} viewer
 * sockets. One viewer at a time may hold control, and only after the owner granted their request; the
 * holder's keystrokes go to the owner, who writes them to the session.
 *
 * Nothing here touches a database or a socket library: sockets are {@link SharePeer}s, the role lookup,
 * clock, timers and ids are injected, and every audited step is handed to `audit`, which the module writes
 * in its own transaction. A server restart ends every share.
 */
import {
  TERMINAL_SHARE_CLOSE,
  TERMINAL_SHARE_LIMITS,
  type AuditAction,
  type AuditDetails,
  type TerminalShareClientMessage,
  type TerminalShareEndReason,
  type TerminalSharePresenceEntry,
  type TerminalShareServerMessage,
} from '@wirebench/engine';
import type { AuditSource, SessionEndedEvent } from '../context.js';
import type { TenantScope } from '../tenancy/scope.js';

/** One socket, as the registry sees it. */
export interface SharePeer {
  sendText(text: string): void;
  sendBinary(data: Buffer): void;
  close(code: number, reason: string): void;
  terminate(): void;
  ping(): void;
  readonly isOpen: boolean;
}

/** Who a socket belongs to, once its token checked out. */
export interface ShareIdentity {
  readonly userId: string;
  readonly name: string;
  readonly tokenId: string;
  /** When the token's maximum age runs out, in epoch ms. */
  readonly expiresAt: number;
  /** The actor, IP and user agent its audit rows carry. */
  readonly source: AuditSource;
}

export interface ShareAuditEvent {
  /** The share's tenant: its rows are written there. */
  readonly tenant: TenantScope;
  readonly action: AuditAction;
  readonly source: AuditSource;
  readonly workspaceId: string;
  readonly shareId: string;
  readonly details: AuditDetails;
}

export interface ShareRegistryDeps {
  /** True while the user may still read the workspace (any role), in the share's tenant. */
  readonly canView: (userId: string, workspaceId: string, tenant: TenantScope) => Promise<boolean>;
  readonly audit: (event: ShareAuditEvent) => void;
  readonly newShareId: () => string;
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };
  readonly log?: (message: string, error?: unknown) => void;
}

export type AttachOutcome = 'owner' | 'viewer' | 'not-found' | 'removed' | 'owner-taken' | 'full';

interface Member {
  readonly peer: SharePeer;
  readonly who: ShareIdentity;
  alive: boolean;
}

interface Viewer extends Member {
  requesting: boolean;
  /** Input messages in the current one-second window. */
  inputs: number;
  windowStart: number;
}

const shareKey = (tenantId: string, shareId: string): string => `${tenantId}:${shareId}`;

interface Share {
  readonly id: string;
  readonly workspaceId: string;
  /** The tenant it was created in: its access re-checks run there. */
  readonly tenant: TenantScope;
  readonly hostName: string;
  readonly ownerId: string;
  readonly ownerName: string;
  readonly ownerSource: AuditSource;
  cols: number;
  rows: number;
  owner: Member | undefined;
  readonly viewers: Map<SharePeer, Viewer>;
  control: Viewer | undefined;
  /** Users the owner removed: they may not come back to this share. */
  readonly removed: Set<string>;
  /** Users who joined at some point, for the end row. */
  readonly joined: Set<string>;
  readonly replay: ReplayBuffer;
  attachTimer: { cancel(): void } | undefined;
}

/** The last {@link TERMINAL_SHARE_LIMITS.replayBytes} of output, for a late joiner. */
export class ReplayBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly cap: number) {}

  push(data: Buffer): void {
    if (data.length >= this.cap) {
      this.chunks = [Buffer.from(data.subarray(data.length - this.cap))];
      this.size = this.cap;
      return;
    }
    this.chunks.push(Buffer.from(data));
    this.size += data.length;
    while (this.size > this.cap) {
      const first = this.chunks[0]!;
      const over = this.size - this.cap;
      if (first.length <= over) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(over);
        this.size -= over;
      }
    }
  }

  contents(): Buffer {
    return Buffer.concat(this.chunks, this.size);
  }
}

const json = (message: TerminalShareServerMessage): string => JSON.stringify(message);

export class ShareRegistry {
  /** By `tenantId:shareId` (hosted edition spec §19.8 guard 5): a share is found only in its own tenant. */
  private readonly shares = new Map<string, Share>();
  private readonly byPeer = new Map<SharePeer, Share>();

  constructor(private readonly deps: ShareRegistryDeps) {}

  /** A new share; its owner must attach within {@link TERMINAL_SHARE_LIMITS.ownerAttachMs}. */
  create(input: {
    readonly workspaceId: string;
    readonly hostName: string;
    readonly cols: number;
    readonly rows: number;
    readonly ownerId: string;
    readonly ownerName: string;
    readonly source: AuditSource;
    readonly tenant: TenantScope;
  }): string {
    const id = this.deps.newShareId();
    const share: Share = {
      id,
      workspaceId: input.workspaceId,
      tenant: input.tenant,
      hostName: input.hostName,
      ownerId: input.ownerId,
      ownerName: input.ownerName,
      ownerSource: input.source,
      cols: input.cols,
      rows: input.rows,
      owner: undefined,
      viewers: new Map(),
      control: undefined,
      removed: new Set(),
      joined: new Set(),
      replay: new ReplayBuffer(TERMINAL_SHARE_LIMITS.replayBytes),
      attachTimer: undefined,
    };
    share.attachTimer = this.deps.setTimer(() => {
      share.attachTimer = undefined;
      if (share.owner === undefined) this.end(share, 'owner-left', share.ownerSource);
    }, TERMINAL_SHARE_LIMITS.ownerAttachMs);
    this.shares.set(shareKey(share.tenant.tenantId, id), share);
    this.record(share, 'terminal_share.started', input.source, {});
    return id;
  }

  /**
   * What the join dialog shows, or `undefined` when the caller cannot join it. A share is found only in the
   * tenant it was created in (Task 9 review M4): one workspace id may exist in two tenants.
   */
  info(
    tenant: TenantScope,
    workspaceId: string,
    shareId: string,
    userId: string,
  ): { hostName: string; ownerName: string; viewers: number } | undefined {
    const share = this.shares.get(shareKey(tenant.tenantId, shareId));
    if (share === undefined || !this.inTenant(share, tenant, workspaceId) || share.removed.has(userId)) {
      return undefined;
    }
    return { hostName: share.hostName, ownerName: share.ownerName, viewers: share.viewers.size };
  }

  /** Attaches an authenticated socket whose access to the workspace was checked, in the share's own tenant. */
  attach(
    tenant: TenantScope,
    peer: SharePeer,
    who: ShareIdentity,
    workspaceId: string,
    shareId: string,
  ): AttachOutcome {
    const share = this.shares.get(shareKey(tenant.tenantId, shareId));
    if (share === undefined || !this.inTenant(share, tenant, workspaceId)) return 'not-found';
    if (who.userId === share.ownerId) {
      if (share.owner !== undefined) return 'owner-taken';
      share.attachTimer?.cancel();
      share.attachTimer = undefined;
      share.owner = { peer, who, alive: true };
      this.byPeer.set(peer, share);
      peer.sendText(json({ type: 'ready', role: 'owner' }));
      this.sendPresence(share);
      return 'owner';
    }
    if (share.removed.has(who.userId)) return 'removed';
    if (share.viewers.size >= TERMINAL_SHARE_LIMITS.maxViewers) return 'full';
    const viewer: Viewer = { peer, who, alive: true, requesting: false, inputs: 0, windowStart: 0 };
    share.viewers.set(peer, viewer);
    share.joined.add(who.userId);
    this.byPeer.set(peer, share);
    peer.sendText(
      json({
        type: 'viewer-ready',
        hostName: share.hostName,
        ownerName: share.ownerName,
        cols: share.cols,
        rows: share.rows,
      }),
    );
    const replay = share.replay.contents();
    if (replay.length > 0) peer.sendBinary(replay);
    peer.sendText(json({ type: 'control', userId: share.control?.who.userId ?? null }));
    this.sendPresence(share);
    this.record(share, 'terminal_share.joined', who.source, { userId: who.userId });
    return 'viewer';
  }

  /** A binary frame: output from the owner, relayed to every viewer. Anyone else may not send one. */
  output(peer: SharePeer, data: Buffer): 'ok' | 'bad' {
    const share = this.byPeer.get(peer);
    if (share?.owner?.peer !== peer) return 'bad';
    share.replay.push(data);
    for (const viewer of share.viewers.values()) viewer.peer.sendBinary(data);
    return 'ok';
  }

  /** A text message from an attached socket; `bad` when its role may not send it. */
  message(peer: SharePeer, message: TerminalShareClientMessage): 'ok' | 'bad' {
    const share = this.byPeer.get(peer);
    if (share === undefined) return 'bad';
    if (message.type === 'ping') {
      peer.sendText(json({ type: 'pong' }));
      return 'ok';
    }
    if (share.owner?.peer === peer) return this.ownerMessage(share, share.owner, message);
    const viewer = share.viewers.get(peer);
    return viewer === undefined ? 'bad' : this.viewerMessage(share, viewer, message);
  }

  /** The socket closed. */
  detach(peer: SharePeer): void {
    const share = this.byPeer.get(peer);
    if (share === undefined) return;
    this.byPeer.delete(peer);
    if (share.owner?.peer === peer) {
      this.end(share, 'owner-left', share.owner.who.source);
      return;
    }
    const viewer = share.viewers.get(peer);
    if (viewer === undefined) return;
    share.viewers.delete(peer);
    if (share.control === viewer) this.dropControl(share, viewer.who.source, 'left');
    this.sendPresence(share);
  }

  pong(peer: SharePeer): void {
    const member = this.memberOf(peer);
    if (member !== undefined) member.alive = true;
  }

  /** Drops sockets that missed a pong, and those whose token reached its maximum age; pings the rest. */
  heartbeat(): void {
    const now = this.deps.now();
    for (const share of [...this.shares.values()]) {
      const owner = share.owner;
      if (owner !== undefined && (!owner.alive || now >= owner.who.expiresAt)) {
        if (now >= owner.who.expiresAt) this.end(share, 'revoked', owner.who.source);
        else this.end(share, 'owner-left', owner.who.source);
        owner.peer.terminate();
        continue;
      }
      for (const viewer of [...share.viewers.values()]) {
        if (now >= viewer.who.expiresAt) {
          this.dismiss(share, viewer, 'revoked', TERMINAL_SHARE_CLOSE.unauthenticated);
        } else if (!viewer.alive) {
          viewer.peer.terminate();
          this.detach(viewer.peer);
        } else {
          viewer.alive = false;
          viewer.peer.ping();
        }
      }
      if (share.owner !== undefined && this.shares.has(shareKey(share.tenant.tenantId, share.id))) {
        share.owner.alive = false;
        share.owner.peer.ping();
      }
    }
  }

  /**
   * A device token ended, or every token of a user, in the event's tenant: their shares there end, and their
   * viewer sockets there close. Token and user ids are per tenant, so no other tenant's share is touched.
   */
  sessionEnded(event: SessionEndedEvent): void {
    const hit = (who: ShareIdentity): boolean =>
      'tokenId' in event
        ? who.tokenId === event.tokenId
        : who.userId === event.userId && who.tokenId !== event.exceptTokenId;
    for (const share of [...this.shares.values()]) {
      if (share.tenant.tenantId !== event.tenantId) continue;
      if (share.owner !== undefined && hit(share.owner.who)) {
        this.end(share, 'revoked', share.owner.who.source);
        continue;
      }
      for (const viewer of [...share.viewers.values()]) {
        if (hit(viewer.who)) this.dismiss(share, viewer, 'revoked', TERMINAL_SHARE_CLOSE.unauthenticated);
      }
    }
  }

  /** Someone's access may have changed in `tenantId`: every socket of its shares is looked up again. */
  async recheck(tenantId: string): Promise<void> {
    for (const share of [...this.shares.values()]) {
      if (share.tenant.tenantId !== tenantId) continue;
      const owner = share.owner;
      if (owner !== undefined && !(await this.deps.canView(owner.who.userId, share.workspaceId, share.tenant))) {
        if (this.shares.has(shareKey(share.tenant.tenantId, share.id))) this.end(share, 'access', owner.who.source);
        continue;
      }
      for (const viewer of [...share.viewers.values()]) {
        if (
          !(await this.deps.canView(viewer.who.userId, share.workspaceId, share.tenant)) &&
          share.viewers.has(viewer.peer)
        ) {
          this.dismiss(share, viewer, 'access', TERMINAL_SHARE_CLOSE.forbidden);
        }
      }
    }
  }

  private inTenant(share: Share, tenant: TenantScope, workspaceId: string): boolean {
    return share.tenant.tenantId === tenant.tenantId && share.workspaceId === workspaceId;
  }

  /** Server shutdown: every share ends. */
  closeAll(): void {
    for (const share of [...this.shares.values()]) this.end(share, 'server', share.ownerSource);
  }

  /** How many shares are live (tests and logs). */
  get size(): number {
    return this.shares.size;
  }

  private ownerMessage(share: Share, owner: Member, message: TerminalShareClientMessage): 'ok' | 'bad' {
    const source = owner.who.source;
    switch (message.type) {
      case 'resize':
        share.cols = message.cols;
        share.rows = message.rows;
        this.toViewers(share, { type: 'resize', cols: message.cols, rows: message.rows });
        return 'ok';
      case 'grant': {
        const viewer = [...share.viewers.values()].find((v) => v.who.userId === message.userId && v.requesting);
        if (viewer === undefined) return 'ok';
        const previous = share.control;
        if (previous !== undefined && previous !== viewer) {
          this.record(share, 'terminal_share.control_returned', source, { userId: previous.who.userId, by: 'grant' });
        }
        viewer.requesting = false;
        share.control = viewer;
        this.record(share, 'terminal_share.control_granted', source, { userId: viewer.who.userId });
        this.sendControl(share);
        return 'ok';
      }
      case 'decline':
        for (const viewer of share.viewers.values()) {
          if (viewer.who.userId === message.userId && viewer.requesting) {
            viewer.requesting = false;
            viewer.peer.sendText(json({ type: 'declined' }));
          }
        }
        this.sendPresence(share);
        return 'ok';
      case 'take-back':
        if (share.control !== undefined) this.dropControl(share, source, 'owner');
        return 'ok';
      case 'remove': {
        if (message.userId === share.ownerId) return 'ok';
        share.removed.add(message.userId);
        const gone = [...share.viewers.values()].filter((v) => v.who.userId === message.userId);
        for (const viewer of gone) this.dismiss(share, viewer, 'removed', TERMINAL_SHARE_CLOSE.forbidden);
        this.record(share, 'terminal_share.viewer_removed', source, { userId: message.userId });
        return 'ok';
      }
      case 'end':
        this.end(share, 'ended', source);
        return 'ok';
      default:
        return 'bad';
    }
  }

  private viewerMessage(share: Share, viewer: Viewer, message: TerminalShareClientMessage): 'ok' | 'bad' {
    switch (message.type) {
      case 'request-control':
        if (share.control !== viewer && !viewer.requesting) {
          viewer.requesting = true;
          this.sendPresence(share);
        }
        return 'ok';
      case 'release':
        if (share.control === viewer) this.dropControl(share, viewer.who.source, 'viewer');
        else if (viewer.requesting) {
          viewer.requesting = false;
          this.sendPresence(share);
        }
        return 'ok';
      case 'input': {
        // Input from anyone but the holder is dropped, not refused: control may have moved in flight.
        if (share.control !== viewer || share.owner === undefined) return 'ok';
        const now = this.deps.now();
        if (now - viewer.windowStart >= 1000) {
          viewer.windowStart = now;
          viewer.inputs = 0;
        }
        viewer.inputs += 1;
        if (viewer.inputs > TERMINAL_SHARE_LIMITS.inputsPerSecond) return 'ok';
        share.owner.peer.sendText(json({ type: 'input', userId: viewer.who.userId, data: message.data }));
        return 'ok';
      }
      default:
        return 'bad';
    }
  }

  private dropControl(share: Share, source: AuditSource, by: 'owner' | 'viewer' | 'left' | 'removed' | 'access'): void {
    const holder = share.control;
    if (holder === undefined) return;
    share.control = undefined;
    this.record(share, 'terminal_share.control_returned', source, { userId: holder.who.userId, by });
    this.sendControl(share);
  }

  /** Sends one viewer away with `ended {reason}` and a close code. */
  private dismiss(share: Share, viewer: Viewer, reason: TerminalShareEndReason, code: number): void {
    share.viewers.delete(viewer.peer);
    this.byPeer.delete(viewer.peer);
    if (share.control === viewer) {
      this.dropControl(share, viewer.who.source, reason === 'removed' ? 'removed' : 'access');
    }
    viewer.peer.sendText(json({ type: 'ended', reason }));
    viewer.peer.close(code, reason);
    this.sendPresence(share);
  }

  private end(share: Share, reason: TerminalShareEndReason, source: AuditSource): void {
    if (!this.shares.delete(shareKey(share.tenant.tenantId, share.id))) return;
    share.attachTimer?.cancel();
    const message = json({ type: 'ended', reason });
    const members: Member[] = [...share.viewers.values()];
    if (share.owner !== undefined) members.push(share.owner);
    for (const member of members) {
      this.byPeer.delete(member.peer);
      if (!member.peer.isOpen) continue;
      member.peer.sendText(message);
      member.peer.close(TERMINAL_SHARE_CLOSE.ended, reason);
    }
    this.record(share, 'terminal_share.ended', source, { reason, viewers: share.joined.size });
  }

  private memberOf(peer: SharePeer): Member | undefined {
    const share = this.byPeer.get(peer);
    if (share === undefined) return undefined;
    return share.owner?.peer === peer ? share.owner : share.viewers.get(peer);
  }

  private presenceOf(share: Share): TerminalShareServerMessage {
    const viewers: TerminalSharePresenceEntry[] = [...share.viewers.values()].map((v) => ({
      userId: v.who.userId,
      name: v.who.name,
      control: share.control === v,
      requesting: v.requesting,
    }));
    return { type: 'presence', owner: { userId: share.ownerId, name: share.ownerName }, viewers };
  }

  private sendPresence(share: Share): void {
    const text = json(this.presenceOf(share));
    share.owner?.peer.sendText(text);
    for (const viewer of share.viewers.values()) viewer.peer.sendText(text);
  }

  private sendControl(share: Share): void {
    const text = json({ type: 'control', userId: share.control?.who.userId ?? null });
    share.owner?.peer.sendText(text);
    for (const viewer of share.viewers.values()) viewer.peer.sendText(text);
    this.sendPresence(share);
  }

  private toViewers(share: Share, message: TerminalShareServerMessage): void {
    const text = json(message);
    for (const viewer of share.viewers.values()) viewer.peer.sendText(text);
  }

  private record(share: Share, action: AuditAction, source: AuditSource, details: AuditDetails): void {
    try {
      this.deps.audit({
        tenant: share.tenant,
        action,
        source,
        workspaceId: share.workspaceId,
        shareId: share.id,
        details: { hostName: share.hostName, ...details },
      });
    } catch (error) {
      this.deps.log?.('terminal share audit failed', error);
    }
  }
}
