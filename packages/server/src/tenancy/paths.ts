/**
 * The per-tenant layout of the data directory (hosted edition spec §19.6):
 *
 * ```
 * <dataDir>/
 *   no-hooks/                   every repository's core.hooksPath names this absolute path, so it stays here
 *   tenants/<tenantId>/
 *     repos/<workspaceId>.git
 *     checkouts/<userId>/       a user's host userData (§17.3)
 *     tmp/                      staging, moved-away repositories, sync's index files, the schedules' commit store
 *     tmp/schedules/            scheduled runs' working copies
 *     tmp/hosts/<userId>/       one host's scratch directory, removed at eviction
 * ```
 *
 * {@link tenantRoot} is the one function that builds `tenants/<id>`; every other tenant path derives from it. A
 * workspace or user id is only ever joined beneath a root it returned, so one id in two tenants is two places.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WirebenchError } from '@wirebench/engine';
import type { TenantScope } from './scope.js';

export const TENANTS_DIR = 'tenants';

/** What `gen_random_uuid()` prints, and nothing else: no upper case, braces or missing dashes. */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A tenant's directories; every one absolute. */
export interface TenantPaths {
  readonly root: string;
  readonly repos: string;
  readonly checkouts: string;
  readonly tmp: string;
  readonly schedules: string;
  readonly hosts: string;
}

// Names no tenant: a self-hosted operator never sees an id or a slug (spec §19.1).
const refused = (why: string): WirebenchError =>
  new WirebenchError('tenancy-tenant-path-refused', `a tenant directory was refused: ${why}`);

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';

/** `<dataDir>/tenants`, absolute. */
export function tenantsDir(dataDir: string): string {
  return join(resolve(dataDir), TENANTS_DIR);
}

/**
 * `<dataDir>/tenants/<scope.tenantId>`, absolute. It need not exist yet.
 *
 * @throws WirebenchError `tenancy-tenant-path-refused` when the id is not a canonical lower-case UUID, or the root
 *   exists and is a symlink, is not a directory, or resolves anywhere but the data directory's own
 *   `tenants/<id>` (a `tenants/` that is itself a link elsewhere). The data directory may sit under a symlink.
 */
export function tenantRoot(dataDir: string, scope: TenantScope): string {
  return checkedRoot(dataDir, scope.tenantId);
}

/**
 * {@link tenantRoot} by a bare tenant id, for the file step (spec §19.10), which runs before any scope exists and
 * reads the default tenant's id from `server_identity`. Every check is the same.
 */
export function tenantRootById(dataDir: string, tenantId: string): string {
  return checkedRoot(dataDir, tenantId);
}

function checkedRoot(dataDir: string, tenantId: string): string {
  if (!CANONICAL_UUID.test(tenantId)) throw refused('the tenant id is not a canonical UUID');
  const root = join(tenantsDir(dataDir), tenantId);
  let stat;
  try {
    stat = lstatSync(root);
  } catch (error) {
    if (isMissing(error)) return root;
    throw error;
  }
  if (stat.isSymbolicLink()) throw refused('it is a symlink');
  if (!stat.isDirectory()) throw refused('it is not a directory');
  if (realpathSync(root) !== join(realpathSync(resolve(dataDir)), TENANTS_DIR, tenantId)) {
    throw refused('it resolves outside the tenants directory');
  }
  return root;
}

/** Every directory of `scope`'s tenant, from {@link tenantRoot}. */
export function tenantPaths(dataDir: string, scope: TenantScope): TenantPaths {
  const root = tenantRoot(dataDir, scope);
  const tmp = join(root, 'tmp');
  return {
    root,
    repos: join(root, 'repos'),
    checkouts: join(root, 'checkouts'),
    tmp,
    schedules: join(tmp, 'schedules'),
    hosts: join(tmp, 'hosts'),
  };
}

/**
 * The `tmp/` of every tenant directory on disk, for the start-up sweeps, which run before any tenant is in scope.
 * Each root passes the same checks as {@link tenantRoot}; an entry of `tenants/` that is no tenant id is skipped.
 *
 * @throws WirebenchError `tenancy-tenant-path-refused` for a tenant root that is a symlink or resolves elsewhere.
 */
export async function tenantTmpDirs(dataDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(tenantsDir(dataDir));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return names.filter((name) => CANONICAL_UUID.test(name)).map((name) => join(checkedRoot(dataDir, name), 'tmp'));
}
