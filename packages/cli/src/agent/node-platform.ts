/**
 * The platform the headless `wirebench agent` runs its host on (hosted edition spec §18.6): plain Node, no
 * dialogs, shell or power, and a folder of its own, `~/.wirebench/agent` (or `$WIREBENCH_AGENT_HOME`).
 *
 * The CLI has no OS keychain binding, so its secrets (the agent's private key among them) are sealed with
 * AES-256-GCM under a 32-byte key in `agent.key` beside them, and the file's mode is the protection: the
 * folder is made `0700` and the key `0600`, and on POSIX either one open to the group or to others is refused
 * at start-up, with the `chmod` that fixes it. Windows has no mode bits worth the name; there the folder's
 * ACL (the user's profile) protects it.
 *
 * Like the server's platform, it declares its own shape rather than importing `HostPlatform`:
 * `@wirebench/host` is source-only and outside this package's `rootDir` (ADR-0033). The bundle entry
 * (`agent-bundle/entry.ts`) assigns the result to a `HostPlatform`, so its typecheck holds the two together.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, stat, type FileHandle } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { kerberosProvider } from '@wirebench/engine';
import { proxyFromEnv } from '../proxy-env.js';

/** Where the agent keeps its pairings, key and host state, when set; `~/.wirebench/agent` otherwise. */
export const AGENT_HOME_VARIABLE = 'WIREBENCH_AGENT_HOME';

/** The secrets key's file in the agent's folder. */
export const AGENT_KEY_FILE = 'agent.key';

/** The key's length: AES-256. */
export const AGENT_KEY_BYTES = 32;

/** The sealed layout: `version(1) ‖ iv(12) ‖ tag(16) ‖ ciphertext`, as the server seals its secrets. */
const SEAL_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

/** The agent's folder or key cannot be used as it is; the message says why and how to fix it. */
export class AgentHomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentHomeError';
  }
}

/** `$WIREBENCH_AGENT_HOME`, or `~/.wirebench/agent`. */
export function agentHome(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const set = env[AGENT_HOME_VARIABLE];
  return set !== undefined && set.length > 0 ? set : join(home, '.wirebench', 'agent');
}

/** Whether the mode bits are worth checking here: not on Windows. */
function posix(platform: NodeJS.Platform): boolean {
  return platform !== 'win32';
}

function codeOf(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

function octal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, '0');
}

/**
 * Makes `dir` (`0700`) when it is missing and checks it: on POSIX a folder another account owns, or one open
 * to the group or to others, is refused.
 */
async function prepareFolder(dir: string, platform: NodeJS.Platform): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await stat(dir);
  if (!info.isDirectory()) throw new AgentHomeError(`${dir} is not a folder`);
  if (!posix(platform)) return;
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new AgentHomeError(`${dir} belongs to another account; the agent keeps its key there`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new AgentHomeError(
      `${dir} is open to other accounts (mode ${octal(info.mode)}); the agent keeps its key there. Run: chmod 700 ${dir}`,
    );
  }
}

/** Checks the open key file: a regular file of this account's, open to no one else, of exactly 32 bytes. */
async function checkKey(handle: FileHandle, path: string, platform: NodeJS.Platform): Promise<void> {
  const info = await handle.stat();
  if (!info.isFile()) throw new AgentHomeError(`${path} is not a file`);
  if (posix(platform)) {
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) throw new AgentHomeError(`${path} belongs to another account`);
    if ((info.mode & 0o077) !== 0) {
      throw new AgentHomeError(
        `${path} can be read by other accounts (mode ${octal(info.mode)}). Run: chmod 600 ${path}`,
      );
    }
  }
  if (info.size !== AGENT_KEY_BYTES) {
    throw new AgentHomeError(`${path} is not a key this agent wrote (${String(info.size)} bytes, not 32)`);
  }
}

