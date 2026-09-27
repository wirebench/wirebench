/**
 * Vault entries (§2, §3.3–§3.6): build one for the approved keys, verify it against the replayed log,
 * open it with this machine's key, seal it again with a fresh data key (removal, late re-encryption), heal
 * it with wraps for keys approved since, and say which values a removed key could read. Pure.
 *
 * Wrapping a data key for a recipient can fail with `team-secrets-bad-key` (a malformed or low-order
 * key, e.g. from a corrupted key request that still passed schema validation). One bad recipient must
 * never stop the others: it is skipped, and its absence from `wraps` is the only report a caller needs —
 * a recipient that was supposed to be able to read the value but has no wrap for it simply cannot.
 */
import { decryptValue, encryptValue, newDataKey, unwrapDataKey, wrapDataKey } from './envelope.js';
import { WirebenchError } from '../errors.js';
import type { MachineKeys } from './keys.js';
import type { AccessState, KeyInfo } from './log.js';
import { vaultEntryId, type SecretKey, type VaultEntryFile } from './schema.js';
import { signDocument, verifyDocument, withoutSignature } from './sign.js';

type VaultBody = Omit<VaultEntryFile, 'signature'>;

/** `wrapDataKey(dataKey, recipient.encryptionKey)`, or `undefined` for a recipient whose key is bad. */
function tryWrap(dataKey: Buffer, recipient: KeyInfo): string | undefined {
  try {
    return wrapDataKey(dataKey, recipient.encryptionKey);
  } catch (error) {
    if (error instanceof WirebenchError && error.code === 'team-secrets-bad-key') {
      return undefined;
    }
    throw error;
  }
}

function seal(
  body: { readonly secret: SecretKey; readonly label: string; readonly updatedAt: string },
  value: string,
  recipients: readonly KeyInfo[],
  signer: MachineKeys,
): VaultEntryFile {
  const dataKey = newDataKey();
  const wraps: Record<string, string> = {};
  for (const recipient of recipients) {
    const wrap = tryWrap(dataKey, recipient);
    if (wrap !== undefined) {
      wraps[recipient.keyId] = wrap;
    }
  }
  return signDocument(
    {
      version: 1 as const,
      secret: body.secret,
      label: body.label,
      cipher: encryptValue(value, dataKey, vaultEntryId(body.secret)),
      wraps,
      updatedAt: body.updatedAt,
      updatedBy: signer.keyId,
    },
    signer,
  );
}

/** A new value (§3.3): fresh data key, wrapped for `recipients`, signed by `signer`, dated `at`. */
export function buildVaultEntry(input: {
  readonly secret: SecretKey;
  readonly label: string;
  readonly value: string;
  readonly recipients: readonly KeyInfo[];
  readonly signer: MachineKeys;
  readonly at: string;
}): VaultEntryFile {
  return seal(
    { secret: input.secret, label: input.label, updatedAt: input.at },
    input.value,
    input.recipients,
    input.signer,
  );
}

/** The same value under a fresh data key for `recipients` only (§3.6); the value time is kept. */
export function sealVaultEntry(
  entry: VaultEntryFile,
  value: string,
  recipients: readonly KeyInfo[],
  signer: MachineKeys,
): VaultEntryFile {
  return seal(entry, value, recipients, signer);
}

/** Every approved key the log has a verified request for. */
export function approvedRecipients(state: AccessState): KeyInfo[] {
  return [...state.approved].flatMap((keyId) => {
    const info = state.keys.get(keyId);
    return info === undefined ? [] : [info];
  });
}

export type VaultVerdict = 'trusted' | 'wrong-id' | 'not-approved' | 'bad-signature';

/** §6: trusted only when it sits under its own id and an approved key signed it. */
export function verifyVaultEntry(entry: VaultEntryFile, fileId: string, state: AccessState): VaultVerdict {
  if (vaultEntryId(entry.secret) !== fileId) {
    return 'wrong-id';
  }
  if (!state.approved.has(entry.updatedBy)) {
    return 'not-approved';
  }
  const signer = state.keys.get(entry.updatedBy);
  return signer !== undefined && verifyDocument(entry, signer.signingKey) ? 'trusted' : 'bad-signature';
}

/** The value, when `entry` is wrapped for `me` and opens; `undefined` otherwise. */
export function openVaultEntry(entry: VaultEntryFile, me: MachineKeys): string | undefined {
  const wrap = entry.wraps[me.keyId];
  if (wrap === undefined) {
    return undefined;
  }
  try {
    return decryptValue(entry.cipher, unwrapDataKey(wrap, me), vaultEntryId(entry.secret));
  } catch {
    return undefined;
  }
}

/**
 * §3.4 healing: `entry` with a wrap added for each approved key it lacks, under the same data key, re-signed
 * by `me`. `undefined` when nothing is missing or `me` cannot open the data key. Never removes a wrap.
 * Callers heal trusted entries only.
 */
export function healVaultEntry(entry: VaultEntryFile, state: AccessState, me: MachineKeys): VaultEntryFile | undefined {
  const missing = approvedRecipients(state).filter((recipient) => entry.wraps[recipient.keyId] === undefined);
  const mine = entry.wraps[me.keyId];
  if (missing.length === 0 || mine === undefined) {
    return undefined;
  }
  let dataKey: Buffer;
  try {
    dataKey = unwrapDataKey(mine, me);
  } catch {
    return undefined;
  }
  const wraps: Record<string, string> = { ...entry.wraps };
  for (const recipient of missing) {
    const wrap = tryWrap(dataKey, recipient);
    if (wrap !== undefined) {
      wraps[recipient.keyId] = wrap;
    }
  }
  return signDocument({ ...(withoutSignature(entry) as VaultBody), wraps, updatedBy: me.keyId }, me);
}

/** Plan decision 6: the entry still carries a wrap for a key the log no longer approves. */
export function wrapsUnapprovedKey(entry: VaultEntryFile, state: AccessState): boolean {
  return Object.keys(entry.wraps).some((keyId) => !state.approved.has(keyId));
}

export interface RotateMark {
  readonly entryId: string;
  readonly label: string;
  readonly secret: SecretKey;
  /** The names on the removed keys that could read this value. */
  readonly removedNames: string[];
}

/**
 * §3.6: a value set before a removal was readable by the removed key (plan decision 5), so it is marked
 * until it changes. Pass trusted entries only, keyed by id.
 */
export function rotateMarks(values: ReadonlyMap<string, VaultEntryFile>, state: AccessState): RotateMark[] {
  const marks: RotateMark[] = [];
  for (const [entryId, entry] of values) {
    const setAt = Date.parse(entry.updatedAt);
    const names = state.removed
      .filter((removal) => setAt < Date.parse(removal.at))
      .map((removal) => state.keys.get(removal.keyId)?.name ?? removal.keyId);
    if (names.length > 0) {
      marks.push({ entryId, label: entry.label, secret: entry.secret, removedNames: [...new Set(names)] });
    }
  }
  return marks;
}
