import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { GitCli } from '@wirebench/engine';
import type { ServerConfig } from './config.js';
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

/** An after-commit listener: synchronous, never awaited, and its throw never reaches the caller (R3). */
export type Announcement<E> = (event: E) => void;

/**
 * What a later module adds to an earlier module's work. Modules push onto these lists in
 * `register()`. There are two kinds:
 *
 * - **Hooks** (`invitationAccepted`; teams-access spec §3.4, R1) run inside the caller's transaction
 *   and are awaited. Their writes commit with the caller's, and a throw rolls the caller back.
 * - **Announcements** (`headMoved`, `accessChanged`, `sessionEnded`; live-updates spec §3.2, R3) run
 *   through {@link announce} after the caller's statement or transaction has resolved, on the success
 *   path. They are never awaited and never run inside a transaction, and a throw is logged and
 *   swallowed. A rolled-back transaction never reaches the line that announces.
 */
export interface ServerHooks {
  readonly invitationAccepted: InvitationAcceptedHook[];
  readonly headMoved: Announcement<HeadMoved>[];
  readonly accessChanged: Announcement<AccessChanged>[];
  readonly sessionEnded: Announcement<SessionEnded>[];
}

/**
 * Every list empty. The admin CLI (`identity/cli.ts`) builds its own and registers no hub, so an
 * announcement there reaches nobody (live-updates spec §14).
 */
export function serverHooks(): ServerHooks {
  return { invitationAccepted: [], headMoved: [], accessChanged: [], sessionEnded: [] };
}

/** Runs every `invitationAccepted` hook in registration order; the first throw propagates. */
export async function runInvitationAccepted(
  hooks: ServerHooks,
  tx: Querier,
  accepted: InvitationAccepted,
): Promise<void> {
  for (const hook of hooks.invitationAccepted) await hook(tx, accepted);
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
}

export interface ServerContext {
  readonly config: ServerConfig;
  readonly db: Database;
  readonly repos: RepoStore;
  readonly git: GitCli;
  readonly log: FastifyBaseLogger;
  readonly meta: MetaRegistry;
  readonly hooks: ServerHooks;
}

export interface ServerModule {
  readonly name: 'identity' | 'teams-access' | 'server-sync' | 'live-updates';
  /**
   * The module's `NNNN_name.sql` files, merged with the host's in version order (`serve.ts`
   * `allMigrations`). By convention `packages/server/migrations/<module>/` (e.g.
   * `migrations/identity/0002_identity.sql`): the package ships `migrations/` beside `dist/`, and
   * `tsc` copies no `.sql` files, so a folder under `src/` would be missing from the image.
   */
  readonly migrationsDir?: string;
  register(app: FastifyInstance, ctx: ServerContext): Promise<void>;
  /**
   * Routes served at the root, outside `/api/v1` and outside every module hook: a page a browser
   * opens from a link (identity's `/invite/:secret`). Most modules have none.
   */
  registerPublic?(app: FastifyInstance, ctx: ServerContext): Promise<void>;
}
