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
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { HostPlatform } from '@wirebench/host';
import { agentKeyFromPkcs8, generateAgentKey, type AgentKey } from './keys.js';

export const PAIRINGS_FILE = 'agent-pairings.json';

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
   * has not changed: one `stat`.
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
export async function openPairingStore(platform: PairingPlatform): Promise<PairingStore> {
  const dir = platform.paths.userData();
  const path = join(dir, PAIRINGS_FILE);
  let file: PairingsFile | undefined;
  let identity: AgentIdentity | undefined;
  let stamp: Stamp;
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

  /** Takes `next` as the file, unsealing its key when the identity is new to this store. */
  const adopt = (next: PairingsFile | undefined): void => {
    if (next !== undefined && (identity === undefined || identity.agentId !== next.agentId)) {
      const pkcs8 = platform.secrets.decrypt(Buffer.from(next.privateKeySealed, 'base64'));
      identity = { agentId: next.agentId, key: agentKeyFromPkcs8(pkcs8) };
    }
    file = next;
  };

  /** Reads the file again when its stamp moved; whether it did. */
  const reload = async (): Promise<boolean> => {
    const now = await stampNow();
    if (now === stamp) return false;
    adopt(await read());
    stamp = now;
    return true;
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
  const write = async (next: PairingsFile): Promise<void> => {
    await mkdir(dir, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
    file = next;
    stamp = await stampNow();
    changed();
  };
  /** Applies `change` to the file as it is on disk now. */
  const modify = (change: (now: PairingsFile) => PairingsFile | undefined): Promise<void> =>
    serially(async () => {
      if (await reload()) changed();
      if (file === undefined) throw new Error('The agent has no identity yet');
      const next = change(file);
      if (next !== undefined) await write(next);
    });

  let making: Promise<AgentIdentity> | undefined;
  const identityOf = (): Promise<AgentIdentity> => {
    if (identity !== undefined) return Promise.resolve(identity);
    making ??= serially(async () => {
      // Another process may have paired first: its key is the install's key.
      if (await reload()) changed();
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
        if (await reload()) changed();
      }),
    add: (pairing) =>
      modify((now) => ({
        ...now,
        pairings: [...now.pairings.filter((one) => one.pairingId !== pairing.pairingId), { ...pairing }],
      })),
    remove: async (pairingId) => {
      let removed = false;
      await serially(async () => {
        if (await reload()) changed();
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
