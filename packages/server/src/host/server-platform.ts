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

/** HKDF's salt for the per-user secrets key; changing it orphans every user's `secrets.json`. */
const SECRETS_SALT = 'wirebench-host-secrets';

/** What a server platform is built from. */
export interface ServerPlatformInput {
  /** The signed-in user the host is for; one path segment (a ULID). */
  readonly userId: string;
  /** The server's data directory (`WIREBENCH_SERVER_DATA_DIR`, absolute). */
  readonly dataDir: string;
  /** `WIREBENCH_SERVER_SECRETS_KEY`: the root the per-user key is derived from. */
  readonly secretsKey: Buffer;
  readonly egress: EgressPolicy;
  /** The server's own version, shown where the desktop shows the app's. */
  readonly appVersion: string;
}

/** The directories a user's host is given. Slice 4 prefixes both with `tenants/<tenantId>/`. */
export interface HostDirectories {
  /** `<dataDir>/checkouts/<userId>`: the host's `userData` and root; its workspaces live beneath it. */
  readonly checkout: string;
  /** `<dataDir>/tmp/<userId>`: the user's own scratch directory, shared with nobody. */
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
 * Where `userId`'s host lives under `dataDir`.
 *
 * @throws Error when `userId` is not a single safe path segment; a user id is a ULID, so this never
 *   fires for a real one, and a `..` must never reach a path.
 */
export function hostDirectories(dataDir: string, userId: string): HostDirectories {
  if (!USER_ID.test(userId)) throw new Error('host: the user id is not a path segment');
  return { checkout: join(dataDir, 'checkouts', userId), temp: join(dataDir, 'tmp', userId) };
}

/**
 * The per-user secrets key: HKDF-SHA256 over the server's key, salted for this use and bound to the user
 * id, so one user's `secrets.json` does not open under another's key (spec §17.4).
 */
export function userSecretsKey(secretsKey: Buffer, userId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secretsKey, SECRETS_SALT, userId, 32));
}

/** Builds `input.userId`'s platform. Creates nothing on disk; the host makes `userData` as it needs it. */
export function createServerPlatform(input: ServerPlatformInput): ServerPlatform {
  const directories = hostDirectories(input.dataDir, input.userId);
  const key = userSecretsKey(input.secretsKey, input.userId);
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
      decrypt: (sealed) => open(key, sealed),
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
