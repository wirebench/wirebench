import { isIP } from 'node:net';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type {
  AuditAction,
  AuditDetails,
  AuditTargetKind,
  Edition,
  Feature,
  EgressPolicy,
  GitCli,
  HooksMeta,
  LicenseState,
  ScheduleRunStatus,
} from '@wirebench/engine';
import type { ModuleConfig } from './config.js';
import { requireFeature } from './licensing/gate.js';
import type { BusEvents } from './operations/bus.js';
import type { ServerInstance } from './operations/instances.js';
import type { RepoStore } from './repos/repo-store.js';
import type { TenantScope } from './tenancy/scope.js';
import { outsideTenantUnit, type TenantQuerier } from './tenancy/tenant-db.js';
import type { Tenancy } from './tenancy/tenancy.js';
import type { ScopeSource } from './tenancy/urls.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The tenant this request is for (hosted edition spec §19.5; `tenancy/resolve.ts`). Self-hosted, always
     * the default tenant, read on demand; hosted, resolved by `Host` before every module. `/healthz` has none.
     */
    readonly tenant: TenantScope;
  }
}

/** What identity reports when an invitation becomes a user (teams-access spec §3.4). */
export interface InvitationAccepted {
  readonly invitationId: string;
  readonly userId: string;
}

/** Runs in identity's accepting unit, in the invitation's tenant. */
export type InvitationAcceptedHook = (tx: TenantQuerier, accepted: InvitationAccepted) => Promise<void>;

/**
 * A push moved a workspace's main (live-updates spec §3.2). `tokenId` is the pushing session, whose
 * sockets get no `head` back: its client already has the commit.
 */
export interface HeadMoved {
  readonly workspaceId: string;
  readonly head: string;
  readonly tokenId: string;
}

/**
 * Someone's role on some workspaces may have changed (live-updates spec §3.2). At least one field is
 * set. A subscription is affected when its workspace is `workspaceId`, or belongs to `teamId`, and,
 * when `userId` is set, only when its user is `userId`. It carries no role: the hub asks
 * `effectiveRole`, so HTTP's rules stay the only rules.
 */
export interface AccessChanged {
  readonly workspaceId?: string;
  readonly teamId?: string;
  readonly userId?: string;
}

/**
 * `accessChanged` as it is announced: with `tenantId`, as every announcement carries (hosted edition spec §19.8
 * guard 5), and the tenant's scope, which the live hub needs to look a team's workspaces up there.
 */
export type AccessChangedEvent = AccessChanged & { readonly tenantId: string; readonly tenant: TenantScope };

/** The `tenantId` and `tenant` an announcement made for a request carries. */
export function tenantOf(request: { readonly tenant: TenantScope }): {
  readonly tenantId: string;
  readonly tenant: TenantScope;
} {
  return { tenantId: request.tenant.tenantId, tenant: request.tenant };
}

/** One device token ended, or every token of a user except `exceptTokenId` (live-updates spec §3.2). */
export type SessionEnded = { readonly tokenId: string } | { readonly userId: string; readonly exceptTokenId?: string };

/**
 * `sessionEnded` as identity announces it: with the tenant the token or user belongs to (hosted edition spec
 * §19.8 guard 5). The listeners read it from Task 11.
 */
export type SessionEndedEvent = SessionEnded & { readonly tenantId: string };

/**
 * `headMoved`, `captureReceived` and `hooksChanged` as they are announced: with the tenant's id (hosted edition
 * spec §19.8 guard 5). Their listeners key on it from Task 11; none needs the scope to query.
 */
export type HeadMovedEvent = HeadMoved & { readonly tenantId: string };
export type CaptureReceivedEvent = CaptureReceived & { readonly tenantId: string };
export type HooksChangedEvent = HooksChanged & { readonly tenantId: string };
/** `scheduleRunFinished` with its tenant: the cancel's request's, or the executor's job-loop scope (Task 13). */
export type ScheduleRunFinishedEvent = ScheduleRunFinished & { readonly tenantId: string };

/** A catch URL stored a capture (webhook-capture spec §3.6); fired after the insert's transaction committed. */
export interface CaptureReceived {
  readonly workspaceId: string;
  readonly hookId: string;
  readonly captureId: string;
}

/** A workspace's catch URLs changed: created, changed, rotated, deleted or cleared (webhook-capture §3.6). */
export interface HooksChanged {
  readonly workspaceId: string;
}

