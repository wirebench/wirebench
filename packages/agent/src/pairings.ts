/**
 * The agent's pairings and key, in `userData/agent-pairings.json` (hosted edition spec §18.2):
 *
 * `{ version: 2, agentId, privateKeySealed, allowedSystemNames: [], pairings: [{ pairingId, serverUrl, origin,
 * email, sshOptIn, createdAt, port? }] }`
 *
 * `allowedSystemNames` is this machine's allowlist of `${#System#NAME}` names a bundle send may read (§18.5),
 * empty by default. It lives here rather than in a file of its own so one lock, one re-read and one atomic
 * rename cover it: a `wirebench agent` beside the desktop sees a change at its next refresh, and two writers
 * never lose each other's edit. A version 1 file (before the allowlist) reads as version 2 with an empty
 * list, and is written back as version 2 at its next change.
 *
 * The private key is sealed by the platform's secret store (`safeStorage` on the desktop, the headless
 * agent's own key file) before it touches the disk; nothing else in the file is a secret. The agent id and
 * the key are made at the first pairing, so an install that never pairs writes nothing. Every write goes to a
 * temporary file renamed over the old one, so a crash leaves the old file or the new, never half of one.
 *
 * The desktop's agent and a `wirebench agent pair` may write the file at the same time, so every write
 * (identity creation included) holds `agent-pairings.json.lock`, made with `O_EXCL`, across its re-read, its
 * change, the rename and the stamp read. The lock file holds its holder's token (pid and a random id), and a
 * holder removes it only while it still holds that token. A lock older than {@link STALE_LOCK_MS} is a
 * crashed writer's: a taker renames it aside (only one rename of it can succeed), checks by inode, mtime and
 * token that it moved the very lock it judged stale, and then competes for a new lock like anyone else. A
 * release, too, renames the lock aside before checking its token, so it never removes a successor's lock.
 */
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { HostPlatform } from '@wirebench/host';
import { agentKeyFromPkcs8, generateAgentKey, type AgentKey } from './keys.js';

export const PAIRINGS_FILE = 'agent-pairings.json';

/** How long a write waits for another process's lock before it gives up. */
export const LOCK_TIMEOUT_MS = 5_000;
/** A lock whose file is older than this (by its mtime) was left by a writer that died; it may be taken over. */
export const STALE_LOCK_MS = 30_000;

export interface PairingStoreOptions {
  /** {@link LOCK_TIMEOUT_MS} when absent. */
  readonly lockTimeoutMs?: number;
  /** {@link STALE_LOCK_MS} when absent. */
  readonly staleLockMs?: number;
  /** Runs while a write holds the lock, after its re-read and before its rename: for tests to interleave writers. */
  readonly whileLocked?: () => Promise<void>;
  /** Runs once a lock was judged stale, just before it is renamed aside: for tests to interleave takers. */
  readonly beforeTakeover?: () => Promise<void>;
  /** Where a failure the store goes on past is reported (an unreadable file while a key is cached). */
  readonly log?: (message: string, error: unknown) => void;
  /** How lock files are stat'ed and read, for tests to fake what a race leaves (an inode reused by a new lock). */
  readonly lockIo?: {
    readonly stat?: (path: string) => Promise<LockStat>;
    readonly read?: (path: string) => Promise<string>;
  };
}

/** What a lock file's stat says about which lock it is. */
export interface LockStat {
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
}

/** One pairing with a Wirebench Server, as the agent keeps it. */
export interface Pairing {
  readonly pairingId: string;
  /** The server's address, the origin of what the user gave at pairing: where nonces are redeemed. */
  readonly serverUrl: string;
  /** The one `Origin` this pairing's tabs may connect from: the server's public URL, which must be `serverUrl`. */
  readonly origin: string;
  /** The account the pairing belongs to, to show "paired as …". */
  readonly email: string;
  readonly sshOptIn: boolean;
  readonly createdAt: string;
  /** The port the server was last told; absent when it has not heard one it should still use. */
  readonly port?: number;
}

const pairingSchema = z.object({
  pairingId: z.string().min(1),
  serverUrl: z.string().min(1),
  origin: z.string().min(1),
  email: z.string(),
  sshOptIn: z.boolean(),
  createdAt: z.string(),
  port: z.number().int().min(1).max(65_535).optional(),
});

/** A `${#System#…}` name the allowlist may hold: the names a bundle may declare (`sendBundleSchema`). */
export const SYSTEM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const fileFields = {
  agentId: z.string().min(1),
  /** Base64 of what `platform.secrets.encrypt` made of the key's base64 PKCS8 DER. */
  privateKeySealed: z.string().min(1),
  pairings: z.array(pairingSchema),
};

