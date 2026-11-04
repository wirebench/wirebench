/**
 * Shares across instances (hosted edition spec §20.6). The owner's instance writes `terminal_share_locations` when a
 * share starts and deletes the row when it ends. A viewer's instance that does not hold the share looks the row up; a
 * row whose holder has no live instance row is no share (and is cleared), as is a row naming this instance. Otherwise
 * it dials the holder's internal listener with a relay token and pipes frames both ways unchanged, text as text and
 * binary as binary. The holder sees one more viewer with the viewer's identity; nothing of the share is decided here.
 *
 * When either side closes, the other is closed with the same code and reason; a code the dialling side may not send
 * (a `1001` from a viewer's browser, a `1006` lost link) goes as `1000` towards the holder, and as `1011` towards
 * the viewer. While relayed, this instance pings the viewer on the share heartbeat and drops a viewer that missed a
 * pong, which closes the upstream: the holder pings the upstream, which answers on its own.
 */
import {
  TERMINAL_SHARE_CLOSE,
  TERMINAL_SHARE_LIMITS,
  terminalShareInfoSchema,
  type TerminalShareInfo,
} from '@wirebench/engine';
import type { FastifyBaseLogger } from 'fastify';
import type { RawData, WebSocket as ServerSocket } from 'ws';
import type { InstanceRelay } from '../operations/internal-server.js';
import type { RelayClaims } from '../operations/relay-token.js';
import type { ServerInstance } from '../operations/instances.js';
import type { TenantScope } from '../tenancy/scope.js';
import type { TenantQuerier } from '../tenancy/tenant-db.js';
import type { ShareIdentity } from './registry.js';

/**
 * Node's own WebSocket client (undici's), which takes request headers in its second argument (the relay token goes in
 * `authorization`, never in the URL); its DOM-shaped type does not say so.
 */
const DialSocket = globalThis.WebSocket as unknown as new (
  url: string,
  init: { readonly headers: Record<string, string> },
) => globalThis.WebSocket;

/** How long an info request to the holder may take. */
const INFO_TIMEOUT_MS = 5_000;

/** The table's three statements, in the share's tenant (the unit sets it; the policy forces it). */
export const shareLocations = {
  async add(db: TenantQuerier, shareId: string, holder: string): Promise<void> {
    await db.query('insert into terminal_share_locations (share_id, holder) values ($1, $2::uuid)', [shareId, holder]);
  },
  async remove(db: TenantQuerier, shareId: string, holder: string): Promise<void> {
    await db.query('delete from terminal_share_locations where share_id = $1 and holder = $2::uuid', [shareId, holder]);
  },
  async holderOf(db: TenantQuerier, shareId: string): Promise<string | undefined> {
    const found = await db.query<{ holder: string }>(
      'select holder::text as holder from terminal_share_locations where share_id = $1',
      [shareId],
    );
    return found.rows[0]?.holder;
  },
};

export interface ShareRelayDeps {
  readonly relay: InstanceRelay;
  readonly instance: ServerInstance;
  readonly db: (tenant: TenantScope) => TenantQuerier;
  readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };
  readonly log: FastifyBaseLogger;
}

/** What a relayed join asks for: the viewer, the share, and the tenant it is in. */
export interface RelayJoin {
  readonly tenant: TenantScope;
  readonly workspaceId: string;
  readonly shareId: string;
  readonly who: ShareIdentity;
}