/** A scheduled run ended, by its executor or a cancel (scheduled-runs spec §3.5); fired after the commit. */
export interface ScheduleRunFinished {
  readonly workspaceId: string;
  readonly scheduleId: string;
  readonly runId: string;
  readonly status: ScheduleRunStatus;
}

/**
 * A local agent's pairing was deleted, from the browser or by the agent (hosted edition spec §18.2); fired
 * after the delete committed. Meant for the server host to drop the pairing from its view; nothing
 * listens yet.
 */
export interface AgentUnpaired {
  readonly pairingId: string;
  readonly userId: string;
  /** The tenant the pairing was in (hosted edition spec §19.8): a user id means nothing without it. */
  readonly tenantId: string;
}

/** An after-commit listener: synchronous, never awaited, and its throw never reaches the caller (R3). */
export type Announcement<E> = (event: E) => void;

/**
 * Where a listener hears an announcement (hosted edition spec §20.3):
 *
 * - **`cluster`**: from this process and, through the notification bus, from every other instance. For a listener
 *   that keeps in-memory state in step: the live hub, the host instances, the terminal-share registry, the tenant
 *   map and the data-key cache.
 * - **`local`**: from this process only. For an effect that must happen once in the fleet, like the audit module's
 *   `licenseChanged` row.
 * - **`remote`**: from the other instances only (review M2). For a cache that the writing line here already keeps
 *   right itself, so hearing its own write again would undo it: the data-key cache drops nothing on its own key write,
 *   and the tenant map, which reloads on the directory's own change, does not reload twice.
 */
export type ListenerKind = 'cluster' | 'local' | 'remote';

declare const listenerBrand: unique symbol;

/** A listener with its kind: made only by {@link cluster}, {@link local} or {@link remote}, so a bare function is a type error. */
export interface Listener<E> {
  readonly kind: ListenerKind;
  readonly fn: Announcement<E>;
  readonly [listenerBrand]: true;
}

/** A listener that hears this process's announcements and every other instance's. */
export function cluster<E>(fn: Announcement<E>): Listener<E> {
  return Object.freeze({ kind: 'cluster', fn }) as Listener<E>;
}

/** A listener that hears this process's announcements only. */
export function local<E>(fn: Announcement<E>): Listener<E> {
  return Object.freeze({ kind: 'local', fn }) as Listener<E>;
}

/** A listener that hears the other instances' announcements only, through the bus (review M2). */
export function remote<E>(fn: Announcement<E>): Listener<E> {
  return Object.freeze({ kind: 'remote', fn }) as Listener<E>;
}

/**
 * The tenant directory changed: a tenant created, renamed or its status moved (spec §20.3). `tenantId` is the one
 * that changed, when the writer knows it; the listeners reload the whole map either way.
 */
export interface TenantsChangedEvent {
  readonly tenantId?: string;
}

/** A tenant's data key was written, or every tenant's (a re-wrap) when `tenantId` is absent (spec §20.3). */
export interface TenantKeysChangedEvent {
  readonly tenantId?: string;
}

/**
 * One instance's users in one room (spec §20.3): `users` are user ids only, never names (ADR-0013); a receiving hub
 * looks the display names up in the tenant. `holder` is the announcing process's id.
 */
export interface PresenceChangedEvent {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly holder: string;
  readonly users: readonly string[];
  /**
   * Set by the bus on a big room's list, cut into parts under the payload limit (review M1): this is part `part`
   * (0-based) of `parts`, and every part of one list shares `seq`. A hub never sets them; a receiving hub replaces
   * the holder's list once all the parts of one `seq` came.
   */
  readonly seq?: number;
  readonly part?: number;
  readonly parts?: number;
}

/** Drop every room's users `holder` announced (spec §20.3): it lost its bus, or it is stopping. */
export interface PresenceResetEvent {
  readonly holder: string;
}

/**
 * Something about the tenant changed that the bus could not carry (an event over the payload limit): each hub
 * resyncs that tenant's rooms (spec §20.3). Made by the bus, never by a module. Without `tenantId` it is the bus's
 * missed marker (review I2): the bus turns it into a resync of everything (`onListen` with `reconnected: true`) and
 * never hands it to this list.
 */
export interface ResyncEvent {
  readonly tenantId?: string;
}

/** A license was installed or removed (licensing spec §3.9); fired after the statement that stored or deleted it. */
export interface LicenseChanged {
  readonly action: 'installed' | 'removed';
  readonly licenseId?: string;
  readonly edition?: Edition;
  /** `null` from the command line, which has no user. */
  readonly actorUserId: string | null;
}

