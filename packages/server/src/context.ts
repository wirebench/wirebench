import type { FastifyBaseLogger, FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type {
  AuditAction,
  AuditDetails,
  AuditTargetKind,
  Edition,
  Feature,
  GitCli,
  HooksMeta,
  LicenseState,
} from '@wirebench/engine';
import type { ServerConfig } from './config.js';
import { requireFeature } from './licensing/gate.js';
import type { RepoStore } from './repos/repo-store.js';

/** The slice of `pg.Pool` the modules use, so tests can pass a fake. */
export interface Querier {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: R[]; readonly rowCount: number | null }>;
}

/** A querier that can also run a function inside one transaction. */
export interface Database extends Querier {
  transaction<T>(fn: (tx: Querier) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** What identity reports when an invitation becomes a user (teams-access spec §3.4). */
export interface InvitationAccepted {
  readonly invitationId: string;
  readonly userId: string;
}

export type InvitationAcceptedHook = (tx: Querier, accepted: InvitationAccepted) => Promise<void>;

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

/** One device token ended, or every token of a user except `exceptTokenId` (live-updates spec §3.2). */
export type SessionEnded = { readonly tokenId: string } | { readonly userId: string; readonly exceptTokenId?: string };

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

/** An after-commit listener: synchronous, never awaited, and its throw never reaches the caller (R3). */
export type Announcement<E> = (event: E) => void;

/** A license was installed or removed (licensing spec §3.9); fired after the statement that stored or deleted it. */
export interface LicenseChanged {
  readonly action: 'installed' | 'removed';
  readonly licenseId?: string;
  readonly edition?: Edition;
  /** `null` from the command line, which has no user. */
  readonly actorUserId: string | null;
}

/**
 * The server's license (licensing spec §5.1). Read at request time, never at registration: identity
 * registers before licensing replaces the host's permissive default.
 */
export interface LicenseService {
  /** Computed on demand from the stored row, the clock and one count (§3.3). Pass `tx` inside a transaction. */
  state(tx?: Querier): Promise<LicenseState>;
  /** Inside the caller's transaction: refuses with `licensing-seat-limit` when no seat is free (§3.4). */
  assertSeatAvailable(tx: Querier): Promise<void>;
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
    requireFeature: (feature) => requireFeature(feature, state),
  };
}

/** Who did it (audit-log spec §2, plan ruling 1). `email` is copied at event time, so a renamed account still reads. */
export type AuditActorInput =
  | { readonly kind: 'user'; readonly userId: string; readonly email: string; readonly tokenId?: string }
  | { readonly kind: 'ci-token'; readonly tokenId: string; readonly workspaceId: string }
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
export type AuditHook = (tx: Querier, event: AuditInput) => Promise<void>;

export const SYSTEM_SOURCE: AuditSource = { actor: { kind: 'system' } };
export const ANONYMOUS_SOURCE: AuditSource = { actor: { kind: 'anonymous' } };

/**
 * What a later module adds to an earlier module's work. Modules push onto these lists in
 * `register()`. There are two kinds:
 *
 * - **Hooks** (`invitationAccepted` (teams-access §3.4) and `audit` (audit-log §3.1)) run inside the caller's transaction
 *   and are awaited. Their writes commit with the caller's, and a throw rolls the caller back.
 * - **Announcements** (`headMoved`, `accessChanged`, `sessionEnded`; live-updates spec §3.2, R3;
 *   `captureReceived`, `hooksChanged`; webhook-capture spec §3.6; `licenseChanged`; licensing spec §3.9) run through {@link announce} after
 *   the caller's statement or transaction has resolved, on the success path. They are never awaited
 *   and never run inside a transaction, and a throw is logged and swallowed. A rolled-back
 *   transaction never reaches the line that announces.
 */
export interface ServerHooks {
  readonly invitationAccepted: InvitationAcceptedHook[];
  readonly audit: AuditHook[];
  readonly headMoved: Announcement<HeadMoved>[];
  readonly accessChanged: Announcement<AccessChanged>[];
  readonly sessionEnded: Announcement<SessionEnded>[];
  readonly captureReceived: Announcement<CaptureReceived>[];
  readonly hooksChanged: Announcement<HooksChanged>[];
  readonly licenseChanged: Announcement<LicenseChanged>[];
}

/**
 * Every list empty. The admin CLI (`identity/cli.ts`) builds its own and registers no hub, so an
 * announcement there reaches nobody (live-updates spec §14).
 */
export function serverHooks(): ServerHooks {
  return {
    invitationAccepted: [],
    audit: [],
    headMoved: [],
    accessChanged: [],
    sessionEnded: [],
    captureReceived: [],
    hooksChanged: [],
    licenseChanged: [],
  };
}

/** Runs every `invitationAccepted` hook in registration order; the first throw propagates. */
export async function runInvitationAccepted(
  hooks: ServerHooks,
  tx: Querier,
  accepted: InvitationAccepted,
): Promise<void> {
  for (const hook of hooks.invitationAccepted) await hook(tx, accepted);
}

/** Records one event through every audit hook, in order, inside `tx`; the first throw propagates (audit-log §3.1). */
export async function recordAudit(hooks: ServerHooks, tx: Querier, event: AuditInput): Promise<void> {
  for (const hook of hooks.audit) await hook(tx, event);
}

/**
 * The actor and request facts for a fire site in a route (plan ruling 1): a signed-in user first, then
 * a CI token, then anonymous. `request.ip` honours `trustProxy`; the user agent is bounded, never parsed.
 */
export function auditSource(request: FastifyRequest): AuditSource {
  const header = request.headers['user-agent'];
  const userAgent = typeof header === 'string' ? header.slice(0, 512) : undefined;
  const base = { ip: request.ip, ...(userAgent !== undefined ? { userAgent } : {}) };
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
 */
export function announce<E>(listeners: readonly Announcement<E>[], event: E, log: FastifyBaseLogger): void {
  for (const listener of listeners) {
    try {
      const returned: unknown = listener(event);
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
  private hooksMeta: HooksMeta | undefined;

  /** Which sign-in methods the server offers; identity sets them when it registers. Reporting them authorises nothing. */
  setSignInMethods(update: { local?: boolean; oidc?: boolean; oidcDisplayName?: string }): void {
    if (update.local !== undefined) this.methods.local = update.local;
    if (update.oidc !== undefined) this.methods.oidc = update.oidc;
    if (update.oidcDisplayName !== undefined) this.oidcName = update.oidcDisplayName;
  }
  addCapability(name: string): void {
    this.capabilityNames.add(name);
  }
  signInMethods(): { local: boolean; oidc: boolean; oidcDisplayName?: string } {
    return { ...this.methods, ...(this.oidcName !== undefined ? { oidcDisplayName: this.oidcName } : {}) };
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
  readonly config: ServerConfig;
  readonly db: Database;
  readonly repos: RepoStore;
  readonly git: GitCli;
  readonly log: FastifyBaseLogger;
  readonly meta: MetaRegistry;
  readonly hooks: ServerHooks;
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
    | 'audit-log';
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
