import { EventEmitter } from 'node:events';
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

/** Events one module emits for later modules (identity → teams-access, per the teams spec §3.4). */
export interface ServerEventMap {
  'invitation.accepted': [{ readonly invitationId: string; readonly userId: string }];
}

export class ServerEvents extends EventEmitter<ServerEventMap> {}

/** What `/api/v1/meta` reports; modules fill it at registration. */
export class MetaRegistry {
  private readonly authModes = { local: false, oidc: false };
  private readonly capabilityNames = new Set<string>();
  private oidcName: string | undefined;

  setAuth(update: { local?: boolean; oidc?: boolean; oidcDisplayName?: string }): void {
    if (update.local !== undefined) this.authModes.local = update.local;
    if (update.oidc !== undefined) this.authModes.oidc = update.oidc;
    if (update.oidcDisplayName !== undefined) this.oidcName = update.oidcDisplayName;
  }
  addCapability(name: string): void {
    this.capabilityNames.add(name);
  }
  auth(): { local: boolean; oidc: boolean; oidcDisplayName?: string } {
    return { ...this.authModes, ...(this.oidcName !== undefined ? { oidcDisplayName: this.oidcName } : {}) };
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
  readonly events: ServerEvents;
}

export interface ServerModule {
  readonly name: 'identity' | 'teams-access' | 'server-sync';
  /** Applied after the host's own migrations, in module order (`db/migrate.ts`). */
  readonly migrationsDir?: string;
  register(app: FastifyInstance, ctx: ServerContext): Promise<void>;
}
