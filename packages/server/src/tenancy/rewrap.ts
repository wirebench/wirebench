/**
 * The one-time re-wrap (hosted edition spec §19.7, §19.10, ADR-0036): every blob a server host sealed before slice 4
 * is under slice 2's user key, `userSecretsKey(root, userId)`; the keys step re-seals it under the one derived from
 * the tenant's data key, `userSecretsKey(dataKey, userId)`. Two kinds of blob, in each user's checkout:
 *
 * - the `encrypted: true` entries of `secrets.json` (a plaintext entry, written without secure storage, is left);
 * - the `data` of each `cookie-jars/<id>.json`.
 *
 * A blob is tried under the target key first. One that opens there is done, so a run repeated (the step re-arms) or
 * resumed after a kill never seals twice. One that opens under the source key is re-sealed. One that opens under
 * neither, or a file that does not parse, is left exactly as it is and counted: the host's cookie store would set
 * such a jar aside, and the step must not. Each file is written atomically, once, after all its blobs.
 *
 * `direction` serves both ways: `forward` from the root's key to the data key's, `back` the reverse for the revert
 * (plan Task 28). Nothing here logs, and the counts name no file and no value.
 */
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nodeFs, writeFileAtomic } from '@wirebench/engine';
import { open, seal } from '../hooks/secret-box.js';
import { userSecretsKey } from '../host/server-platform.js';

export type RewrapDirection = 'forward' | 'back';

/** The two roots of the user keys: slice 2's server root, and the tenant's data key. */
export interface RewrapKeys {
  readonly root: Buffer;
  readonly dataKey: Buffer;
}

export interface RewrapCounts {
  /** Blobs re-sealed under the target key (in a dry run: that would be). */
  readonly resealed: number;
  /** Blobs already under the target key. */
  readonly already: number;
  /** Blobs that opened under neither key, and files that did not parse: left as they were. */
  readonly unopened: number;
  /** Files written. */
  readonly files: number;
}

export interface RewrapOptions {
  /** Counts only; writes nothing (`admin tenancy status`). */
  readonly dryRun?: boolean;
  /** A test seam: called after each file is written, so a test can stop the run there. */
  readonly checkpoint?: (file: string) => void;
}

/** A user id is one path segment (a ULID); any other directory under `checkouts/` is not a host's. */
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SECRETS_FILE = 'secrets.json';
const COOKIES_DIR = 'cookie-jars';
/** The jar files the host writes; its `.corrupt` and temporary files are not. */
const JAR_FILE = /^[A-Za-z0-9_-]+\.json$/;

type Outcome = 'resealed' | 'already' | 'unopened';

interface Tally {
  resealed: number;
  already: number;
  unopened: number;
  files: number;
}

/** A regular file or directory itself, never through a link. */
async function kindOf(path: string): Promise<'file' | 'dir' | 'other' | 'absent'> {
  try {
    const stat = await lstat(path);
    if (stat.isFile()) return 'file';
    if (stat.isDirectory()) return 'dir';
    return 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
}

const opens = (key: Buffer, sealed: Buffer): string | undefined => {
  try {
    return open(key, sealed);
  } catch {
    return undefined;
  }
};

/** Re-seals one base64 blob: the new base64 when it was under `from`, else `undefined`, with what it was. */
function reseal(blob: string, from: Buffer, to: Buffer): { readonly outcome: Outcome; readonly value?: string } {
  const sealed = Buffer.from(blob, 'base64');
  if (opens(to, sealed) !== undefined) return { outcome: 'already' };
  const plain = opens(from, sealed);
  if (plain === undefined) return { outcome: 'unopened' };
  return { outcome: 'resealed', value: seal(to, plain).toString('base64') };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The entries of a `secrets.json`, version 2 (`encrypted` per entry) or 1 (one `encrypted` for the file), as the
 * host reads them; `undefined` when it is neither.
 */
function secretEntries(
  document: unknown,
): { entries: Record<string, Record<string, unknown>>; v1Encrypted?: boolean } | undefined {
  if (!isRecord(document) || !isRecord(document['entries'])) return undefined;
  const entries = document['entries'];
  if (!Object.values(entries).every((entry) => isRecord(entry) && typeof entry['value'] === 'string')) return undefined;
  if (document['version'] === 2) return { entries: entries as Record<string, Record<string, unknown>> };
  if (document['version'] === 1 && typeof document['encrypted'] === 'boolean') {
    return { entries: entries as Record<string, Record<string, unknown>>, v1Encrypted: document['encrypted'] };
  }
  return undefined;
}

/**
 * Re-wraps every user's blobs under `checkouts` (a tenant's `checkouts/` directory).
 *
 * @throws the file system's errors other than a missing file; a run that throws resumes on the next call.
 */
export async function rewrap(
  checkouts: string,
  keys: RewrapKeys,
  direction: RewrapDirection,
  options: RewrapOptions = {},
): Promise<RewrapCounts> {
  const tally: Tally = { resealed: 0, already: 0, unopened: 0, files: 0 };
  if ((await kindOf(checkouts)) !== 'dir') return { ...tally };
  const count = (outcome: Outcome): void => {
    tally[outcome]++;
  };
  const write = async (path: string, text: string): Promise<void> => {
    if (options.dryRun === true) return;
    await writeFileAtomic(nodeFs, path, text);
    tally.files++;
    options.checkpoint?.(path);
  };

  for (const user of (await readdir(checkouts)).sort()) {
    if (!USER_ID.test(user)) continue;
    const home = join(checkouts, user);
    if ((await kindOf(home)) !== 'dir') continue;
    const oldKey = userSecretsKey(keys.root, user);
    const newKey = userSecretsKey(keys.dataKey, user);
    const [from, to] = direction === 'forward' ? [oldKey, newKey] : [newKey, oldKey];

    const secretsPath = join(home, SECRETS_FILE);
    if ((await kindOf(secretsPath)) === 'file') {
      const text = await readFile(secretsPath, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const found = secretEntries(parsed);
      if (found === undefined) {
        count('unopened');
      } else {
        let changed = false;
        for (const entry of Object.values(found.entries)) {
          const encrypted = found.v1Encrypted ?? entry['encrypted'];
          if (encrypted !== true) continue;
          const result = reseal(entry['value'] as string, from, to);
          count(result.outcome);
          if (result.value !== undefined) {
            entry['value'] = result.value;
            changed = true;
          }
        }
        if (changed) await write(secretsPath, JSON.stringify(parsed, null, 2));
      }
    }

    const jars = join(home, COOKIES_DIR);
    if ((await kindOf(jars)) !== 'dir') continue;
    for (const name of (await readdir(jars)).sort()) {
      if (!JAR_FILE.test(name)) continue;
      const path = join(jars, name);
      if ((await kindOf(path)) !== 'file') continue;
      let file: unknown;
      try {
        file = JSON.parse(await readFile(path, 'utf8'));
      } catch {
        file = undefined;
      }
      if (!isRecord(file) || file['version'] !== 1 || typeof file['data'] !== 'string') {
        count('unopened');
        continue;
      }
      const result = reseal(file['data'], from, to);
      count(result.outcome);
      if (result.value !== undefined) await write(path, JSON.stringify({ ...file, data: result.value }));
    }
  }
  return { ...tally };
}