/**
 * `licenseChanged` as the routes announce it: with `tenantId`, as every announcement carries (hosted edition
 * spec §19.8 guard 5), and the request's scope, since the audit module's listener writes its event in that
 * tenant's unit (guard 6) and cannot brand a scope from an id.
 */
export type LicenseChangedEvent = LicenseChanged & { readonly tenantId: string; readonly tenant: TenantScope };

/**
 * A tenant's license (licensing spec §5.1; hosted edition spec §19.8 guard 5): each tenant has its own row and
 * its own seats. Read at request time, never at registration: identity registers before licensing replaces the
 * host's permissive default.
 */
export interface LicenseService {
  /**
   * Computed on demand from the tenant's stored row, the clock and one count of its users (§3.3), in one unit.
   * `of` is the scope, or a request for its `tenant`, which is read only when a license service needs it: a
   * server without licensing answers `/meta` with no tenant at all. Pass `tx`, one of that tenant's units, to
   * read inside it.
   */
  state(of: ScopeSource, tx?: TenantQuerier): Promise<LicenseState>;
  /** Inside the caller's tenant unit: refuses with `licensing-seat-limit` when no seat is free there (§3.4). */
  assertSeatAvailable(tx: TenantQuerier): Promise<void>;
  /** A preHandler for after a route's role guard: `licensing-feature-required` without the feature (§3.5). */
  requireFeature(feature: Feature): preHandlerAsyncHookHandler;
}

/**
 * What a server without the licensing module has: unlimited seats and no features. Tests that register
 * identity alone keep it, so identity's suites do not depend on licensing.
 */
export function permissiveLicense(): LicenseService {
  const state = (): Promise<LicenseState> =>
    Promise.resolve({ edition: 'community', status: 'none', seats: { used: 0, limit: null }, features: [] });
  return {
    state,
    assertSeatAvailable: () => Promise.resolve(),
    requireFeature: (feature) => requireFeature(feature, async () => (await state()).features),
  };
}

/** Who did it (audit-log spec §2, plan ruling 1). `email` is copied at event time, so a renamed account still reads. */
export type AuditActorInput =
  | { readonly kind: 'user'; readonly userId: string; readonly email: string; readonly tokenId?: string }
  | { readonly kind: 'ci-token'; readonly tokenId: string; readonly workspaceId: string }
  /** A SCIM token's write (saml-scim spec §3.5). */
  | { readonly kind: 'scim'; readonly tokenId: string }
  | { readonly kind: 'system' }
  | { readonly kind: 'anonymous' };

/** The request facts a fire site has; a function without a request receives one of these (plan ruling 3). */
export interface AuditSource {
  readonly actor: AuditActorInput;
  readonly ip?: string;
  readonly userAgent?: string;
}

/** One event before it has an id and a time (audit-log spec §3.1). `details` is flat; the hook bounds it. */
export interface AuditInput extends AuditSource {
  readonly action: AuditAction;
  readonly target: { readonly kind: AuditTargetKind; readonly id?: string };
  readonly workspaceId?: string;
  readonly teamId?: string;
  readonly details?: AuditDetails;
}

/** Runs inside the caller's transaction and is awaited (R1): a throw fails the action. */
export type AuditHook = (tx: TenantQuerier, event: AuditInput) => Promise<void>;

export const SYSTEM_SOURCE: AuditSource = { actor: { kind: 'system' } };
export const ANONYMOUS_SOURCE: AuditSource = { actor: { kind: 'anonymous' } };

/**
 * What a later module adds to an earlier module's work. Modules push onto these lists in
 * `register()`. There are two kinds:
 *
 * - **Hooks** (`invitationAccepted` (teams-access §3.4) and `audit` (audit-log §3.1)) run inside the caller's transaction
 *   and are awaited. Their writes commit with the caller's, and a throw rolls the caller back.
 * - **Announcements** (`headMoved`, `accessChanged`, `sessionEnded`; live-updates spec §3.2, R3;
 *   `captureReceived`, `hooksChanged`; webhook-capture spec §3.6; `licenseChanged`; licensing spec §3.9;
 *   `scheduleRunFinished`; scheduled-runs spec §3.5; `agentUnpaired`; hosted edition spec §18.2) run through {@link announce} after
 *   the caller's statement or transaction has resolved, on the success path. They are never awaited
 *   and never run inside a transaction, and a throw is logged and swallowed. A rolled-back
 *   transaction never reaches the line that announces. Slice 5 adds `tenantsChanged`, `tenantKeysChanged`,
 *   `presenceChanged`, `presenceReset` and the bus's own `resync` (spec §20.3). Each listener is registered as
 *   {@link cluster} or {@link local}, and the bus carries every announcement to the other instances' `cluster` ones.
 */
