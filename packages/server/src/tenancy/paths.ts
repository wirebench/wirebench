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
import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { WirebenchError } from '@wirebench/engine';
import { CANONICAL_UUID, type TenantScope } from './scope.js';

export const TENANTS_DIR = 'tenants';

/** A tenant's directories; every one absolute. */
export interface TenantPaths {
  readonly root: string;
  readonly repos: string;
  readonly checkouts: string;
  readonly tmp: string;
  readonly schedules: string;
  readonly hosts: string;
}

// Names no tenant id in a request's refusal.
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
 * @throws WirebenchError `tenancy-tenant-path-refused` when the id is not a canonical lower-case UUID, or when
 *   `tenants/` or the root exists and is a symlink, is not a directory, or resolves anywhere but the data
 *   directory's own `tenants/` and `tenants/<id>`; checked whether the root exists yet or not. A failed `lstat` or
 *   `realpath` is a refusal too, naming no path. The data directory may sit under a symlink.
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

/**
 * The `lstat` of `path`, or `undefined` when nothing is there. Any other failure is a refusal that names no path:
 * Node's own error holds `…/tenants/<id>`, and it would reach a request's log or the start-up error (Task 21 review
 * M1).
 */
function statOf(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw refused(`it could not be read (${codeOf(error)})`);
  }
}

function realOf(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    throw refused(`it could not be resolved (${codeOf(error)})`);
  }
}

const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException | null)?.code ?? 'unknown error';

/** A directory that exists must be a real directory at `expected`, never a link or a file. */
function assertRealDirectory(path: string, expected: string): void {
  const stat = statOf(path);
  if (stat === undefined) return;
  if (stat.isSymbolicLink()) throw refused('it is a symlink');
  if (!stat.isDirectory()) throw refused('it is not a directory');
  if (realOf(path) !== expected) throw refused('it resolves outside the tenants directory');
}

/**
 * The checks of {@link tenantRoot}. They hold against the server's own inputs (an id, a path it builds), not against
 * someone who can write to the data directory: a root swapped for a link between this check and the use of the
 * path (git, rename, a host's whole life) is not caught. Fd-relative opens with `O_NOFOLLOW` on every component
 * would be, but `git -C` takes a path (Task 21 review M3). `tenantPaths`' cache of verified sub-directories widens
 * that window to the process's life, under the same attacker, who can already write the tenant's files.
 */
function checkedRoot(dataDir: string, tenantId: string): string {
  if (!CANONICAL_UUID.test(tenantId)) throw refused('the tenant id is not a canonical UUID');
  const root = join(tenantsDir(dataDir), tenantId);
  // No data directory yet: nothing beneath it exists to be a link.
  if (statOf(resolve(dataDir)) === undefined) return root;
  const realTenants = join(realOf(resolve(dataDir)), TENANTS_DIR);
  // tenants/ itself first: a missing root behind a tenants/ that links elsewhere would otherwise be made there by
  // the first mkdir (Task 21 review I1).
  assertRealDirectory(tenantsDir(dataDir), realTenants);
  assertRealDirectory(root, join(realTenants, tenantId));
  return root;
}

/** Roots whose sub-directories all exist and were found real, by absolute path. */
const verified = new Set<string>();

/** Every directory of `scope`'s tenant, from {@link tenantRoot}. */
export function tenantPaths(dataDir: string, scope: TenantScope): TenantPaths {
  const root = tenantRoot(dataDir, scope);
  const tmp = join(root, 'tmp');
  const paths = {
    root,
    repos: join(root, 'repos'),
    checkouts: join(root, 'checkouts'),
    tmp,
    schedules: join(tmp, 'schedules'),
    hosts: join(tmp, 'hosts'),
  };
  // The directories beneath the root too (Task 21 review M2): a tenants/A/repos linked to tenants/B/repos would
  // hand A's paths into B. The root is real by now, so each must resolve to itself under it.
  if (verified.has(root) || statOf(root) === undefined) return paths;
  const realRoot = realOf(root);
  let all = true;
  for (const [name, path] of Object.entries(paths)) {
    if (name === 'root') continue;
    if (statOf(path) === undefined) all = false;
    assertRealDirectory(path, join(realRoot, relative(root, path)));
  }
  // Once every directory beneath a root exists and checked out, it is not checked again for the process's life: the
  // server never makes one a link, and these are synchronous calls on the request path (Task 22 review m6). The root
  // and tenants/ themselves are still checked on every call.
  if (all) verified.add(root);
  return paths;
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
