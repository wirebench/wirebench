/**
 * The platform a user's host runs on inside the server (hosted edition spec §17.3, §17.4): a plain-Node
 * `HostPlatform` with no dialogs, shell or power, `send:public` alone, no machine values, and the user's
 * checkout directory as both its `userData` and the root every caller-named path must stay inside.
 *
 * It lives in `src/` (compiled, linted and unit-tested with the rest of the server) but declares its own
 * shape rather than importing `HostPlatform`: `@wirebench/host` is source-only and outside this package's
 * `rootDir` (ADR-0033). The bundle entry (`host-bundle/entry.ts`) assigns the result to a `HostPlatform`,
 * so its typecheck is what holds the two together.
 */
import { hkdfSync } from 'node:crypto';
import { join } from 'node:path';
import type { EgressPolicy } from '@wirebench/engine';
import { open, seal } from '../hooks/secret-box.js';
import { tenantPaths } from '../tenancy/paths.js';
import type { TenantScope } from '../tenancy/scope.js';

/** HKDF's salt for the per-user secrets key; changing it orphans every user's `secrets.json`. */
const SECRETS_SALT = 'wirebench-host-secrets';

/** What a server platform is built from. */
export interface ServerPlatformInput {
  /** The signed-in user the host is for; one path segment (a ULID). */
  readonly userId: string;
  /** The user's tenant: both directories are under its root (spec §19.6). */
  readonly scope: TenantScope;
  /** The server's data directory (`WIREBENCH_SERVER_DATA_DIR`, absolute). */
  readonly dataDir: string;
  /** The tenant's data key (spec §19.7, `ctx.tenancy.dataKey`): what the per-user key is derived from. */
  readonly dataKey: Buffer;
  /**
   * The server root, for the default tenant's hosts only, until the one-time re-wrap (plan Task 24): a blob that
   * does not open under the user's key is tried under slice 2's key, `userSecretsKey(root, userId)`. Nothing is
   * sealed under it. Without it a slice 2 cookie jar would be set aside as `.corrupt` on its first read.
   */
  readonly legacyRoot?: Buffer;
  readonly egress: EgressPolicy;
  /** The server's own version, shown where the desktop shows the app's. */
  readonly appVersion: string;
}

/** The directories a user's host is given, under its tenant (spec §19.6). */
export interface HostDirectories {
  /** `<dataDir>/tenants/<tenantId>/checkouts/<userId>`: the host's `userData` and root; its workspaces beneath it. */
  readonly checkout: string;
  /** `<dataDir>/tenants/<tenantId>/tmp/hosts/<userId>`: the user's own scratch directory, shared with nobody. */
  readonly temp: string;
}

/** The `HostPlatform` members the server provides, structurally (see the file comment). */
export interface ServerPlatform {
  readonly paths: { userData(): string; root(): string; temp(): string; logs(): string };
  readonly secrets: { available(): boolean; encrypt(plain: string): Buffer; decrypt(sealed: Buffer): string };
  readonly app: {
    version(): string;
    runtimeVersion(): string;
    packaged(): boolean;
    quit(): void;
    osTheme(): 'light';
    onOsThemeChanged(listener: () => void): () => void;
  };
  readonly proxy: { resolve(target: string): Promise<string> };
  readonly network: { readonly egress: EgressPolicy };
  readonly machineValues: false;
  readonly capabilities: ReadonlySet<'send:public'>;
}

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Where `userId`'s host in `scope`'s tenant lives under `dataDir`. Led by the tenant (Task 16 review M1): one user
 * id in two tenants is two checkouts and two scratch directories, so evicting one host never touches the other's.
 *
 * @throws Error when `userId` is not a single safe path segment; a user id is a ULID, so this never
 *   fires for a real one, and a `..` must never reach a path.
 * @throws WirebenchError `tenancy-tenant-path-refused` from `tenantRoot`.
 */
export function hostDirectories(dataDir: string, scope: TenantScope, userId: string): HostDirectories {
  if (!USER_ID.test(userId)) throw new Error('host: the user id is not a path segment');
  const tenant = tenantPaths(dataDir, scope);
  return { checkout: join(tenant.checkouts, userId), temp: join(tenant.hosts, userId) };
}

/**
 * The per-user secrets key: HKDF-SHA256 over the tenant's data key, salted for this use and bound to the user
 * id, so one user's `secrets.json` does not open under another's key, nor under another tenant's (spec §17.4,
 * §19.7, ADR-0036). Slice 2 derived it from the server root in place of the data key, the same way.
 */
export function userSecretsKey(dataKey: Buffer, userId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', dataKey, SECRETS_SALT, userId, 32));
}

/** Builds `input.userId`'s platform. Creates nothing on disk; the host makes `userData` as it needs it. */
export function createServerPlatform(input: ServerPlatformInput): ServerPlatform {
  const directories = hostDirectories(input.dataDir, input.scope, input.userId);
  const key = userSecretsKey(input.dataKey, input.userId);
  const legacy = input.legacyRoot === undefined ? undefined : userSecretsKey(input.legacyRoot, input.userId);
  const decrypt = (sealed: Buffer): string => {
    try {
      return open(key, sealed);
    } catch (error) {
      if (legacy === undefined) throw error;
      return open(legacy, sealed);
    }
  };
  return {
    paths: {
      userData: () => directories.checkout,
      root: () => directories.checkout,
      temp: () => directories.temp,
      logs: () => join(directories.checkout, 'logs'),
    },
    secrets: {
      available: () => true,
      encrypt: (plain) => seal(key, plain),
      decrypt,
    },
    app: {
      version: () => input.appVersion,
      runtimeVersion: () => process.versions.node,
      // Packaged: the host's e2e-only environment overrides stay off.
      packaged: () => true,
      // The server's lifecycle is not the host's to end.
      quit: () => undefined,
      // A server has no OS theme of the user's. The browser bootstrap passes the page's own
      // `prefers-color-scheme` (and its changes) to the renderer, which then ignores this value.
      osTheme: () => 'light',
      onOsThemeChanged: () => () => undefined,
    },
    // The server reaches the network directly; the egress rule, not a proxy, is what holds it.
    proxy: { resolve: () => Promise.resolve('DIRECT') },
    network: { egress: input.egress },
    machineValues: false,
    capabilities: new Set(['send:public'] as const),
  };
}