function bytesOf(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

/** A code the dialling side's WebSocket may send: `1000` or the application range. */
const sendable = (code: number): boolean => code === 1000 || (code >= 3000 && code <= 4999);
/** A code the viewer's socket may be closed with. */
const closable = (code: number): boolean =>
  sendable(code) || (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006);

export class ShareRelay {
  constructor(private readonly deps: ShareRelayDeps) {}

  /** The live holder's internal URL, or `undefined` when no other live instance holds the share. */
  private async holderUrl(tenant: TenantScope, shareId: string): Promise<{ holder: string; url: string } | undefined> {
    const db = this.deps.db(tenant);
    const holder = await shareLocations.holderOf(db, shareId);
    if (holder === undefined || holder === this.deps.instance.holder) return undefined;
    const live = (await this.deps.instance.live()).find((row) => row.holder === holder);
    if (live?.url === undefined || live.url === null) {
      // A dead holder's row: its shares ended with it.
      await shareLocations.remove(db, shareId, holder).catch((error: unknown) => {
        this.deps.log.warn({ err: error }, 'a dead share location could not be cleared');
      });
      return undefined;
    }
    return { holder, url: live.url };
  }

  private claims(join: RelayJoin, holder: string): Omit<RelayClaims, 'expiresAt'> {
    return {
      tenantId: join.tenant.tenantId,
      shareId: join.shareId,
      workspaceId: join.workspaceId,
      userId: join.who.userId,
      tokenId: join.who.tokenId,
      holder,
      viewer: { name: join.who.name, tokenExpiresAt: join.who.expiresAt, source: join.who.source },
    };
  }

  /** The join dialog's answer from the holder, or `undefined` when there is no such share for this viewer. */
  async info(join: RelayJoin): Promise<TerminalShareInfo | undefined> {
    const target = await this.holderUrl(join.tenant, join.shareId);
    if (target === undefined) return undefined;
    const response = await fetch(`${target.url}/internal/v1/shares/${encodeURIComponent(join.shareId)}/info`, {
      headers: { authorization: `Bearer ${this.deps.relay.token(this.claims(join, target.holder))}` },
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
    });
    if (response.status === 404) return undefined;
    if (response.status !== 200) throw new Error(`the share's holder answered ${String(response.status)}`);
    return terminalShareInfoSchema.parse(await response.json());
  }

  /**
   * Relays `viewer` to the holder: `relayed` once the upstream is open and the pipe set up, `not-found` when no other
   * live instance holds the share. A holder that cannot be reached closes the viewer `1011`, and is `relayed` too:
   * the socket is the pipe's from then on.
   */
  async join(viewer: ServerSocket, join: RelayJoin): Promise<'relayed' | 'not-found'> {
    const target = await this.holderUrl(join.tenant, join.shareId);
    if (target === undefined) return 'not-found';
    // Gone while the location was read: nothing to relay.
    if (viewer.readyState !== viewer.OPEN) return 'relayed';
    const upstream = new DialSocket(
      `${target.url.replace(/^http/, 'ws')}/internal/v1/shares/${encodeURIComponent(join.shareId)}`,
      { headers: { authorization: `Bearer ${this.deps.relay.token(this.claims(join, target.holder))}` } },
    );
    upstream.binaryType = 'arraybuffer';
    this.pipe(viewer, upstream);
    return 'relayed';
  }

  private pipe(viewer: ServerSocket, upstream: globalThis.WebSocket): void {
    const { log } = this.deps;
    let opened = false;
    let alive = true;
    let heartbeat: { cancel(): void } | undefined;
    const closeViewer = (code: number, reason: string): void => {
      heartbeat?.cancel();
      if (viewer.readyState === viewer.OPEN) {
        if (closable(code)) viewer.close(code, reason);
        else viewer.close(TERMINAL_SHARE_CLOSE.serverError, 'server error');
      }
    };
    const closeUpstream = (code: number, reason: string): void => {
      if (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING) {
        upstream.close(sendable(code) ? code : 1000, Buffer.byteLength(reason) <= 123 ? reason : '');
      }
    };
    const beat = (): void => {
      if (!alive) {
        viewer.terminate();
        return;
      }
      alive = false;
      if (viewer.readyState === viewer.OPEN) viewer.ping();
      heartbeat = this.deps.setTimer(beat, TERMINAL_SHARE_LIMITS.heartbeatMs);
    };

    upstream.addEventListener('open', () => {
      opened = true;
      heartbeat = this.deps.setTimer(beat, TERMINAL_SHARE_LIMITS.heartbeatMs);
    });
    upstream.addEventListener('message', (event) => {
      if (viewer.readyState !== viewer.OPEN) return;
      const data: unknown = event.data;
      if (typeof data === 'string') viewer.send(data);
      else viewer.send(Buffer.from(data as ArrayBuffer), { binary: true });
    });
    upstream.addEventListener('error', () => {
      if (!opened) log.warn("a share's holder could not be reached");
    });
    upstream.addEventListener('close', (event) => {
      closeViewer(event.code, event.reason);
    });

    viewer.on('message', (data: RawData, isBinary: boolean) => {
      if (upstream.readyState !== upstream.OPEN) return;
      const bytes = bytesOf(data);
      upstream.send(isBinary ? bytes : bytes.toString('utf8'));
    });
    viewer.on('pong', () => {
      alive = true;
    });
    viewer.on('close', (code: number, reason: Buffer) => {
      heartbeat?.cancel();
      closeUpstream(code, reason.toString('utf8'));
    });
  }
}