const fileSchema = z.object({
  version: z.literal(2),
  ...fileFields,
  allowedSystemNames: z.array(z.string().max(256).regex(SYSTEM_NAME_PATTERN)),
});
type PairingsFile = z.infer<typeof fileSchema>;

/** The file before the system-name allowlist: it reads as version 2 with an empty one. */
const fileSchemaV1 = z.object({ version: z.literal(1), ...fileFields });

/** The file as this agent reads it, an older version brought up to the current one. */
const anyFileSchema = z.union([
  fileSchema,
  fileSchemaV1.transform((v1): PairingsFile => ({ ...v1, version: 2, allowedSystemNames: [] })),
]);

/** The agent's identity: made once, at the first pairing. */
export interface AgentIdentity {
  readonly agentId: string;
  readonly key: AgentKey;
}

export interface PairingStore {
  /** The identity, making (and saving) it first when there is none yet; made once however many ask at once. */
  identity(): Promise<AgentIdentity>;
  /** Every pairing, oldest first, as of the last read or write. */
  list(): readonly Pairing[];
  get(pairingId: string): Pairing | undefined;
  /**
   * Reads the file again if it changed on disk since the last read or write, so a pairing another process
   * made or removed (`wirebench agent pair` beside a running agent) counts without a restart. Cheap when it
   * has not changed: one `stat`. A file it cannot read throws once per change of the file, and the pairings
   * stay as last read.
   */
  refresh(): Promise<void>;
  /**
   * Adds `pairing`, replacing one with the same id at the same server URL. Throws when that id is already a
   * pairing with another server: a server must not be able to replace another server's pairing by answering
   * its id.
   */
  add(pairing: Pairing): Promise<void>;
  /** Removes the pairing; `false` when there was none. */
  remove(pairingId: string): Promise<boolean>;
  /** Records the port the server now knows for the pairing. */
  setPort(pairingId: string, port: number): Promise<void>;
  /**
   * The `${#System#NAME}` names a bundle send on this machine may read, as of the last read or write; empty
   * by default and before the first pairing. For `wirebench agent` and the desktop's Settings.
   */
  allowedSystemNames(): readonly string[];
  /**
   * Replaces the allowlist (duplicates dropped, order kept). Throws for a name that is not a plain
   * environment variable name, and before the first pairing, when the agent has no file to keep it in.
   */
  setAllowedSystemNames(names: readonly string[]): Promise<void>;
  /**
   * Runs `listener` whenever the pairings may have changed (a write here, or a refresh that read a new file);
   * returns a function that unsubscribes.
   */
  onChange(listener: () => void): () => void;
}

export type PairingPlatform = Pick<HostPlatform, 'paths' | 'secrets'>;

/** A stored row as a {@link Pairing}: a copy, so a caller cannot change the store's own. */
function toPairing(row: PairingsFile['pairings'][number]): Pairing {
  const { port, ...rest } = row;
  return port === undefined ? rest : { ...rest, port };
}

function notAPairingsFile(): Error {
  return new Error(`${PAIRINGS_FILE} is not a pairings file this agent can read`);
}

/** What identifies one version of the file on disk; a rename over it changes the inode. */
type Stamp = string | undefined;

/**
 * Opens the store in `platform.paths.userData()`. A file that is not version 1 or 2 of this shape, or a key
 * the platform cannot unseal, is refused (a throw) rather than replaced: replacing it would drop every pairing
 * without the user asking.
 */
