// @vitest-environment node
import { PassThrough, Readable, Writable } from 'node:stream';
import type { Caller } from '../src/host/platform.js';
import { asCaller } from './helpers/ipc-table.js';
import { WirebenchError } from '@wirebench/engine';
import { SftpError } from '@wirebench/ssh';
import type { RemoteEntry, SftpSession } from '@wirebench/ssh';
import { describe, expect, it, vi } from 'vitest';
import { TransferQueue, remotePlace } from '../src/transfers.js';
import type { PlaceFs } from '../src/transfers.js';
import { events } from '@wirebench/wire/ipc';
import type { SftpConflictEvent, SftpTransferEvent } from '@wirebench/wire/sftp-wire';

const PART = '.wirebench-part';

interface MemFile {
  data: Buffer;
  mode: number;
  mtime: number;
}

/**
 * An in-memory file system behind the `SftpSession` interface. A held path's read stream sends its first
 * byte and then waits for `release` (or `breakRead`), so a test can look at a transfer mid-stream.
 */
function memFs(id: string) {
  const files = new Map<string, MemFile>();
  const dirs = new Set<string>(['/']);
  const links = new Map<string, string>();
  const held = new Set<string>();
  const open = new Map<string, PassThrough[]>();
  const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
  const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
  const notFound = (path: string, op: string) =>
    new SftpError('sftp-not-found', `${path} does not exist`, { path, op });
  const entryOf = (path: string): RemoteEntry => {
    const link = links.get(path);
    if (link !== undefined) {
      return {
        name: base(path),
        type: 'symlink',
        size: link.length,
        mtime: 0,
        mode: 0o777,
        targetType: dirs.has(link) ? 'dir' : files.has(link) ? 'file' : 'other',
      };
    }
    if (dirs.has(path)) return { name: base(path), type: 'dir', size: 0, mtime: 0, mode: 0o755 };
    const file = files.get(path);
    if (!file) throw notFound(path, 'stat');
    return { name: base(path), type: 'file', size: file.data.length, mtime: file.mtime, mode: file.mode };
  };
  const exists = (path: string) => dirs.has(path) || files.has(path) || links.has(path);
  const resolveLink = (path: string) => links.get(path) ?? path;

  const session: SftpSession = {
    id,
    realpath: (path) => Promise.resolve(path),
    list: (path) =>
      Promise.resolve(
        [...dirs, ...files.keys(), ...links.keys()]
          .filter((p) => p !== '/' && parent(p) === path)
          .map((p) => entryOf(p)),
      ),
    stat: (path) =>
      new Promise((resolve) => {
        resolve(entryOf(path));
      }),
    mkdir: (path) => {
      if (exists(path)) return Promise.reject(new SftpError('sftp-exists', path, { path, op: 'mkdir' }));
      if (!dirs.has(parent(path))) return Promise.reject(notFound(path, 'mkdir'));
      dirs.add(path);
      return Promise.resolve();
    },
    rename: (from, to) => {
      if (exists(to)) return Promise.reject(new SftpError('sftp-exists', to, { path: to, op: 'rename' }));
      const file = files.get(from);
      if (!file) return Promise.reject(notFound(from, 'rename'));
      files.delete(from);
      files.set(to, file);
      return Promise.resolve();
    },
    remove: (path) => {
      if (!files.delete(path) && !links.delete(path)) return Promise.reject(notFound(path, 'remove'));
      return Promise.resolve();
    },
    chmod: () => Promise.resolve(),
    readStream: (path) => {
      const file = files.get(resolveLink(path));
      if (!file) {
        const failed = new PassThrough();
        failed.destroy(notFound(path, 'read'));
        return failed;
      }
      if (!held.has(path)) return Readable.from([file.data]);
      const out = new PassThrough();
      out.write(file.data.subarray(0, 1));
      open.set(path, [...(open.get(path) ?? []), out]);
      return out;
    },
    writeStream: (path, { mode }) => {
      if (!dirs.has(parent(path))) {
        const failed = new Writable();
        failed.destroy(notFound(path, 'write'));
        return failed;
      }
      const chunks: Buffer[] = [];
      // As a real server: the file is there (empty) from the open on.
      files.set(path, { data: Buffer.alloc(0), mode: mode ?? 0o644, mtime: 1 });
      return new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
        final(callback) {
          const file = files.get(path);
          if (file) file.data = Buffer.concat(chunks);
          callback();
        },
      });
    },
    close: vi.fn(),
    onClose: () => () => undefined,
  };
  return {
    session,
    files,
    dirs,
    links,
    write: (path: string, text: string, mode = 0o644, mtime = 5) => {
      files.set(path, { data: Buffer.from(text), mode, mtime });
    },
    text: (path: string) => files.get(path)?.data.toString(),
    hold: (path: string) => held.add(path),
    release: (path: string) => {
      const file = files.get(resolveLink(path));
      for (const out of open.get(path) ?? []) out.end(file?.data.subarray(1));
      open.delete(path);
      held.delete(path);
    },
    breakRead: (path: string) => {
      for (const out of open.get(path) ?? []) out.destroy(new Error('connection reset'));
      open.delete(path);
    },
    feed: (path: string, chunk: Buffer) => {
      for (const out of open.get(path) ?? []) out.write(chunk);
    },
    parts: () => [...files.keys()].filter((p) => p.endsWith(PART)),
  };
}

