import { randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import type { Readable } from 'node:stream';
import type { Attributes, SFTPWrapper } from 'ssh2';
import { HopProgress } from './connect-progress.js';
import { dialChain, hostOf } from './dial.js';
import type { DialOptions, DialledChain, HopCredentials } from './dial.js';
import { SshModelError } from './errors.js';

export interface RemoteEntry {
  readonly name: string;
  readonly type: 'file' | 'dir' | 'symlink' | 'other';
  readonly size: number;
  /** Milliseconds since the epoch. */
  readonly mtime: number;
  /** Permission bits only (`mode & 0o7777`). */
  readonly mode: number;
  /** For a symlink, what it points at, so the pane can open it like a folder; a dangling link is 'other'. */
  readonly targetType?: 'file' | 'dir' | 'other';
}

export interface SftpSession {
  readonly id: string;
  /** The server's absolute form of `path`; `'.'` is the login directory. */
  realpath(path: string): Promise<string>;
  list(path: string): Promise<readonly RemoteEntry[]>;
  stat(path: string): Promise<RemoteEntry>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** A directory with `recursive` is emptied depth first; without it, a non-empty directory is refused. */
  remove(path: string, options: { readonly recursive: boolean }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  readStream(path: string): Readable;
  writeStream(path: string, options: { readonly mode?: number }): Writable;
  close(): void;
  onClose(listener: () => void): () => void;
}

export type SftpOp = 'list' | 'stat' | 'mkdir' | 'rename' | 'remove' | 'chmod' | 'read' | 'write' | 'realpath';

/** sftp-unavailable | sftp-not-found | sftp-permission-denied | sftp-exists | sftp-failed, details { path, op, status? }. */
export class SftpError extends SshModelError {}

// SFTP status codes (draft-ietf-secsh-filexfer-02, the version OpenSSH speaks).
const NO_SUCH_FILE = 2;
const PERMISSION_DENIED = 3;
const FAILURE = 4;

/**
 * Maps a failed SFTP request to an {@link SftpError}. The server's message is never forwarded: it is free
 * text from the other side. OpenSSH answers a mkdir or rename onto an existing name with a bare FAILURE.
 */
export function sftpErrorOf(error: unknown, op: SftpOp, path: string): SftpError {
  if (error instanceof SftpError) return error;
  const status = (error as { code?: unknown } | null)?.code;
  if (status === NO_SUCH_FILE) return new SftpError('sftp-not-found', `${path} does not exist`, { path, op });
  if (status === PERMISSION_DENIED) {
    return new SftpError('sftp-permission-denied', `the server refused ${op} on ${path}`, { path, op });
  }
  if (status === FAILURE && (op === 'mkdir' || op === 'rename')) {
    return new SftpError('sftp-exists', `${path} already exists`, { path, op });
  }
  return typeof status === 'number'
    ? new SftpError('sftp-failed', `${op} on ${path} failed with status ${status}`, { path, op, status })
    : new SftpError('sftp-failed', `${op} on ${path} failed`, { path, op });
}

/** `dir` + '/' + `name` with one slash; throws when `name` contains '/'. */
export function joinRemote(dir: string, name: string): string {
  if (name === '' || name.includes('/')) {
    throw new SftpError('sftp-failed', `${JSON.stringify(name)} is not a file name`, {
      path: dir,
      reason: 'unsafe-name',
    });
  }
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

/** Drops trailing slashes, keeping a lone '/'; a loop, since a regex over a server's path can backtrack. */
const trimSlashes = (path: string): string => {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') end -= 1;
  return path.slice(0, end);
};

/** The parent of a POSIX path; the parent of '/' is '/'. */
export function parentRemote(path: string): string {
  const trimmed = trimSlashes(path);
  const slash = trimmed.lastIndexOf('/');
  if (slash < 0) return '.';
  return slash === 0 ? '/' : trimmed.slice(0, slash);
}

const baseName = (path: string): string => {
  const trimmed = trimSlashes(path);
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
};

const typeOf = (mode: number): RemoteEntry['type'] => {
  switch (mode & 0o170000) {
    case 0o100000:
      return 'file';
    case 0o040000:
      return 'dir';
    case 0o120000:
      return 'symlink';
    default:
      return 'other';
  }
};

/** A {@link RemoteEntry} from the attributes `readdir`, `lstat` or `stat` returned. */
export function remoteEntryOf(
  name: string,
  attrs: Pick<Attributes, 'mode' | 'size' | 'mtime'>,
  targetType?: RemoteEntry['targetType'],
): RemoteEntry {
  return {
    name,
    type: typeOf(attrs.mode),
    size: attrs.size,
    mtime: attrs.mtime * 1000,
    mode: attrs.mode & 0o7777,
    ...(targetType === undefined ? {} : { targetType }),
  };
}

/** Dials the hop chain and opens the SFTP subsystem on the last hop. */
export async function openSftp(options: DialOptions): Promise<SftpSession> {
  const chain = await dialChain(options);
  const lastHop = options.hops[options.hops.length - 1] as HopCredentials;
  const progress = new HopProgress(options.onProgress, options.hops.length - 1, options.hops.length, hostOf(lastHop));
  progress.start('shell', 'sftp');
  progress.log('Starting the SFTP subsystem');
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    const refused = (): void => {
      progress.fail('The server offers no SFTP');
      chain.endAll();
      const host = hostOf(lastHop);
      reject(new SftpError('sftp-unavailable', `${host} offers no SFTP`, { host }));
    };
    try {
      chain.client.sftp((error, wrapper) => (error ? refused() : resolve(wrapper)));
    } catch {
      refused();
    }
  });
  progress.log('SFTP ready');
  progress.done('shell', 'sftp');
  return wrapSftp(sftp, chain);
}

function wrapSftp(sftp: SFTPWrapper, chain: DialledChain): SftpSession {
  const closeListeners = new Set<() => void>();
  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    chain.endAll();
    for (const listener of closeListeners) listener();
  };
  chain.onLost(finish);
  sftp.on('close', finish);
  // An error on the channel ends the session through its close; never an unhandled 'error' event.
  sftp.on('error', () => undefined);

  /** Runs one request; ssh2 throws synchronously on a channel that has gone. */
  const call = <T>(op: SftpOp, path: string, run: (done: (error: unknown, value?: T) => void) => void): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const done = (error: unknown, value?: T): void => {
        if (error) reject(sftpErrorOf(error, op, path));
        else resolve(value as T);
      };
      try {
        run(done);
      } catch (error) {
        done(error ?? new Error('request failed'));
      }
    });

  const lstat = (op: SftpOp, path: string) => call<Attributes>(op, path, (done) => sftp.lstat(path, done));
  const readdir = (op: SftpOp, path: string) =>
    call<{ filename: string; attrs: Attributes }[]>(op, path, (done) => sftp.readdir(path, done)).then((list) =>
      list.filter((entry) => entry.filename !== '.' && entry.filename !== '..'),
    );
  const targetTypeOf = (path: string): Promise<RemoteEntry['targetType']> =>
    call<Attributes>('stat', path, (done) => sftp.stat(path, done)).then(
      (attrs) => {
        const type = typeOf(attrs.mode);
        return type === 'symlink' ? 'other' : type;
      },
      () => 'other' as const,
    );
  const entryAt = async (name: string, path: string, attrs: Attributes): Promise<RemoteEntry> =>
    typeOf(attrs.mode) === 'symlink'
      ? remoteEntryOf(name, attrs, await targetTypeOf(path))
      : remoteEntryOf(name, attrs);

  const removeTree = async (path: string): Promise<void> => {
    // readdir reports each entry as lstat would, so a folder symlink is unlinked, never walked.
    for (const entry of await readdir('remove', path)) {
      const child = joinRemote(path, entry.filename);
      if (typeOf(entry.attrs.mode) === 'dir') await removeTree(child);
      else await call<void>('remove', child, (done) => sftp.unlink(child, done));
    }
    await call<void>('remove', path, (done) => sftp.rmdir(path, done));
  };

  return {
    id: randomUUID(),
    realpath: (path) => call<string>('realpath', path, (done) => sftp.realpath(path, done)),
    list: async (path) => {
      const entries = await readdir('list', path);
      return Promise.all(entries.map(({ filename, attrs }) => entryAt(filename, joinRemote(path, filename), attrs)));
    },
    stat: async (path) => entryAt(baseName(path), path, await lstat('stat', path)),
    mkdir: (path) => call<void>('mkdir', path, (done) => sftp.mkdir(path, done)),
    rename: async (from, to) => {
      // Servers differ on renaming onto an existing name (some replace it), so it is refused here first.
      const exists = await lstat('rename', to).then(
        () => true,
        (error: SftpError) => {
          if (error.code === 'sftp-not-found') return false;
          throw error;
        },
      );
      if (exists) throw new SftpError('sftp-exists', `${to} already exists`, { path: to, op: 'rename' });
      await call<void>('rename', from, (done) => sftp.rename(from, to, done));
    },
    remove: async (path, { recursive }) => {
      const attrs = await lstat('remove', path);
      if (typeOf(attrs.mode) !== 'dir') return call<void>('remove', path, (done) => sftp.unlink(path, done));
      if (recursive) return removeTree(path);
      return call<void>('remove', path, (done) => sftp.rmdir(path, done));
    },
    chmod: (path, mode) => call<void>('chmod', path, (done) => sftp.chmod(path, mode, done)),
    readStream: (path) => {
      const out = new PassThrough();
      try {
        const source = sftp.createReadStream(path);
        source.on('error', (error: unknown) => out.destroy(sftpErrorOf(error, 'read', path)));
        out.on('close', () => source.destroy());
        source.pipe(out);
      } catch (error) {
        out.destroy(sftpErrorOf(error, 'read', path));
      }
      return out;
    },
    writeStream: (path, { mode }) => writeStreamOf(sftp, path, mode),
    close: () => {
      if (closed) return;
      try {
        sftp.end();
      } catch {
        // The channel is already gone.
      }
      finish();
    },
    onClose: (listener) => {
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },
  };
}

/**
 * A writable that finishes only once the server has the last byte and the remote handle is closed, so a
 * caller's `finish` means the file is complete. Errors come out as {@link SftpError}s.
 */
function writeStreamOf(sftp: SFTPWrapper, path: string, mode: number | undefined): Writable {
  let inner: Writable;
  try {
    inner = sftp.createWriteStream(path, mode === undefined ? {} : { mode });
  } catch (error) {
    const failed = new Writable();
    failed.destroy(sftpErrorOf(error, 'write', path));
    return failed;
  }
  const outer = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      inner.write(chunk, (error) => callback(error ? sftpErrorOf(error, 'write', path) : undefined));
    },
    final(callback) {
      inner.once('close', () => callback());
      inner.end();
    },
    destroy(error, callback) {
      inner.destroy();
      callback(error);
    },
  });
  inner.on('error', (error: unknown) => outer.destroy(sftpErrorOf(error, 'write', path)));
  return outer;
}