export async function openPairingStore(
  platform: PairingPlatform,
  options: PairingStoreOptions = {},
): Promise<PairingStore> {
  const dir = platform.paths.userData();
  const path = join(dir, PAIRINGS_FILE);
  const lockPath = `${path}.lock`;
  const lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  const staleLockMs = options.staleLockMs ?? STALE_LOCK_MS;
  const statLock = options.lockIo?.stat ?? ((at: string) => stat(at));
  const readLock = options.lockIo?.read ?? ((at: string) => readFile(at, 'utf8'));
  let file: PairingsFile | undefined;
  let identity: AgentIdentity | undefined;
  let stamp: Stamp;
  /** The stamp of the last file a quiet refresh could not read: it is not reported again. */
  let failedStamp: Stamp | null = null;
  const listeners = new Set<() => void>();

  const changed = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A listener's failure is its own; the others still hear of the change.
      }
    }
  };

  const stampNow = async (): Promise<Stamp> => {
    try {
      const info = await stat(path, { bigint: true });
      return `${String(info.ino)}:${String(info.mtimeNs)}:${String(info.size)}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };

  /** Reads the file as it is now; `undefined` when there is none. */
  const read = async (): Promise<PairingsFile | undefined> => {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw notAPairingsFile();
    }
    const parsed = anyFileSchema.safeParse(json);
    if (!parsed.success) throw notAPairingsFile();
    return parsed.data;
  };

  /**
   * Takes `next` as the file, unsealing its key when the identity is new to this store. No file means no
   * identity either: a deleted file starts the install over, and the next pairing makes a new key.
   */
  const adopt = (next: PairingsFile | undefined): void => {
    if (next === undefined) {
      identity = undefined;
    } else if (identity === undefined || identity.agentId !== next.agentId) {
      const pkcs8 = platform.secrets.decrypt(Buffer.from(next.privateKeySealed, 'base64'));
      identity = { agentId: next.agentId, key: agentKeyFromPkcs8(pkcs8) };
    }
    file = next;
  };

  /**
   * Reads the file again when its stamp moved; whether it did. A file it cannot read throws, except that a
   * `quiet` reload throws only once per stamp (a poll every few seconds over a broken file says so once).
   */
  const reload = async (quiet = false): Promise<boolean> => {
    const now = await stampNow();
    if (now === stamp) return false;
    if (quiet && now === failedStamp) return false;
    try {
      adopt(await read());
    } catch (error) {
      failedStamp = now;
      throw error;
    }
    failedStamp = null;
    stamp = now;
    return true;
  };

  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  /**
   * A lock as one taker saw it: its inode, its mtime and its token. A token is a fresh random id per lock, so
   * a new lock that reused a freed inode (ext4 and tmpfs often do) does not pass for the one judged. A lock
   * whose creator died before writing its token is empty, and matches only an empty file of the same mtime.
   */
  interface SeenLock extends LockStat {
    readonly token: string;
  }

  const sameLock = (a: LockStat, b: LockStat): boolean => a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs;

  /** The lock at `at` as it is now; `undefined` when there is none. */
  const see = async (at: string): Promise<SeenLock | undefined> => {
    try {
      const info = await statLock(at);
      const token = await readLock(at);
      return { dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };

  /**
   * Moves the lock at `lockPath` to a unique name, so that what is checked is what is then removed. `keep`
   * says from the moved file whether it is the lock meant; when it is not, it goes back with a `link`, which
   * never replaces a lock someone made meanwhile. Whether the moved file was the one meant.
   */
  const moveAside = async (suffix: string, keep: (moved: SeenLock | undefined) => boolean): Promise<boolean> => {
    const aside = `${lockPath}.${suffix}-${randomUUID()}`;
    try {
      await rename(lockPath, aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    const moved = await see(aside).catch(() => undefined);
    const meant = keep(moved);
    if (!meant) await link(aside, lockPath).catch(() => undefined);
    await unlink(aside).catch(() => undefined);
    return meant;
  };

  /**
   * Moves the lock judged stale (`judged`) out of the way. Renaming is atomic, so of several takers only one
   * moves a given file; one that judged an older file and moved a live lock instead puts it back.
   */
  const takeOver = async (judged: SeenLock): Promise<void> => {
    const now = await statLock(lockPath).catch(() => undefined);
    if (now === undefined || !sameLock(now, judged)) return;
    await options.beforeTakeover?.();
    await moveAside('stale', (moved) => moved !== undefined && sameLock(moved, judged) && moved.token === judged.token);
  };

  /** Takes the cross-process lock, waiting with backoff; throws past `lockTimeoutMs`. */
  const lock = async (): Promise<() => Promise<void>> => {
    await mkdir(dir, { recursive: true });
    const deadline = Date.now() + lockTimeoutMs;
    const token = `${String(process.pid)}:${randomUUID()}`;
    let wait = 10;
    for (;;) {
      try {
        const handle = await open(lockPath, 'wx', 0o600);
        try {
          await handle.writeFile(token, 'utf8');
        } catch (error) {
          await handle.close().catch(() => undefined);
          await unlink(lockPath).catch(() => undefined);
          throw error;
        }
        return async () => {
          try {
            await handle.close();
          } finally {
            // Taken over while it ran past the stale age, the lock there now is its successor's: moved aside
            // first, it is checked and removed as one file, and put back when it is not this holder's.
            await moveAside('release', (moved) => moved?.token === token).catch(() => undefined);
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const held = await see(lockPath).catch(() => undefined);
      if (held !== undefined && Date.now() - held.mtimeMs > staleLockMs) {
        // Its writer died holding it.
        await takeOver(held);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`${PAIRINGS_FILE} is being written by another Wirebench process; try again`);
      }
      await pause(Math.min(wait, Math.max(1, deadline - Date.now())));
      wait = Math.min(wait * 2, 200);
    }
  };

  await reload();

  // One read-modify-write at a time, in the order asked, so a quick add then remove never lands the other
  // way round, and each starts from the file as it is on disk (another process may have written it).
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work);
    queue = run.catch(() => undefined);
    return run;
  };
  /** `work` in turn here, holding the file's lock against other processes, and starting from the file on disk. */
  const locked = <T>(work: () => Promise<T>): Promise<T> =>
    serially(async () => {
      const release = await lock();
      try {
        if (await reload()) changed();
        return await work();
      } finally {
        await release();
      }
    });
  /** Only inside {@link locked}: the stamp is read before the lock goes, so no other write is taken as seen. */
  const write = async (next: PairingsFile): Promise<void> => {
    await options.whileLocked?.();
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
    file = next;
    stamp = await stampNow();
    changed();
  };
  /** Applies `change` to the file as it is on disk now. */
  const modify = (change: (now: PairingsFile) => PairingsFile | undefined): Promise<void> =>
    locked(async () => {
      if (file === undefined) throw new Error('The agent has no identity yet');
      const next = change(file);
      if (next !== undefined) await write(next);
    });

  let making: Promise<AgentIdentity> | undefined;
  const identityOf = async (): Promise<AgentIdentity> => {
    // The file as it is now: a deleted file has no identity, and another process may have made one. A file
    // that cannot be read keeps the identity already known (said once per change of the file).
    try {
      await serially(async () => {
        if (await reload(true)) changed();
      });
    } catch (error) {
      if (identity === undefined) throw error;
      options.log?.('the pairings file could not be read again', error);
    }
    if (identity !== undefined) return identity;
    making ??= locked(async () => {
      // Another process may have paired first, under the lock: its key is the install's key.
      if (identity !== undefined) return identity;
      if (!platform.secrets.available()) {
        throw new Error('This machine cannot keep the agent key secret, so it cannot pair');
      }
      const made: AgentIdentity = { agentId: randomUUID(), key: generateAgentKey() };
      const privateKeySealed = platform.secrets.encrypt(made.key.sealable()).toString('base64');
      await write({ version: 2, agentId: made.agentId, privateKeySealed, allowedSystemNames: [], pairings: [] });
      identity = made;
      return made;
    }).finally(() => {
      making = undefined;
    });
    return making;
  };

  return {
    identity: identityOf,
    list: () => file?.pairings.map(toPairing) ?? [],
    get: (pairingId) => {
      const found = file?.pairings.find((one) => one.pairingId === pairingId);
      return found === undefined ? undefined : toPairing(found);
    },
    refresh: () =>
      serially(async () => {
        if (await reload(true)) changed();
      }),
    add: (pairing) =>
      modify((now) => {
        const held = now.pairings.find((one) => one.pairingId === pairing.pairingId);
        if (held !== undefined && held.serverUrl !== pairing.serverUrl) {
          throw new Error('That pairing id belongs to another server; it was not replaced');
        }
        return {
          ...now,
          pairings: [...now.pairings.filter((one) => one.pairingId !== pairing.pairingId), { ...pairing }],
        };
      }),
    remove: async (pairingId) => {
      let removed = false;
      await locked(async () => {
        if (file === undefined || !file.pairings.some((one) => one.pairingId === pairingId)) return;
        removed = true;
        await write({ ...file, pairings: file.pairings.filter((one) => one.pairingId !== pairingId) });
      });
      return removed;
    },
    setPort: (pairingId, port) =>
      modify((now) =>
        now.pairings.some((one) => one.pairingId === pairingId)
          ? { ...now, pairings: now.pairings.map((one) => (one.pairingId === pairingId ? { ...one, port } : one)) }
          : undefined,
      ),
    allowedSystemNames: () => [...(file?.allowedSystemNames ?? [])],
    setAllowedSystemNames: (names) => {
      const bad = names.find((name) => name.length > 256 || !SYSTEM_NAME_PATTERN.test(name));
      if (bad !== undefined) return Promise.reject(new Error(`${bad} is not an environment variable name`));
      const allowed = [...new Set(names)];
      return modify((now) => ({ ...now, allowedSystemNames: allowed }));
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