export interface ServerHooks extends AnnouncementLists {
  readonly invitationAccepted: InvitationAcceptedHook[];
  readonly audit: AuditHook[];
}

/** Every announcement's event, by the name its list has in {@link ServerHooks} and its `kind` on the bus. */
export interface AnnouncementEvents {
  readonly headMoved: HeadMovedEvent;
  readonly accessChanged: AccessChangedEvent;
  readonly sessionEnded: SessionEndedEvent;
  readonly captureReceived: CaptureReceivedEvent;
  readonly hooksChanged: HooksChangedEvent;
  readonly licenseChanged: LicenseChangedEvent;
  readonly scheduleRunFinished: ScheduleRunFinishedEvent;
  readonly agentUnpaired: AgentUnpaired;
  readonly tenantsChanged: TenantsChangedEvent;
  readonly tenantKeysChanged: TenantKeysChangedEvent;
  readonly presenceChanged: PresenceChangedEvent;
  readonly presenceReset: PresenceResetEvent;
  readonly resync: ResyncEvent;
}

export type AnnouncementKind = keyof AnnouncementEvents;

export const ANNOUNCEMENT_KINDS: readonly AnnouncementKind[] = [
  'headMoved',
  'accessChanged',
  'sessionEnded',
  'captureReceived',
  'hooksChanged',
  'licenseChanged',
  'scheduleRunFinished',
  'agentUnpaired',
  'tenantsChanged',
  'tenantKeysChanged',
  'presenceChanged',
  'presenceReset',
  'resync',
];

export type AnnouncementLists = { readonly [K in AnnouncementKind]: Announcements<AnnouncementEvents[K]> };

/** Where a list's announcements go after the local listeners: the notification bus, once one is connected. */
interface Outlet {
  send?: (kind: AnnouncementKind, event: unknown) => void;
}

/**
 * One announcement's listeners, in registration order, each `cluster` or `local` (spec §20.3). Every list of one
 * {@link serverHooks} shares one outlet, which {@link connectBus} points at the bus.
 */
export class Announcements<E> {
  readonly #listeners: Listener<E>[] = [];
  readonly #outlet: Outlet;
  readonly kind: AnnouncementKind;

  constructor(kind: AnnouncementKind, outlet: Outlet = {}) {
    this.kind = kind;
    this.#outlet = outlet;
  }

  push(...listeners: Listener<E>[]): number {
    return this.#listeners.push(...listeners);
  }

  get length(): number {
    return this.#listeners.length;
  }

  /** The `local` and `cluster` listeners: what an announcement in this process reaches. */
  all(): readonly Listener<E>[] {
    return this.#listeners.filter((listener) => listener.kind !== 'remote');
  }

  /** The `cluster` and `remote` listeners: what another instance's announcement reaches. */
  clustered(): readonly Listener<E>[] {
    return this.#listeners.filter((listener) => listener.kind !== 'local');
  }

  /** Hands the event to the bus, if one is connected. Never throws. */
  forward(event: E): void {
    this.#outlet.send?.(this.kind, event);
  }
}

const OUTLETS = new WeakMap<ServerHooks, Outlet>();

/**
 * Every list empty. The admin CLI (`identity/cli.ts`) builds its own and registers no hub, so an
 * announcement there reaches nobody (live-updates spec §14), and connects no bus.
 */
export function serverHooks(): ServerHooks {
  const outlet: Outlet = {};
  const lists = Object.fromEntries(ANNOUNCEMENT_KINDS.map((kind) => [kind, new Announcements(kind, outlet)]));
  const hooks = { invitationAccepted: [], audit: [], ...lists } as unknown as ServerHooks;
  OUTLETS.set(hooks, outlet);
  return hooks;
}

/**
 * Points every list of `hooks` at `send` (the bus's queue), or back at nothing. Returns the disconnect. A
 * `ServerHooks` not made by {@link serverHooks} has no outlet and is left alone.
 */
export function connectBus(hooks: ServerHooks, send: (kind: AnnouncementKind, event: unknown) => void): () => void {
  const outlet = OUTLETS.get(hooks);
  if (outlet === undefined) return () => undefined;
  outlet.send = send;
  return () => {
    if (outlet.send === send) delete outlet.send;
  };
}

