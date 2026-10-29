/**
 * The agent's pairings and key, in `userData/agent-pairings.json` (hosted edition spec §18.2):
 *
 * `{ version: 1, agentId, privateKeySealed, pairings: [{ pairingId, serverUrl, origin, email, sshOptIn,
 * createdAt, port? }] }`
 *
 * The private key is sealed by the platform's secret store (`safeStorage` on the desktop, the headless
 * agent's own key file) before it touches the disk; nothing else in the file is a secret. The agent id and
 * the key are made at the first pairing, so an install that never pairs writes nothing. Every write goes to a
 * temporary file renamed over the old one, so a crash leaves the old file or the new, never half of one.
 *
 * The desktop's agent and a `wirebench agent pair` may write the file at the same time, so every write
 * (identity creation included) holds `agent-pairings.json.lock`, made with `O_EXCL`, across its re-read, its
 * change, the rename and the stamp read. A lock older than {@link STALE_LOCK_MS} is a crashed writer's and
 * is taken over.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
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
}

/** One pairing with a Wirebench Server, as the agent keeps it. */
export interface Pairing {
  readonly pairingId: string;
  /** The server's URL, as the user gave it at pairing: where nonces are redeemed. */
  readonly serverUrl: string;
  /** The one `Origin` this pairing's tabs may connect from (the server's public URL, from its answer). */
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

const fileSchema = z.object({
  version: z.literal(1),
  agentId: z.string().min(1),
  /** Base64 of what `platform.secrets.encrypt` made of the key's base64 PKCS8 DER. */
  privateKeySealed: z.string().min(1),
  pairings: z.array(pairingSchema),
});
type PairingsFile = z.infer<typeof fileSchema>;

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
  /** Adds `pairing`, replacing one with the same id. */
  add(pairing: Pairing): Promise<void>;
  /** Removes the pairing; `false` when there was none. */
  remove(pairingId: string): Promise<boolean>;
  /** Records the port the server now knows for the pairing. */
  setPort(pairingId: string, port: number): Promise<void>;
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
 * Opens the store in `platform.paths.userData()`. A file that is not version 1 of this shape, or a key the
 * platform cannot unseal, is refused (a throw) rather than replaced: replacing it would drop every pairing
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
    const parsed = fileSchema.safeParse(json);
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

  /** Takes the cross-process lock, waiting with backoff; throws past `lockTimeoutMs`. */
  const lock = async (): Promise<() => Promise<void>> => {
    await mkdir(dir, { recursive: true });
    const deadline = Date.now() + lockTimeoutMs;
    let wait = 10;
    for (;;) {
      try {
        const handle = await open(lockPath, 'wx', 0o600);
        return async () => {
          await handle.close();
          await unlink(lockPath).catch(() => undefined);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const held = await stat(lockPath).catch(() => undefined);
      if (held !== undefined && Date.now() - held.mtimeMs > staleLockMs) {
        // Its writer died holding it. Only one taker's `wx` open wins after the unlink.
        await unlink(lockPath).catch(() => undefined);
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
    // The file as it is now: a deleted file has no identity, and another process may have made one.
    await serially(async () => {
      if (await reload()) changed();
    });
    if (identity !== undefined) return identity;
    making ??= locked(async () => {
      // Another process may have paired first, under the lock: its key is the install's key.
      if (identity !== undefined) return identity;
      if (!platform.secrets.available()) {
        throw new Error('This machine cannot keep the agent key secret, so it cannot pair');
      }
      const made: AgentIdentity = { agentId: randomUUID(), key: generateAgentKey() };
      const privateKeySealed = platform.secrets.encrypt(made.key.sealable()).toString('base64');
      await write({ version: 1, agentId: made.agentId, privateKeySealed, pairings: [] });
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
      modify((now) => ({
        ...now,
        pairings: [...now.pairings.filter((one) => one.pairingId !== pairing.pairingId), { ...pairing }],
      })),
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
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
