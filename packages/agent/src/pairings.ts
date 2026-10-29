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
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
  /** The identity, making (and saving) it first when there is none yet. */
  identity(): Promise<AgentIdentity>;
  /** Every pairing, oldest first. */
  list(): readonly Pairing[];
  get(pairingId: string): Pairing | undefined;
  /** Adds `pairing`, replacing one with the same id. */
  add(pairing: Pairing): Promise<void>;
  /** Removes the pairing; `false` when there was none. */
  remove(pairingId: string): Promise<boolean>;
  /** Records the port the server now knows for the pairing. */
  setPort(pairingId: string, port: number): Promise<void>;
}

export type PairingPlatform = Pick<HostPlatform, 'paths' | 'secrets'>;

/** A stored row as a {@link Pairing}: a copy, so a caller cannot change the store's own. */
function toPairing(row: PairingsFile['pairings'][number]): Pairing {
  const { port, ...rest } = row;
  return port === undefined ? rest : { ...rest, port };
}

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

  let text: string | undefined;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (text !== undefined) {
    const parsed = fileSchema.safeParse(JSON.parse(text) as unknown);
    if (!parsed.success) throw new Error(`${PAIRINGS_FILE} is not a pairings file this agent can read`);
    file = parsed.data;
    const pkcs8 = platform.secrets.decrypt(Buffer.from(file.privateKeySealed, 'base64'));
    identity = { agentId: file.agentId, key: agentKeyFromPkcs8(pkcs8) };
  }

  // One write at a time, in the order asked, so a quick add then remove never lands the other way round.
  let writes: Promise<void> = Promise.resolve();
  const save = (next: PairingsFile): Promise<void> => {
    file = next;
    const body = `${JSON.stringify(next, null, 2)}\n`;
    const write = writes.then(async () => {
      await mkdir(dir, { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
    });
    writes = write.catch(() => undefined);
    return write;
  };
  const current = (): PairingsFile => {
    if (file === undefined) throw new Error('The agent has no identity yet');
    return file;
  };

  return {
    identity: async () => {
      if (identity !== undefined) return identity;
      if (!platform.secrets.available()) {
        throw new Error('This machine cannot keep the agent key secret, so it cannot pair');
      }
      const made: AgentIdentity = { agentId: randomUUID(), key: generateAgentKey() };
      const privateKeySealed = platform.secrets.encrypt(made.key.sealable()).toString('base64');
      await save({ version: 1, agentId: made.agentId, privateKeySealed, pairings: [] });
      identity = made;
      return made;
    },
    list: () => file?.pairings.map(toPairing) ?? [],
    get: (pairingId) => {
      const found = file?.pairings.find((one) => one.pairingId === pairingId);
      return found === undefined ? undefined : toPairing(found);
    },
    add: (pairing) => {
      const now = current();
      return save({
        ...now,
        pairings: [...now.pairings.filter((one) => one.pairingId !== pairing.pairingId), { ...pairing }],
      });
    },
    remove: async (pairingId) => {
      if (file === undefined || !file.pairings.some((one) => one.pairingId === pairingId)) return false;
      await save({ ...file, pairings: file.pairings.filter((one) => one.pairingId !== pairingId) });
      return true;
    },
    setPort: async (pairingId, port) => {
      const now = current();
      if (!now.pairings.some((one) => one.pairingId === pairingId)) return;
      await save({
        ...now,
        pairings: now.pairings.map((one) => (one.pairingId === pairingId ? { ...one, port } : one)),
      });
    },
  };
}