/** Runs every `invitationAccepted` hook in registration order; the first throw propagates. */
export async function runInvitationAccepted(
  hooks: ServerHooks,
  tx: TenantQuerier,
  accepted: InvitationAccepted,
): Promise<void> {
  for (const hook of hooks.invitationAccepted) await hook(tx, accepted);
}

/** Records one event through every audit hook, in order, inside `tx`; the first throw propagates (audit-log §3.1). */
export async function recordAudit(hooks: ServerHooks, tx: TenantQuerier, event: AuditInput): Promise<void> {
  for (const hook of hooks.audit) await hook(tx, event);
}

/**
 * `raw` as a value Postgres `inet` accepts, or undefined. Behind a trusted proxy `request.ip` is whatever
 * the client wrote in `X-Forwarded-For`, so a junk value must not fail the audited action: an IPv6 zone
 * (`%eth0`) and the port of an IPv4 `a.b.c.d:port` are dropped, and anything still not an address is unknown.
 */
export function auditIp(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let value = raw.trim();
  const zone = value.indexOf('%');
  if (zone !== -1 && value.includes(':')) value = value.slice(0, zone);
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(value);
  if (v4WithPort !== null) value = v4WithPort[1]!;
  return isIP(value) !== 0 ? value : undefined;
}

/**
 * The actor and request facts for a fire site in a route (plan ruling 1): a signed-in user first, then
 * a CI token, then anonymous. `request.ip` honours `trustProxy` and passes through {@link auditIp}; the
 * user agent is bounded, never parsed.
 */
export function auditSource(request: FastifyRequest): AuditSource {
  const header = request.headers['user-agent'];
  const userAgent = typeof header === 'string' ? header.slice(0, 512) : undefined;
  const ip = auditIp(request.ip);
  const base = { ...(ip !== undefined ? { ip } : {}), ...(userAgent !== undefined ? { userAgent } : {}) };
  if (request.caller !== undefined) {
    const { id, email, tokenId } = request.caller;
    return { ...base, actor: { kind: 'user', userId: id, email, tokenId } };
  }
  if (request.ciCaller !== undefined) {
    return {
      ...base,
      actor: { kind: 'ci-token', tokenId: request.ciCaller.tokenId, workspaceId: request.ciCaller.workspaceId },
    };
  }
  return { ...base, actor: { kind: 'anonymous' } };
}

const ANNOUNCEMENT_FAILED = 'an announcement listener failed';

/**
 * Calls each listener in registration order with `event` (live-updates spec §3.2). A throw is logged
 * at warn and swallowed, and the next listener still runs. A listener that returns a promise anyway
 * has its rejection caught the same way, so it can never become an unhandled rejection. Never throws
 * and never awaits: a push or an access change must not fail or wait because of the hub (§12).
 *
 * Then the event goes to the notification bus's queue (spec §20.3), which carries it to the other instances'
 * `cluster` listeners. This process's own listeners, of both kinds, have heard it already.
 *
 * The listeners run outside any tenant unit (Task 6 re-review R4): nobody awaits them, so a listener that
 * queried through `ctx.tenancy.db` from inside a running unit would join it and make the unit fail with
 * `tenancy-unawaited`.
 */
export function announce<E>(listeners: Announcements<E>, event: E, log: FastifyBaseLogger): void {
  outsideTenantUnit(() => {
    callListeners(listeners.all(), event, log);
    try {
      listeners.forward(event);
    } catch (error) {
      log.warn({ err: error }, 'an announcement could not be queued for the other instances');
    }
  });
}

/**
 * Another instance's announcement, from the bus (spec §20.3): the `cluster` and `remote` listeners, on the same terms as
 * {@link announce}, and never forwarded again.
 */
export function deliverRemote<E>(listeners: Announcements<E>, event: E, log: FastifyBaseLogger): void {
  outsideTenantUnit(() => {
    callListeners(listeners.clustered(), event, log);
  });
}

function callListeners<E>(listeners: readonly Listener<E>[], event: E, log: FastifyBaseLogger): void {
  for (const { fn } of listeners) {
    try {
      const returned: unknown = fn(event);
      if (returned instanceof Promise) {
        returned.catch((error: unknown) => log.warn({ err: error }, ANNOUNCEMENT_FAILED));
      }
    } catch (error) {
      log.warn({ err: error }, ANNOUNCEMENT_FAILED);
    }
  }
}

