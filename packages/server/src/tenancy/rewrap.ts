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
 * such a jar aside, and the step must not. Each file is written once, after all its blobs, and durably
 * ({@link writeFileDurably}): once `rewrap` returns, every file it re-sealed is on disk under its new key, so the step
 * may record `done`, after which the old key opens nothing any more (Task 24 review I1).
 *
 * A link, or anything other than a regular file or directory, where a user's directory or a blob file is expected
 * is never followed, and is counted as `skipped`: the host does follow such a link, and would set aside what it
 * finds there, so the count is how an operator learns of it (review m1).
 *
 * `direction` serves both ways: `forward` from the root's key to the data key's, `back` the reverse for the revert
 * (plan Task 28). Nothing here logs, and the counts name no file and no value.
 */
import { randomBytes } from 'node:crypto';
import { lstat, open as openFile, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { open, seal } from '../hooks/secret-box.js';
import { userSecretsKey } from '../host/server-platform.js';
import { renameWithRetry } from './rename.js';

export type RewrapDirection = 'forward' | 'back';

/** Which run a forward re-wrap is: the keys step's, or the check at `done` (`file-step.ts`). */
export type RewrapRun = 'step' | 'check';

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
  /** Blobs that opened under neither key, and files or entries that did not parse: left as they were. */
  readonly unopened: number;
  /** Links and other entries that are not a regular file or directory where one was expected: not followed. */
  readonly skipped: number;
  /** Files written. */
  readonly files: number;
}

export interface RewrapOptions {
  /** Counts only; writes nothing (`admin tenancy status`). */
  readonly dryRun?: boolean;
  /** A test seam: called after each file is written, so a test can stop the run there. */
  readonly checkpoint?: (file: string) => void;
  /** A test seam: the file system calls of {@link writeFileDurably}. */
  readonly fs?: DurableFs;
}

/** The file system calls {@link writeFileDurably} makes; a seam for its tests. */
export interface DurableFs {
  stat(path: string): Promise<{ readonly mode: number }>;
  open(path: string, flags: string, mode?: number): Promise<DurableHandle>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { readonly force: true }): Promise<void>;
  readonly platform: NodeJS.Platform;
}

export interface DurableHandle {
  chmod(mode: number): Promise<void>;
  writeFile(data: string, encoding: 'utf8'): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

const nodeDurableFs: DurableFs = {
  stat: (path) => stat(path),
  open: (path, flags, mode) => openFile(path, flags, mode),
  rename: (from, to) => rename(from, to),
  rm: (path, options) => rm(path, options),
  platform: process.platform,
};

/** What a file system says when it cannot fsync a directory at all: nothing to make durable that way. */
const DIR_SYNC_UNSUPPORTED: ReadonlySet<string> = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR']);

const codeOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';

/**
 * Replaces the regular file `path` with `text`, durably (Task 24 review I1, m5):
 *
 * 1. a temporary file beside it, made exclusively (`wx`) and given the original's mode, so a `secrets.json` an
 *    operator made `0600` stays `0600` whatever the umask;
 * 2. the text written, the file fsynced, and closed;
 * 3. renamed over `path`, retried as `rename.ts` does while Windows holds the target for a moment;
 * 4. the directory fsynced, so the rename itself survives a power loss. Windows cannot open a directory to fsync it,
 *    and NTFS journals the rename, so there this step is skipped; so it is on a file system that refuses a
 *    directory fsync as unsupported (`EINVAL`, `ENOTSUP`). Any other failure, `EIO` above all, is thrown.
 *
 * On a failure before the rename the temporary file is removed and `path` is as it was. `rewrap` and the revert's
 * `back` (plan Task 28) both write through it.
 */
export async function writeFileDurably(path: string, text: string, fs: DurableFs = nodeDurableFs): Promise<void> {
  const { mode } = await fs.stat(path);
  const dir = dirname(path);
  // Named so the host and the re-wrap both pass it over: not a jar name, and not `secrets.json`.
  const temp = join(dir, `${basename(path)}.tmp-${randomBytes(6).toString('hex')}`);
  const handle = await fs.open(temp, 'wx', mode & 0o777);
  try {
    try {
      await handle.chmod(mode & 0o777);
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temp, path, { rename: (from, to) => fs.rename(from, to) });
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  if (fs.platform === 'win32') return;
  const directory = await fs.open(dir, 'r');
  try {
    await directory.sync();
  } catch (error) {
    if (!DIR_SYNC_UNSUPPORTED.has(codeOf(error))) throw error;
  } finally {
    await directory.close();
  }
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
  skipped: number;
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
 * The entries of a `secrets.json`, version 2 (`encrypted` per entry) or 1 (one `encrypted` for the file), checked
 * for the file's shape only, as the host's `parseSecretsFile` does; `undefined` when it is neither. Each entry is
 * checked on its own as it is re-sealed, so one malformed entry stops no other (review m2).
 */
function secretEntries(document: unknown): { entries: Record<string, unknown>; v1Encrypted?: boolean } | undefined {
  if (!isRecord(document) || !isRecord(document['entries'])) return undefined;
  const entries = document['entries'];
  if (document['version'] === 2) return { entries };
  if (document['version'] === 1 && typeof document['encrypted'] === 'boolean') {
    return { entries, v1Encrypted: document['encrypted'] };
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
  const tally: Tally = { resealed: 0, already: 0, unopened: 0, skipped: 0, files: 0 };
  if ((await kindOf(checkouts)) !== 'dir') return { ...tally };
  const count = (outcome: Outcome | 'skipped'): void => {
    tally[outcome]++;
  };
  /** Whether `path` is the `want` it should be; anything else there (a link, say) is counted as skipped. */
  const is = async (path: string, want: 'file' | 'dir'): Promise<boolean> => {
    const kind = await kindOf(path);
    if (kind !== want && kind !== 'absent') count('skipped');
    return kind === want;
  };
  const write = async (path: string, text: string): Promise<void> => {
    if (options.dryRun === true) return;
    await writeFileDurably(path, text, options.fs);
    tally.files++;
    options.checkpoint?.(path);
  };

  for (const user of (await readdir(checkouts)).sort()) {
    if (!USER_ID.test(user)) continue;
    const home = join(checkouts, user);
    if (!(await is(home, 'dir'))) continue;
    const oldKey = userSecretsKey(keys.root, user);
    const newKey = userSecretsKey(keys.dataKey, user);
    const [from, to] = direction === 'forward' ? [oldKey, newKey] : [newKey, oldKey];

    const secretsPath = join(home, SECRETS_FILE);
    if (await is(secretsPath, 'file')) {
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
          // A malformed entry is left as it is, and counted: it may have held a sealed value.
          if (!isRecord(entry)) {
            count('unopened');
            continue;
          }
          const encrypted = found.v1Encrypted ?? entry['encrypted'];
          if (encrypted !== true) continue;
          if (typeof entry['value'] !== 'string') {
            count('unopened');
            continue;
          }
          const result = reseal(entry['value'], from, to);
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
    if (!(await is(jars, 'dir'))) continue;
    for (const name of (await readdir(jars)).sort()) {
      if (!JAR_FILE.test(name)) continue;
      const path = join(jars, name);
      if (!(await is(path, 'file'))) continue;
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