/** Writes a fresh key to `path`, `0600`, only if there is none (`wx`); `false` when one is there already. */
async function createKey(path: string): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if (codeOf(error) === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(randomBytes(AGENT_KEY_BYTES));
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

/**
 * Prepares the agent's folder and returns its secrets key, making the key on the first run. Refuses (an
 * {@link AgentHomeError}) a folder or key file open to other accounts, a link in the key's place, and a key
 * of the wrong length: a key someone else could read seals nothing.
 *
 * @param platform `process.platform`; a test passes `win32` to see the mode check skipped.
 */
export async function openAgentHome(dir: string, platform: NodeJS.Platform = process.platform): Promise<Buffer> {
  await prepareFolder(dir, platform);
  const path = join(dir, AGENT_KEY_FILE);
  await createKey(path);
  // Not through a link: a key file swapped for a link to someone else's file must not be read as ours.
  const noFollow = posix(platform) ? (constants.O_NOFOLLOW ?? 0) : 0;
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (codeOf(error) === 'ELOOP') throw new AgentHomeError(`${path} is a link, not the agent's key`);
    throw error;
  }
  try {
    await checkKey(handle, path, platform);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** Seals `plain` under `key` with a fresh IV. */
export function seal(key: Buffer, plain: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([SEAL_VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

/** @throws Error when `sealed` is not of this layout or does not authenticate under `key`. */
export function unseal(key: Buffer, sealed: Buffer): string {
  if (sealed.length < HEADER_BYTES || sealed[0] !== SEAL_VERSION) throw new Error('sealed secret: unknown format');
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(1, 1 + IV_BYTES));
  decipher.setAuthTag(sealed.subarray(1 + IV_BYTES, HEADER_BYTES));
  return Buffer.concat([decipher.update(sealed.subarray(HEADER_BYTES)), decipher.final()]).toString('utf8');
}

/** Whether the Kerberos binding loads in this process (ADR-0019: it is an optional native dependency). */
export function kerberosLoads(): boolean {
  return kerberosProvider().availability().available;
}

/** What the headless agent's platform is built from. */
export interface AgentPlatformInput {
  /** The agent's folder, prepared by {@link openAgentHome}. */
  readonly home: string;
  /** Its secrets key, from {@link openAgentHome}. */
  readonly key: Buffer;
  /** The CLI's version, shown where the desktop shows the app's. */
  readonly version: string;
  /** Whether the Kerberos binding loads here ({@link kerberosLoads}). */
  readonly kerberos: boolean;
  /** Where `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` are read from. */
  readonly env: NodeJS.ProcessEnv;
}

/** What the agent can do: send anywhere this machine reaches, read secret sources, and Kerberos when it loads. */
export type AgentCapability = 'send:private' | 'send:public' | 'secret-sources' | 'kerberos';

/** The `HostPlatform` members the headless agent provides, structurally (see the file comment). */
export interface AgentNodePlatform {
  readonly paths: { userData(): string; temp(): string; logs(): string };
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
  readonly capabilities: ReadonlySet<AgentCapability>;
}

/** A proxy URL as a PAC entry: `PROXY host:port`, or `HTTPS host:port` for a proxy reached over TLS. */
function pacEntry(proxyUrl: string): string {
  const url = new URL(proxyUrl);
  const tls = url.protocol === 'https:';
  const port = url.port !== '' ? url.port : tls ? '443' : '80';
  return `${tls ? 'HTTPS' : 'PROXY'} ${url.hostname}:${port}`;
}

/**
 * Builds the headless agent's platform. Its temp folder is `os.tmpdir()`, the desktop's too, so either one's
 * sweep of stale send folders sees both. No `network.egress`: it sends from the person's own machine, as the
 * desktop does, and `machineValues` stays the host's default; a paired server reads only the
 * `${#System#…}` names the agent's own allowlist lets through.
 *
 * @throws UsageError when a proxy variable is not a URL.
 */
export function createAgentPlatform(input: AgentPlatformInput): AgentNodePlatform {
  const { key } = input;
  const proxyFor = proxyFromEnv(input.env);
  const capabilities: AgentCapability[] = ['send:private', 'send:public', 'secret-sources'];
  if (input.kerberos) capabilities.push('kerberos');
  return {
    paths: {
      userData: () => input.home,
      temp: () => tmpdir(),
      logs: () => join(input.home, 'logs'),
    },
    secrets: {
      available: () => true,
      encrypt: (plain) => seal(key, plain),
      decrypt: (sealed) => unseal(key, sealed),
    },
    app: {
      version: () => input.version,
      runtimeVersion: () => process.versions.node,
      // Packaged: the host's e2e-only environment overrides stay off.
      packaged: () => true,
      // The agent's lifecycle is the command's: SIGINT or SIGTERM ends it.
      quit: () => undefined,
      osTheme: () => 'light',
      onOsThemeChanged: () => () => undefined,
    },
    // A terminal has no system proxy setting of its own; the conventional variables are what it obeys.
    proxy: {
      resolve: (target) => {
        const proxy = proxyFor(target);
        return Promise.resolve(proxy === undefined ? 'DIRECT' : pacEntry(proxy.url));
      },
    },
    capabilities: new Set(capabilities),
  };
}