function sender(id = 1) {
  let gone = false;
  const destroyed: (() => void)[] = [];
  return {
    id,
    isDestroyed: () => gone,
    once: vi.fn((name: string, listener: () => void) => {
      if (name === 'destroyed') destroyed.push(listener);
    }),
    on: vi.fn(),
    destroy: () => {
      gone = true;
      for (const listener of destroyed) listener();
    },
  };
}
const as = (s: ReturnType<typeof sender>) => asCaller(s);

function make(options: { concurrency?: number; now?: () => number } = {}) {
  const local = memFs('local-fs');
  const remote = memFs('r1');
  const other = memFs('r2');
  const sessions = new Map<string, SftpSession>([
    [remote.session.id, remote.session],
    [other.session.id, other.session],
  ]);
  const closed = new Set<(sender: Caller, sessionId: string) => void>();
  const sftp = {
    session: (_sender: Caller, sessionId: string) => {
      const session = sessions.get(sessionId);
      if (!session) throw new WirebenchError('sftp-session-unknown', 'No such session');
      return session;
    },
    onSessionClosed: (listener: (sender: Caller, sessionId: string) => void) => {
      closed.add(listener);
      return () => closed.delete(listener);
    },
  };
  const emit = vi.fn();
  const localPlace: PlaceFs = { ...remotePlace(local.session), key: 'local', local: true };
  const queue = new TransferQueue({ sftp, emit, local: localPlace, ...options });
  const transfers = (id?: string) =>
    emit.mock.calls
      .filter(([, event]) => event === events.sftp.transfer)
      .map(([, , payload]) => payload as SftpTransferEvent)
      .filter((payload) => id === undefined || payload.transferId === id);
  const stateOf = (id: string) => transfers(id).at(-1)?.state;
  const conflicts = () =>
    emit.mock.calls.filter(([, event]) => event === events.sftp.conflict).map(([, , p]) => p as SftpConflictEvent);
  const endSession = (sessionId: string, s: Caller) => {
    sessions.delete(sessionId);
    for (const listener of closed) listener(s, sessionId);
  };
  return { queue, local, remote, other, emit, transfers, stateOf, conflicts, endSession };
}

