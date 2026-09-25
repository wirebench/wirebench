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
 * Work a later module does inside an earlier module's transaction (teams-access spec §3.4, R1).
 * Unlike an event, a hook is awaited and runs on the caller's transaction: its writes commit with
 * the caller's, and a throw rolls the caller back. Modules push onto these lists in `register()`.
 */
export interface ServerHooks {
  readonly invitationAccepted: InvitationAcceptedHook[];
}

export function serverHooks(): ServerHooks {
  return { invitationAccepted: [] };
}

/** Runs every `invitationAccepted` hook in registration order; the first throw propagates. */
export async function runInvitationAccepted(
  hooks: ServerHooks,
  tx: Querier,
  accepted: InvitationAccepted,
): Promise<void> {
  for (const hook of hooks.invitationAccepted) await hook(tx, accepted);
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
  readonly name: 'identity' | 'teams-access' | 'server-sync';
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
