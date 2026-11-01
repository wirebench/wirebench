/**
 * Bare repositories, one per workspace of a tenant, under `<dataDir>/tenants/<tenantId>/repos/<workspaceId>.git`
 * (host spec §3.5, hosted edition spec §19.6). Paths derive from the tenant's root (`tenantRoot`) and a validated
 * ULID and nothing else (ADR-0005 applied server-side), so one workspace id in two tenants is two repositories.
 * Hooks can never run: every repository's `core.hooksPath` is an empty directory the server owns, at the data
 * directory's root. Removal moves; it never deletes.
 */
import { access, mkdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { GitCli, WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';
import { tenantPaths, tenantTmpDirs, TENANTS_DIR } from '../tenancy/paths.js';
import type { TenantScope } from '../tenancy/scope.js';

/** Sync spec R11: new repository work after shutdown began; a client retries against the next process. */
const shuttingDown = (): WirebenchError =>
  problem('server-shutting-down', 'The server is shutting down. Try again in a moment.', 503);

export const NO_HOOKS_DIR = 'no-hooks';

/** Crockford base32 ULID, upper case, 26 characters — what `ulidx` mints. */
const WORKSPACE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isWorkspaceId(value: string): boolean {
  return WORKSPACE_ID.test(value);
}

/** The git subcommands this store runs; the allow-list is `GIT_SUBCOMMANDS` in the engine. */
const GIT = { init: 'init', config: 'config', symbolicRef: 'symbolic-ref' } as const;

export class RepoStore {
  private readonly git: GitCli;
  private readonly dataDir: string;
  private readonly queues = new Map<string, Promise<void>>();
  /** Set by {@link drain}; from then on {@link withLock} refuses new work. */
  private draining = false;

  constructor(deps: { readonly git: GitCli; readonly dataDir: string }) {
    this.git = deps.git;
    this.dataDir = resolve(deps.dataDir);
  }

  /**
   * Creates `tenants/` and `no-hooks/`, the two directories the store needs at the data directory's root (spec
   * §19.6); called once at start-up. A tenant's own directories are made as its first repository is.
   */
  static async prepare(dataDir: string): Promise<void> {
    for (const dir of [TENANTS_DIR, NO_HOOKS_DIR]) {
      await mkdir(join(dataDir, dir), { recursive: true });
    }
  }

  private assertId(workspaceId: string): void {
    if (!isWorkspaceId(workspaceId)) {
      throw problem('server-workspace-id-invalid', 'Workspace ids are 26-character ULIDs.', 400);
    }
  }

  /** `scope`'s repository for `workspaceId`; it need not exist. */
  path(scope: TenantScope, workspaceId: string): string {
    this.assertId(workspaceId);
    return join(tenantPaths(this.dataDir, scope).repos, `${workspaceId}.git`);
  }

  /**
   * `scope`'s scratch directory (`tenants/<id>/tmp`, absolute): staging, moved-away repositories and server-sync's
   * private index files.
   */
  tmpDir(scope: TenantScope): string {
    return tenantPaths(this.dataDir, scope).tmp;
  }

  /** Every tenant's scratch directory on disk, for the start-up sweeps (`tenantTmpDirs`). */
  tmpDirs(): Promise<string[]> {
    return tenantTmpDirs(this.dataDir);
  }

  exists(scope: TenantScope, workspaceId: string): Promise<boolean> {
    return access(join(this.path(scope, workspaceId), 'HEAD')).then(
      () => true,
      () => false,
    );
  }

  /**
   * Initialises the repository in the tenant's `tmp/` and renames it into the tenant's `repos/` (teams-access
   * spec §3.7): a crash or a failing git step leaves a stray `tmp/creating-…` directory, never a half-built
   * repository at the path the workspace id names. Both are under one tenant root, so the rename stays on one
   * filesystem. Callers run it inside {@link withLock}.
   */
  async create(scope: TenantScope, workspaceId: string): Promise<void> {
    const dir = this.path(scope, workspaceId);
    if (await this.exists(scope, workspaceId)) {
      throw problem('server-repo-exists', 'A repository for this workspace already exists.', 409);
    }
    const tenant = tenantPaths(this.dataDir, scope);
    const staging = join(tenant.tmp, `creating-${workspaceId}-${randomBytes(4).toString('hex')}`);
    await mkdir(staging, { recursive: true });
    await mkdir(tenant.repos, { recursive: true });
    await this.git.run(staging, [GIT.init, '--bare', '--quiet']);
    await this.git.run(staging, [GIT.symbolicRef, 'HEAD', 'refs/heads/main']);
    await this.git.run(staging, [GIT.config, 'core.hooksPath', join(this.dataDir, NO_HOOKS_DIR)]);
    await this.git.run(staging, [GIT.config, 'receive.denyNonFastForwards', 'true']);
    await rename(staging, dir);
  }

  /** Moves `scope`'s repository for `workspaceId` into the tenant's `tmp/removed-…`; never deletes. */
  async remove(scope: TenantScope, workspaceId: string): Promise<void> {
    const dir = this.path(scope, workspaceId);
    const tmp = this.tmpDir(scope);
    await mkdir(tmp, { recursive: true });
    await rename(dir, join(tmp, `removed-${workspaceId}-${Date.now()}`));
  }

  /**
   * One operation per workspace at a time, FIFO, in-process (spec assumption 1). Once {@link drain}
   * has begun it refuses with `server-shutting-down` (503) as a rejected promise, never a throw:
   * callers chain `.catch` on it (the workspace-create cleanup does), and a synchronous throw would
   * escape that. An invalid id still throws at once, as a programming error.
   *
   * Keyed `tenantId:workspaceId` (hosted edition spec §19.8 guard 5): workspace ids are per tenant, so one id
   * in two tenants is two queues, as it is two repositories.
   */
  withLock<T>(scope: TenantScope, workspaceId: string, fn: () => Promise<T>): Promise<T> {
    this.assertId(workspaceId);
    if (this.draining) return Promise.reject(shuttingDown());
    const key = `${scope.tenantId}:${workspaceId}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous.then(fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return run;
  }

  /**
   * Host spec §3.7, sync spec R11: shutdown stops new repository work and waits for what is queued.
   * A handler keeps running after the drain deadline drops its connection, so the database pool must
   * outlive the repository work, not only the request. Each queue entry is the settled tail of that
   * workspace's chain (it never rejects), so this resolves once every queued operation has finished,
   * whatever its outcome. Calling it again waits for whatever is still queued.
   */
  drain(): Promise<void> {
    this.draining = true;
    return Promise.all(this.queues.values()).then(() => undefined);
  }
}