const LOCAL = { kind: 'local' } as const;
const REMOTE = { kind: 'remote', sessionId: 'r1' } as const;
const OTHER = { kind: 'remote', sessionId: 'r2' } as const;
const across = (paths: string[], dir = '/in', batchId = 'b1') => ({
  batchId,
  from: { place: REMOTE, paths },
  to: { place: OTHER, dir },
});
const upload = (paths: string[], dir = '/up', batchId = 'b1') => ({
  batchId,
  from: { place: LOCAL, paths },
  to: { place: REMOTE, dir },
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const until = (check: () => boolean) =>
  vi.waitFor(() => {
    if (!check()) throw new Error('not yet');
  });

describe('TransferQueue', () => {
  it('runs three at a time; the fourth waits as queued', async () => {
    const t = make();
    t.remote.dirs.add('/up');
    for (const n of [1, 2, 3, 4]) {
      t.local.write(`/f${String(n)}`, `file ${String(n)}`);
      t.local.hold(`/f${String(n)}`);
    }
    const s = sender();
    const { transferIds } = await t.queue.copy(as(s), upload(['/f1', '/f2', '/f3', '/f4']));
    await until(() => transferIds.slice(0, 3).every((id) => t.stateOf(id) === 'running'));
    await settle();
    expect(t.stateOf(transferIds[3] as string)).toBe('queued');
    t.local.release('/f1');
    await until(() => t.stateOf(transferIds[3] as string) === 'running');
    expect(t.stateOf(transferIds[0] as string)).toBe('done');
    expect(t.remote.text('/up/f1')).toBe('file 1');
  });

  it('walks a folder depth first: folders before their files, an existing one reused, a folder symlink skipped', async () => {
    const t = make();
    t.remote.dirs.add('/up');
    t.remote.dirs.add('/up/site');
    t.local.dirs.add('/site');
    t.local.dirs.add('/site/css');
    t.local.dirs.add('/site/empty');
    t.local.write('/site/index.html', 'index');
    t.local.write('/site/css/a.css', 'css');
    t.local.links.set('/site/loop', '/site');
    t.local.links.set('/site/readme', '/site/index.html');
    const s = sender();
    const { transferIds } = await t.queue.copy(as(s), upload(['/site']));
    await until(() => transferIds.every((id) => ['done', 'skipped'].includes(t.stateOf(id) ?? '')));
    expect(t.remote.text('/up/site/index.html')).toBe('index');
    expect(t.remote.text('/up/site/css/a.css')).toBe('css');
    expect(t.remote.dirs.has('/up/site/empty')).toBe(true);
    // A symlink to a file is followed; one to a folder is never walked.
    expect(t.remote.text('/up/site/readme')).toBe('index');
    expect(t.remote.dirs.has('/up/site/loop')).toBe(false);
    const names: Record<string, string | undefined> = {};
    for (const id of transferIds) names[t.transfers(id)[0]?.name ?? ''] = t.stateOf(id);
    expect(names).toMatchObject({ 'site/loop': 'skipped', 'site/index.html': 'done', 'site/css/a.css': 'done' });
    expect(t.conflicts()).toEqual([]);
  });

  it('refuses copying a folder into itself before anything is written', async () => {
    const t = make();
    t.remote.dirs.add('/a');
    t.remote.dirs.add('/a/b');
    t.remote.write('/a/x', 'x');
    const s = sender();
    const before = [...t.remote.files.keys(), ...t.remote.dirs];
    const into = (dir: string) =>
      t.queue.copy(as(s), { batchId: 'b', from: { place: REMOTE, paths: ['/a'] }, to: { place: REMOTE, dir } });
    await expect(into('/a/b')).rejects.toMatchObject({ code: 'sftp-failed', details: { reason: 'into-itself' } });
    await expect(into('/a')).rejects.toMatchObject({ code: 'sftp-failed', details: { reason: 'into-itself' } });
    expect([...t.remote.files.keys(), ...t.remote.dirs]).toEqual(before);
    expect(t.emit).not.toHaveBeenCalled();
  });

  it('pauses a clash as waiting with one conflict event naming both sides', async () => {
    const t = make();
    t.remote.dirs.add('/up');
    t.remote.write('/up/a.txt', 'old', 0o644, 1000);
    t.local.write('/a.txt', 'newer', 0o644, 2000);
    const s = sender();
    const { transferIds } = await t.queue.copy(as(s), upload(['/a.txt']));
    const id = transferIds[0] as string;
    await until(() => t.stateOf(id) === 'waiting');
    await settle();
    expect(t.conflicts()).toEqual([
      {
        batchId: 'b1',
        transferId: id,
        name: 'a.txt',
        existing: { size: 3, mtime: 1000 },
        incoming: { size: 5, mtime: 2000 },
        remaining: 0,
      },
    ]);
    expect(t.remote.text('/up/a.txt')).toBe('old');
  });

  it.each([
    ['skip', 'skipped', { '/up/a.txt': 'old' }],
    ['keep-both', 'done', { '/up/a.txt': 'old', '/up/a (1).txt': 'new' }],
    ['replace', 'done', { '/up/a.txt': 'new' }],
  ] as const)('answers %s as the spec says', async (decision, state, expected) => {
    const t = make();
    t.remote.dirs.add('/up');
    t.remote.write('/up/a.txt', 'old');
    t.local.write('/a.txt', 'new');
    const s = sender();
    const { transferIds } = await t.queue.copy(as(s), upload(['/a.txt']));
    const id = transferIds[0] as string;
    await until(() => t.stateOf(id) === 'waiting');
    t.queue.resolve(as(s), { batchId: 'b1', decision, applyToRest: false });
    await until(() => t.stateOf(id) === state);
    for (const [path, text] of Object.entries(expected)) expect(t.remote.text(path)).toBe(text);
    expect(t.remote.parts()).toEqual([]);
  });

  it.each([true, false])(
    'applyToRest %s: later clashes of the batch are answered without asking only when set',
    async (applyToRest) => {
      const t = make({ concurrency: 1 });
      t.remote.dirs.add('/up');
      for (const n of ['a', 'b', 'c']) {
        t.remote.write(`/up/${n}`, 'old');
        t.local.write(`/${n}`, 'new');
      }
      const s = sender();
      const { transferIds } = await t.queue.copy(as(s), upload(['/a', '/b', '/c']));
      await until(() => t.conflicts().length === 1);
      expect(t.conflicts()[0]?.remaining).toBe(2);
      t.queue.resolve(as(s), { batchId: 'b1', decision: 'replace', applyToRest });
      if (applyToRest) {
        await until(() => transferIds.every((id) => t.stateOf(id) === 'done'));
        expect(t.conflicts()).toHaveLength(1);
        expect(t.remote.text('/up/c')).toBe('new');
      } else {
        await until(() => t.conflicts().length === 2);
        expect(t.conflicts()[1]?.remaining).toBe(1);
        expect(t.stateOf(transferIds[0] as string)).toBe('done');
      }
    },
  );

  it('the same name twice in one batch clashes the second time', async () => {
    const t = make();
    t.remote.dirs.add('/up');
    t.local.dirs.add('/x');
    t.local.write('/a.txt', 'first');
    t.local.write('/x/a.txt', 'second');
    const s = sender();
    const { transferIds } = await t.queue.copy(as(s), upload(['/a.txt', '/x/a.txt']));
    await until(() => t.conflicts().length === 1);
    expect(t.stateOf(transferIds[0] as string)).toBe('done');
    expect(t.conflicts()[0]?.transferId).toBe(transferIds[1]);
  });

  it('writes to a part file and renames it at the end', async () => {
    const t = make();
    t.remote.dirs.add('/up');
    t.local.write('/a.txt', 'content');
    t.local.hold('/a.txt');
    const s = sender();
    const { transferIds } = await t.queue.copy(as(s), upload(['/a.txt']));
    await until(() => t.remote.parts().length === 1);
    expect(t.remote.parts()).toEqual([`/up/a.txt${PART}`]);
    expect(t.remote.files.has('/up/a.txt')).toBe(false);
    t.local.release('/a.txt');
    await until(() => t.stateOf(transferIds[0] as string) === 'done');
    expect(t.remote.parts()).toEqual([]);
    expect(t.remote.text('/up/a.txt')).toBe('content');
  });

  it('a broken read fails the transfer, removes the part file and leaves the existing target', async () => {
    const t = make();
    t.remote.dirs.add('/up');
    t.remote.write('/up/a.txt', 'old');
    t.local.write('/a.txt', 'new content');
    t.local.hold('/a.txt');
    const s = sender();
    const { transferIds } = await t.queue.copy(as(s), upload(['/a.txt']));
    const id = transferIds[0] as string;
    await until(() => t.stateOf(id) === 'waiting');
    t.queue.resolve(as(s), { batchId: 'b1', decision: 'replace', applyToRest: false });
    await until(() => t.remote.parts().length === 1);
    t.local.breakRead('/a.txt');
    await until(() => t.stateOf(id) === 'failed');
    expect(t.transfers(id).at(-1)?.error).toBeDefined();
    expect(t.remote.parts()).toEqual([]);
    expect(t.remote.text('/up/a.txt')).toBe('old');
  });

  it('cancel mid-stream ends cancelled with no part file; retry starts over', async () => {
    const t = make();
    t.remote.dirs.add('/up');
    t.local.write('/a.txt', 'content');
    t.local.hold('/a.txt');
    const s = sender();
    const { transferIds } = await t.queue.copy(as(s), upload(['/a.txt']));
    const id = transferIds[0] as string;
    await until(() => t.remote.parts().length === 1);
    t.queue.cancel(as(s), { transferId: id });
    t.queue.cancel(as(s), { transferId: id });
    await until(() => t.stateOf(id) === 'cancelled');
    await until(() => t.remote.parts().length === 0);
    expect(t.remote.files.has('/up/a.txt')).toBe(false);

    t.local.release('/a.txt');
    t.queue.retry(as(s), { transferId: id });
    await until(() => t.stateOf(id) === 'done');
    expect(t.remote.text('/up/a.txt')).toBe('content');
    expect(t.transfers(id).map((e) => e.state)).toEqual(expect.arrayContaining(['cancelled', 'queued', 'done']));
  });

  it('cancelling a queued transfer never starts it', async () => {
    const t = make({ concurrency: 1 });
    t.remote.dirs.add('/up');
    t.local.write('/a', 'a');
    t.local.write('/b', 'b');
    t.local.hold('/a');
    const s = sender();
    const { transferIds } = await t.queue.copy(as(s), upload(['/a', '/b']));
    t.queue.cancel(as(s), { transferId: transferIds[1] as string });
    t.local.release('/a');
    await until(() => t.stateOf(transferIds[0] as string) === 'done');
    await settle();
    expect(t.stateOf(transferIds[1] as string)).toBe('cancelled');
    expect(t.remote.files.has('/up/b')).toBe(false);
  });

  it('a session closing fails its running and queued transfers', async () => {
    const t = make({ concurrency: 1 });
    t.remote.dirs.add('/up');
    t.local.write('/a', 'a');
    t.local.write('/b', 'b');
    t.local.hold('/a');
    const s = sender();
    const { transferIds } = await t.queue.copy(as(s), upload(['/a', '/b']));
    await until(() => t.remote.parts().length === 1);
    t.endSession('r1', as(s));
    await until(() => transferIds.every((id) => t.stateOf(id) === 'failed'));
    expect(t.transfers(transferIds[1]).at(-1)?.error?.code).toBe('ssh-session-closed');
  });

  describe('remote to remote', () => {
    it('streams a file from one session to the other through main', async () => {
      const t = make();
      t.other.dirs.add('/in');
      t.remote.dirs.add('/srv');
      t.remote.write('/srv/report.csv', 'a,b,c', 0o600);
      const s = sender();
      const { transferIds } = await t.queue.copy(as(s), across(['/srv/report.csv']));
      await until(() => t.stateOf(transferIds[0] as string) === 'done');
      expect(t.other.text('/in/report.csv')).toBe('a,b,c');
      expect(t.remote.text('/srv/report.csv')).toBe('a,b,c');
      expect(t.local.files.size).toBe(0);
      expect(t.other.parts()).toEqual([]);
    });

    it('honours a clash on the receiving host', async () => {
      const t = make();
      t.other.dirs.add('/in');
      t.other.write('/in/a.txt', 'old', 0o644, 1000);
      t.remote.write('/a.txt', 'newer', 0o644, 2000);
      const s = sender();
      const { transferIds } = await t.queue.copy(as(s), across(['/a.txt']));
      const id = transferIds[0] as string;
      await until(() => t.stateOf(id) === 'waiting');
      expect(t.conflicts()).toHaveLength(1);
      t.queue.resolve(as(s), { batchId: 'b1', decision: 'keep-both', applyToRest: false });
      await until(() => t.stateOf(id) === 'done');
      expect(t.other.text('/in/a.txt')).toBe('old');
      expect(t.other.text('/in/a (1).txt')).toBe('newer');
    });

    it('cancel mid-stream leaves no part file on the receiving host', async () => {
      const t = make();
      t.other.dirs.add('/in');
      t.remote.write('/a.txt', 'content');
      t.remote.hold('/a.txt');
      const s = sender();
      const { transferIds } = await t.queue.copy(as(s), across(['/a.txt']));
      const id = transferIds[0] as string;
      await until(() => t.other.parts().length === 1);
      t.queue.cancel(as(s), { transferId: id });
      await until(() => t.stateOf(id) === 'cancelled');
      await until(() => t.other.parts().length === 0);
      expect(t.other.files.has('/in/a.txt')).toBe(false);
    });

    it('one session closing fails only the transfers that use it', async () => {
      const t = make();
      t.other.dirs.add('/in');
      t.remote.dirs.add('/up');
      t.remote.write('/a', 'a');
      t.remote.hold('/a');
      t.local.write('/b', 'b');
      t.local.hold('/b');
      const s = sender();
      const between = await t.queue.copy(as(s), across(['/a']));
      const toOther = await t.queue.copy(as(s), {
        batchId: 'b2',
        from: { place: LOCAL, paths: ['/b'] },
        to: { place: OTHER, dir: '/in' },
      });
      const a = between.transferIds[0] as string;
      const b = toOther.transferIds[0] as string;
      await until(() => t.stateOf(a) === 'running' && t.stateOf(b) === 'running');
      t.endSession('r1', as(s));
      await until(() => t.stateOf(a) === 'failed');
      expect(t.stateOf(b)).toBe('running');
      t.local.release('/b');
      await until(() => t.stateOf(b) === 'done');
      expect(t.other.text('/in/b')).toBe('b');
      expect(t.other.parts()).toEqual([]);
    });
  });

  it('disposeFor cancels everything, removes part files and emits nothing afterwards', async () => {
    const t = make();
    t.remote.dirs.add('/up');
    t.local.write('/a', 'a');
    t.local.hold('/a');
    const s = sender();
    await t.queue.copy(as(s), upload(['/a']));
    await until(() => t.remote.parts().length === 1);
    const before = t.emit.mock.calls.length;
    t.queue.disposeFor(as(s));
    await until(() => t.remote.parts().length === 0);
    await settle();
    expect(t.emit.mock.calls.length).toBe(before);
  });

  it('the window going away disposes its transfers', async () => {
    const t = make();
    t.remote.dirs.add('/up');
    t.local.write('/a', 'a');
    t.local.hold('/a');
    const s = sender();
    await t.queue.copy(as(s), upload(['/a']));
    await until(() => t.remote.parts().length === 1);
    s.destroy();
    await until(() => t.remote.parts().length === 0);
  });

  it('sends progress at most four times a second, plus every state change', async () => {
    let clock = 0;
    const t = make({ now: () => clock });
    t.remote.dirs.add('/up');
    // One byte on disk; the test feeds 99 more, so the total grows with what arrives.
    t.local.write('/big', 'x');
    t.local.hold('/big');
    const s = sender();
    const { transferIds } = await t.queue.copy(as(s), upload(['/big']));
    const id = transferIds[0] as string;
    await until(() => t.remote.parts().length === 1);
    // 100 one-byte chunks over one second.
    for (let n = 0; n < 99; n += 1) {
      clock += 10;
      t.local.feed('/big', Buffer.from('y'));
      await new Promise((resolve) => setImmediate(resolve));
    }
    clock += 10;
    t.local.release('/big');
    await until(() => t.stateOf(id) === 'done');
    const progress = t.transfers(id).filter((e) => e.state === 'running' && e.done > 0);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.length).toBeLessThanOrEqual(5);
    expect(t.transfers(id).at(-1)).toMatchObject({ state: 'done', done: 100, total: 100 });
  });

  it('an upload keeps the local mode bits', async () => {
    const t = make();
    t.remote.dirs.add('/up');
    t.local.write('/run.sh', 'echo', 0o750);
    const s = sender();
    const { transferIds } = await t.queue.copy(as(s), upload(['/run.sh']));
    await until(() => t.stateOf(transferIds[0] as string) === 'done');
    expect(t.remote.files.get('/up/run.sh')?.mode).toBe(0o750);
  });

  it('refuses a session the window does not own', async () => {
    const t = make();
    const s = sender();
    await expect(
      t.queue.copy(as(s), {
        batchId: 'b',
        from: { place: LOCAL, paths: ['/a'] },
        to: { place: { kind: 'remote', sessionId: 'nope' }, dir: '/' },
      }),
    ).rejects.toMatchObject({ code: 'sftp-session-unknown' });
  });
});
