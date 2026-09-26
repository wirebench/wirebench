/**
 * The access log (§2, §3.7): `access/<ulid>.yaml` entries replayed in ULID order give the approved keys
 * and the admins. With `authority: signed` (git and folder shares) an entry counts only when an admin at
 * that point of the replay signed it; with `authority: server` any approved key's signature counts, and
 * the server refuses a non-admin's push to `access/` (§5.1). Invalid entries are skipped and listed.
 */
import { decodeTime, ulid } from 'ulidx';
import { fingerprintOf, keyIdOf } from './keys.js';
import type { AccessEntryFile, KeyRequestFile } from './schema.js';
import { verifyDocument } from './sign.js';

/** A key request that proved possession of its keys. */
export interface KeyInfo {
  readonly keyId: string;
  readonly encryptionKey: string;
  readonly signingKey: string;
  readonly name: string;
  readonly email: string;
  readonly machine: string;
  readonly requestedAt: string;
  readonly fingerprint: string;
}

export interface Removal {
  readonly keyId: string;
  readonly at: string;
  readonly by: string;
  readonly entryId: string;
}

export type LogProblem =
  | 'unknown-signer'
  | 'bad-signature'
  | 'second-genesis'
  | 'no-genesis'
  | 'not-allowed'
  | 'unknown-key'
  | 'already-approved'
  | 'removed-key'
  | 'not-approved'
  | 'last-admin'
  | 'wrong-authority';

export interface AccessState {
  /** A valid genesis was replayed. */
  readonly on: boolean;
  readonly authority?: 'signed' | 'server';
  readonly genesisId?: string;
  readonly keys: ReadonlyMap<string, KeyInfo>;
  readonly approved: ReadonlySet<string>;
  /** Always empty with `authority: server`. */
  readonly admins: ReadonlySet<string>;
  readonly removed: readonly Removal[];
  readonly problems: readonly { readonly id: string; readonly problem: LogProblem }[];
}

/** The key requests whose id matches their keys and whose self-signature verifies, by key id. */
export function verifiedKeys(files: readonly KeyRequestFile[]): Map<string, KeyInfo> {
  const keys = new Map<string, KeyInfo>();
  for (const file of files) {
    if (keyIdOf(file) !== file.keyId || !verifyDocument(file, file.signingKey)) {
      continue;
    }
    keys.set(file.keyId, {
      keyId: file.keyId,
      encryptionKey: file.encryptionKey,
      signingKey: file.signingKey,
      name: file.name,
      email: file.email,
      machine: file.machine,
      requestedAt: file.requestedAt,
      fingerprint: fingerprintOf(file),
    });
  }
  return keys;
}

/**
 * The id for a new access entry: a ULID for `now`, or just after the newest existing one when this
 * machine's clock is behind it, so the entry always replays after what its writer saw (§15 clock skew).
 */
export function nextAccessEntryId(existing: readonly string[], now: number): string {
  const last = existing.reduce<string | undefined>((max, id) => (max === undefined || id > max ? id : max), undefined);
  return ulid(last === undefined ? now : Math.max(now, decodeTime(last) + 1));
}

/**
 * Replays `entries` in ULID order. `genesisId`, when given, is the only entry allowed to be the genesis
 * (plan decision 4); without it the first valid genesis wins.
 */
export function replayAccessLog(
  keys: ReadonlyMap<string, KeyInfo>,
  entries: readonly AccessEntryFile[],
  options: { readonly genesisId?: string } = {},
): AccessState {
  const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let authority: 'signed' | 'server' | undefined;
  let genesisId: string | undefined;
  const approved = new Set<string>();
  const admins = new Set<string>();
  const removedKeys = new Set<string>();
  const removed: Removal[] = [];
  const problems: { id: string; problem: LogProblem }[] = [];

  for (const entry of sorted) {
    const reject = (problem: LogProblem): void => {
      problems.push({ id: entry.id, problem });
    };
    const signer = keys.get(entry.by);
    if (signer === undefined) {
      reject('unknown-signer');
      continue;
    }
    if (!verifyDocument(entry, signer.signingKey)) {
      reject('bad-signature');
      continue;
    }
    if (entry.action === 'genesis') {
      if (authority !== undefined || (options.genesisId !== undefined && options.genesisId !== entry.id)) {
        reject('second-genesis');
        continue;
      }
      if (entry.key !== entry.by || entry.authority === undefined) {
        reject('not-allowed');
        continue;
      }
      authority = entry.authority;
      genesisId = entry.id;
      approved.add(entry.key);
      if (authority === 'signed') {
        admins.add(entry.key);
      }
      continue;
    }
    if (authority === undefined) {
      reject('no-genesis');
      continue;
    }
    const mayManage = authority === 'signed' ? admins.has(entry.by) : approved.has(entry.by);
    if (!mayManage) {
      reject('not-allowed');
      continue;
    }
    if (!keys.has(entry.key)) {
      reject('unknown-key');
      continue;
    }
    switch (entry.action) {
      case 'approve':
        if (removedKeys.has(entry.key)) {
          reject('removed-key');
        } else if (approved.has(entry.key)) {
          reject('already-approved');
        } else {
          approved.add(entry.key);
        }
        break;
      case 'remove':
        if (!approved.has(entry.key)) {
          reject('not-approved');
        } else if (authority === 'signed' && admins.has(entry.key) && admins.size === 1) {
          reject('last-admin');
        } else {
          approved.delete(entry.key);
          admins.delete(entry.key);
          removedKeys.add(entry.key);
          removed.push({ keyId: entry.key, at: entry.at, by: entry.by, entryId: entry.id });
        }
        break;
      case 'grant-admin':
        if (authority !== 'signed') {
          reject('wrong-authority');
        } else if (!approved.has(entry.key)) {
          reject('not-approved');
        } else {
          admins.add(entry.key);
        }
        break;
      case 'revoke-admin':
        if (authority !== 'signed') {
          reject('wrong-authority');
        } else if (!admins.has(entry.key)) {
          reject('not-approved');
        } else if (admins.size === 1) {
          reject('last-admin');
        } else {
          admins.delete(entry.key);
        }
        break;
    }
  }

  return {
    on: authority !== undefined,
    ...(authority !== undefined ? { authority } : {}),
    ...(genesisId !== undefined ? { genesisId } : {}),
    keys,
    approved,
    admins,
    removed,
    problems,
  };
}