/** What `/api/v1/meta` reports; modules fill it at registration. */
export class MetaRegistry {
  private readonly methods = { local: false, oidc: false };
  private readonly capabilityNames = new Set<string>();
  private oidcName: string | undefined;
  private saml = false;
  private samlName: string | undefined;
  private hooksMeta: HooksMeta | undefined;

  /** Which sign-in methods the server offers; identity sets them when it registers. Reporting them authorises nothing. */
  setSignInMethods(update: {
    local?: boolean;
    oidc?: boolean;
    oidcDisplayName?: string;
    saml?: boolean;
    samlDisplayName?: string;
  }): void {
    if (update.local !== undefined) this.methods.local = update.local;
    if (update.oidc !== undefined) this.methods.oidc = update.oidc;
    if (update.oidcDisplayName !== undefined) this.oidcName = update.oidcDisplayName;
    // saml-scim §3.1: reported only by a server that has the sso module and SAML configured.
    if (update.saml !== undefined) this.saml = update.saml;
    if (update.samlDisplayName !== undefined) this.samlName = update.samlDisplayName;
  }
  addCapability(name: string): void {
    this.capabilityNames.add(name);
  }
  signInMethods(): {
    local: boolean;
    oidc: boolean;
    oidcDisplayName?: string;
    saml?: boolean;
    samlDisplayName?: string;
  } {
    return {
      ...this.methods,
      ...(this.oidcName !== undefined ? { oidcDisplayName: this.oidcName } : {}),
      ...(this.saml ? { saml: true, ...(this.samlName !== undefined ? { samlDisplayName: this.samlName } : {}) } : {}),
    };
  }
  capabilities(): string[] {
    return [...this.capabilityNames].sort();
  }
  /** webhook-capture §3.7: set once by the module, `enabled: false` included; absent without the module. */
  setHooks(meta: HooksMeta): void {
    this.hooksMeta = { ...meta };
  }
  hooks(): HooksMeta | undefined {
    return this.hooksMeta === undefined ? undefined : { ...this.hooksMeta };
  }
}

export interface ServerContext {
  /** Without the configured public URL (`ModuleConfig`): a module asks `tenantUrl` for its tenant's. */
  readonly config: ModuleConfig;
  /**
   * The tenant databases and the job loop (hosted edition spec §19.8 guard 2): a module has no other way to the
   * database, so every statement it sends runs in one tenant's unit.
   */
  readonly tenancy: Tenancy;
  readonly repos: RepoStore;
  readonly git: GitCli;
  readonly log: FastifyBaseLogger;
  readonly meta: MetaRegistry;
  readonly hooks: ServerHooks;
  /**
   * The egress rule for connections the server opens on a user's or workspace's behalf (hosted edition
   * spec §17.5): `egressPolicyOf(config)`, which hosted mode always makes deny private ranges.
   */
  readonly egress: EgressPolicy;
  /**
   * This process (spec §20.1, §20.2): its holder id, one instance or several, and the 15 s heartbeat its instance row
   * renews on, which the host leases renew on too.
   */
  readonly instance: ServerInstance;
  /**
   * When the notification bus listens, the first time and after each loss (spec §20.3): the live hub resyncs its
   * rooms there. Announcing goes through `hooks`, never here.
   */
  readonly bus: BusEvents;
  /** Replaced by the licensing module in `register()`; the one field a module may assign (licensing spec §5.1). */
  license: LicenseService;
}

export interface ServerModule {
  readonly name:
    | 'identity'
    | 'licensing'
    | 'teams-access'
    | 'server-sync'
    | 'webhook-capture'
    | 'ci-tokens'
    | 'live-updates'
    | 'scheduled-runs'
    | 'audit-log'
    | 'sso'
    | 'session-logs'
    | 'terminal-shares'
    | 'host'
    | 'agent'
    | 'entry';
  /**
   * The module's `NNNN_name.sql` files, merged with the host's in version order (`serve.ts`
   * `allMigrations`). By convention `packages/server/migrations/<module>/` (e.g.
   * `migrations/identity/0002_identity.sql`): the package ships `migrations/` beside `dist/`, and
   * `tsc` copies no `.sql` files, so a folder under `src/` would be missing from the image.
   */
  readonly migrationsDir?: string | readonly string[];
  register(app: FastifyInstance, ctx: ServerContext): Promise<void>;
  /**
   * Routes served at the root, outside `/api/v1` and outside every module hook: a page a browser
   * opens from a link (identity's `/invite/:secret`). Most modules have none.
   */
  registerPublic?(app: FastifyInstance, ctx: ServerContext): Promise<void>;
}
