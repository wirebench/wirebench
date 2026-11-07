/**
 * The stored secrets key: a server that is not given `WIREBENCH_SERVER_SECRETS_KEY` makes one at its first start and
 * keeps it in the data directory, so a self-hosted server runs the browser client with no key to set by hand.
 *
 * The variable always wins. Hosted mode and `WIREBENCH_SERVER_INSTANCES=multi` never read or make the file: there the
 * variable stays required (`loadConfig` says so), since every instance must hold the same key.
 *
 * The file is 32 random bytes, base64-encoded, the form `openssl rand -base64 32` prints, with a trailing newline. It
 * is made mode 0600 under a temporary name and linked into place, which fails if the name is taken, so two starts
 * racing each other keep one key, and a crash never leaves half a key under the real name. A file that is there but
 * cannot be read, is not a key, or is open to the group or others (POSIX) fails the start: it is never overwritten,
 * since a new key would leave every secret sealed under the old one unopened. Nothing here ever logs or throws the
 * key, or the file's content.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { isCanonicalBase64 } from '@wirebench/engine';
import { instanceModeOf, type ServerConfig } from './config.js';

/** The key file's name, at the data directory's root. */
export const SECRETS_KEY_FILE = 'secrets-key';

/** The key's length in bytes, as `WIREBENCH_SERVER_SECRETS_KEY` takes it. */
const KEY_BYTES = 32;
/** Far more than a key and its newline; a larger file is not one, and is not read whole. */
const MAX_FILE_BYTES = 1024;

/** A key file the server will not use; the message names the path and the rule, never the content. */
export class SecretsKeyFileError extends Error {
  readonly code = 'server-secrets-key-file-invalid';
}

export type SecretsKeySource =
  /** `WIREBENCH_SERVER_SECRETS_KEY`, or its `_FILE`. */
  | 'variable'
  /** The data directory's key file, made at an earlier start. */
  | 'file'
  /** Made by this call, and stored. */
  | 'generated'
  /** None: hosted or `multi` without the variable (which `loadConfig` refuses), or a read-only caller with no file. */
  | 'none';

/** The key as the configuration types it. */
type SecretsKey = NonNullable<ServerConfig['secretsKey']>;

export interface ResolvedSecretsKey {
  readonly key: SecretsKey | undefined;
  readonly source: SecretsKeySource;
  /** The key file's path, whenever the file was looked for. */
  readonly path?: string;
}

/** Whether this server keeps its key in the data directory: not in hosted mode, and not with several instances. */
export function storesSecretsKey(config: Pick<ServerConfig, 'mode' | 'instances'>): boolean {
  return config.mode !== 'hosted' && instanceModeOf(config) === 'single';
}

/**
 * The secrets key this server runs with. `create` makes and stores one when there is none (`serve`); without it a
 * missing file is no key (`migrate` and the admin commands, which read what the server made and never make one).
 *
 * @throws SecretsKeyFileError when the file is there but is not one the server will use, or cannot be written.
 */
export async function resolveSecretsKey(
  config: Pick<ServerConfig, 'mode' | 'instances' | 'dataDir' | 'secretsKey'>,
  options: { readonly create: boolean },
): Promise<ResolvedSecretsKey> {
  if (config.secretsKey !== undefined) return { key: config.secretsKey, source: 'variable' };
  if (!storesSecretsKey(config)) return { key: undefined, source: 'none' };
  const path = join(config.dataDir, SECRETS_KEY_FILE);
  const stored = await readKeyFile(path);
  if (stored !== undefined) return { key: stored, source: 'file', path };
  if (!options.create) return { key: undefined, source: 'none', path };
  const made = randomBytes(KEY_BYTES);
  try {
    await mkdir(config.dataDir, { recursive: true });
  } catch (error) {
    throw new SecretsKeyFileError(`the data directory for the secrets key could not be made (${codeOf(error)})`);
  }
  if (await writeKeyFile(path, made)) return { key: made, source: 'generated', path };
  // Another start stored one first: that one is the key.
  const theirs = await readKeyFile(path);
  if (theirs === undefined) throw new SecretsKeyFileError(`${path} vanished while the secrets key was being stored`);
  return { key: theirs, source: 'file', path };
}

/** What the server logs, once, when it made a key: where it is, and why it matters. Never the key. */
export function generatedKeyNotice(path: string): string {
  return (
    `secrets key: WIREBENCH_SERVER_SECRETS_KEY is not set, so a new key was generated and stored in ${path} (mode 0600). ` +
    'Back that file up with the data directory: without it, the secrets users stored on this server cannot be opened.'
  );
}

/** The key in `path`, or `undefined` when there is no file. */
async function readKeyFile(path: string): Promise<SecretsKey | undefined> {
  let handle: FileHandle;
  try {
    // O_NOFOLLOW (POSIX): a link put in the key's place is refused, not followed. Windows has no such flag.
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = codeOf(error);
    if (code === 'ENOENT') return undefined;
    if (code === 'ELOOP') throw refused(path, 'is a symbolic link; put the key file itself there');
    throw refused(path, `cannot be read (${code}); give the server read access to it`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw refused(path, 'is not a regular file');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      const mode = (stat.mode & 0o777).toString(8).padStart(4, '0');
      throw refused(path, `is open to the group or others (mode ${mode}); run chmod 600 on it`);
    }
    if (stat.size > MAX_FILE_BYTES) throw refused(path, notAKey);
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8').trim();
    buffer.fill(0);
    if (!isCanonicalBase64(text) || Buffer.from(text, 'base64').length !== KEY_BYTES) throw refused(path, notAKey);
    return Buffer.from(text, 'base64');
  } catch (error) {
    if (error instanceof SecretsKeyFileError) throw error;
    throw refused(path, `cannot be read (${codeOf(error)})`);
  } finally {
    await handle.close();
  }
}

const notAKey = `is not a secrets key: it must hold ${String(KEY_BYTES)} bytes, base64-encoded (openssl rand -base64 32)`;

/**
 * Stores `key` at `path` unless a file is there already: written whole under a temporary name, then linked into place,
 * which fails if the name is taken. `false` when another start stored one first.
 */
async function writeKeyFile(path: string, key: Buffer): Promise<boolean> {
  const text = `${key.toString('base64')}\n`;
  const temporary = `${path}.${String(process.pid)}-${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeExclusive(temporary, text);
    try {
      await link(temporary, path);
      return true;
    } catch (error) {
      const code = codeOf(error);
      if (code === 'EEXIST') return false;
      // A filesystem without hard links (some network and container volumes): an exclusive create of the name
      // itself, which still never overwrites, though a crash part way leaves a short file the next start refuses.
      if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS') {
        return await writeExclusive(path, text).then(
          () => true,
          (direct: unknown) => {
            if (codeOf(direct) === 'EEXIST') return false;
            throw direct;
          },
        );
      }
      throw error;
    }
  } catch (error) {
    throw new SecretsKeyFileError(`the secrets key could not be stored in ${path} (${codeOf(error)})`);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/** Creates `path` (refusing one that exists) mode 0600, writes `text` and flushes it to the disk. */
async function writeExclusive(path: string, text: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const refused = (path: string, rule: string): SecretsKeyFileError =>
  new SecretsKeyFileError(
    `${path} ${rule}. The server will not replace it: a new key would leave the secrets sealed under the old one unopened. Fix the file, or set WIREBENCH_SERVER_SECRETS_KEY.`,
  );

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown error';
}
