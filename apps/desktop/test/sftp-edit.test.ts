// @vitest-environment node
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { FSWatcher, WatchListener } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { WebContents } from 'electron';
import { WirebenchError } from '@wirebench/engine';
import { SftpError } from '@wirebench/ssh';
import type { RemoteEntry, SftpSession } from '@wirebench/ssh';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SftpEditService, sweepEditCopies } from '../src/main/sftp-edit.js';
import { events } from '../src/shared/ipc.js';
import { EDIT_ASK_ABOVE_BYTES } from '../src/shared/sftp-defaults.js';
import type { SftpEditEvent } from '../src/shared/sftp-wire.js';

interface MemFile {
  data: Buffer;
  mtime: number;
  /** Reported instead of `data.length` (a large file without the bytes). */
  size?: number;
}

/** A host's files behind `SftpSession`; `hold()` keeps the next write open until `release()`. */
function memHost(id: string) {
  const files = new Map<string, MemFile>();
  let clock = 1000;
  let held: (() => void) | undefined;
  let holdNext = false;
  const writes: string[] = [];
  const notFound = (path: string, op: string) =>
    new SftpError('sftp-not-found', `${path} does not exist`, { path, op });
  const closeListeners = new Set<() => void>();
  const session: SftpSession = {
    id,
    realpath: (path) => Promise.resolve(path),
    list: () => Promise.resolve([]),
    stat: (path) => {
      const file = files.get(path);
      if (!file) return Promise.reject(notFound(path, 'stat'));
      const entry: RemoteEntry = {
        name: basename(path),
        type: 'file',
        size: file.size ?? file.data.length,
        mtime: file.mtime,
        mode: 0o640,
      };
      return Promise.resolve(entry);
    },
    mkdir: () => Promise.resolve(),
    rename: (from, to) => {
      const file = files.get(from);
      if (!file) return Promise.reject(notFound(from, 'rename'));
      if (files.has(to)) return Promise.reject(new SftpError('sftp-exists', to, { path: to, op: 'rename' }));
      files.delete(from);
      files.set(to, file);
      return Promise.resolve();
    },
    remove: (path) => (files.delete(path) ? Promise.resolve() : Promise.reject(notFound(path, 'remove'))),
    chmod: () => Promise.resolve(),
    readStream: (path) => {
      const file = files.get(path);
      if (!file) {
        return new Readable({
          read() {
            this.destroy(notFound(path, 'read'));
          },
        });
      }
      return Readable.from([file.data]);
    },
    writeStream: (path) => {
      const chunks: Buffer[] = [];
      writes.push(path);
      const hold = holdNext;
      holdNext = false;
      return new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
        final(callback) {
          const finish = () => {
            clock += 1;
            files.set(path, { data: Buffer.concat(chunks), mtime: clock });
            callback();
          };
          if (hold) held = finish;
          else finish();
        },
      });
    },
    close: () => {
      for (const listener of [...closeListeners]) listener();
    },
    onClose: (listener) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
  };
  return {
    session,
    files,
    writes,
    put(path: string, text: string, size?: number) {
      clock += 1;
      files.set(path, { data: Buffer.from(text), mtime: clock, ...(size === undefined ? {} : { size }) });
    },
    text: (path: string) => files.get(path)?.data.toString(),
    hold() {
      holdNext = true;
    },
    release() {
      const finish = held;
      held = undefined;
      finish?.();
    },
    isHeld: () => held !== undefined,
  };
}

const sender = (id: number) => ({ id, isDestroyed: () => false }) as unknown as WebContents;

/** A `fs.watch` stand-in: `fire()` tells every watcher of the folder that the file changed. */
function fakeWatch() {
  const watchers = new Map<string, { listener: WatchListener<string>; closed: boolean }>();
  const watch = vi.fn((dir: string, listener: WatchListener<string>) => {
    const entry = { listener, closed: false };
    watchers.set(dir, entry);
    return {
      close: () => {
        entry.closed = true;
      },
      on: () => undefined,
    } as unknown as FSWatcher;
  });
  return {
    watch,
    fire(file: string) {
      const entry = watchers.get(dirname(file));
      if (entry && !entry.closed) entry.listener('change', basename(file));
    },
    closed: (file: string) => watchers.get(dirname(file))?.closed ?? true,
  };
}

let root: string;
beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), 'wb-sftp-edit-')), 'sftp-edit');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dirname(root), { recursive: true, force: true });
});

function setup() {
  const host = memHost('s1');
  const win = sender(1);
  const watcher = fakeWatch();
  const emitted: SftpEditEvent[] = [];
  const opened: string[] = [];
  const closedListeners = new Set<(sender: WebContents, sessionId: string) => void>();
  const sftp = {
    session: (who: WebContents, sessionId: string) => {
      if (who.id !== win.id || sessionId !== host.session.id)
        throw new WirebenchError('sftp-session-unknown', 'No such session');
      return host.session;
    },
    onSessionClosed: (listener: (sender: WebContents, sessionId: string) => void) => {
      closedListeners.add(listener);
      return () => closedListeners.delete(listener);
    },
  };
  const service = new SftpEditService({
    sftp,
    emit: (_target, event, payload) => {
      if (event === events.sftp.edit) emitted.push(payload as SftpEditEvent);
    },
    root,
    openPath: (path) => {
      opened.push(path);
      return Promise.resolve('');
    },
    watch: watcher.watch as unknown as typeof import('node:fs').watch,
  });
  const states = (editId: string) => emitted.filter((e) => e.editId === editId).map((e) => e.state);
  const sessionClosed = () => {
    for (const listener of closedListeners) listener(win, host.session.id);
  };
  return { host, win, watcher, emitted, opened, service, states, sessionClosed };
}

/** Saves `text` into the copy and lets the debounce pass. */
async function save(ctx: ReturnType<typeof setup>, file: string, text: string): Promise<void> {
  writeFileSync(file, text);
  ctx.watcher.fire(file);
  await vi.advanceTimersByTimeAsync(500);
}

describe('SftpEditService', () => {
  it('downloads into a fresh 0700 folder under root and opens it', async () => {
    const ctx = setup();
    ctx.host.put('/etc/app.conf', 'a=1\n');
    const { editId } = await ctx.service.edit(ctx.win, { sessionId: 's1', path: '/etc/app.conf' });
    expect(ctx.opened).toHaveLength(1);
    const file = ctx.opened[0] ?? '';
    expect(basename(file)).toBe('app.conf');
    expect(dirname(dirname(file))).toBe(root);
    expect(readFileSync(file, 'utf8')).toBe('a=1\n');
    if (process.platform !== 'win32') expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(ctx.states(editId)).toEqual(['watching']);
  });

  it('refuses a name that is not a safe local name', async () => {
    const ctx = setup();
    ctx.host.put('/a/..', 'x');
    await expect(ctx.service.edit(ctx.win, { sessionId: 's1', path: '/a/..' })).rejects.toMatchObject({
      code: 'sftp-failed',
      details: { reason: 'unsafe-name' },
    });
    expect(ctx.opened).toEqual([]);
  });

  it('refuses a foreign session', async () => {
    const ctx = setup();
    ctx.host.put('/a', 'x');
    await expect(ctx.service.edit(sender(2), { sessionId: 's1', path: '/a' })).rejects.toMatchObject({
      code: 'sftp-session-unknown',
    });
  });

  it('a file over 50 MB is refused unless confirmedLarge', async () => {
    const ctx = setup();
    ctx.host.put('/big.log', 'small bytes', EDIT_ASK_ABOVE_BYTES + 1);
    await expect(ctx.service.edit(ctx.win, { sessionId: 's1', path: '/big.log' })).rejects.toMatchObject({
      code: 'sftp-edit-large',
      details: { size: EDIT_ASK_ABOVE_BYTES + 1 },
    });
    expect(ctx.opened).toEqual([]);
    await ctx.service.edit(ctx.win, { sessionId: 's1', path: '/big.log', confirmedLarge: true });
    expect(ctx.opened).toHaveLength(1);
  });

  it('a change uploads once after 500 ms of quiet, through a part file', async () => {
    const ctx = setup();
    ctx.host.put('/app.conf', 'a=1\n');
    const { editId } = await ctx.service.edit(ctx.win, { sessionId: 's1', path: '/app.conf' });
    const file = ctx.opened[0] ?? '';
    writeFileSync(file, 'a=2\n');
    ctx.watcher.fire(file);
    await vi.advanceTimersByTimeAsync(300);
    ctx.watcher.fire(file);
    await vi.advanceTimersByTimeAsync(300);
    expect(ctx.host.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => {
      expect(ctx.states(editId)).toEqual(['watching', 'uploading', 'uploaded']);
    });
    expect(ctx.host.text('/app.conf')).toBe('a=2\n');
    expect(ctx.host.writes).toEqual(['/app.conf.wirebench-part']);
    expect(ctx.host.files.has('/app.conf.wirebench-part')).toBe(false);
  });

  it('a touch with the same content uploads nothing', async () => {
    const ctx = setup();
    ctx.host.put('/app.conf', 'a=1\n');
    const { editId } = await ctx.service.edit(ctx.win, { sessionId: 's1', path: '/app.conf' });
    await save(ctx, ctx.opened[0] ?? '', 'a=1\n');
    await vi.advanceTimersByTimeAsync(50);
    expect(ctx.host.writes).toEqual([]);
    expect(ctx.states(editId)).toEqual(['watching']);
  });

  it('a remote changed since the download asks and waits; overwrite uploads', async () => {
    const ctx = setup();
    ctx.host.put('/app.conf', 'a=1\n');
    const { editId } = await ctx.service.edit(ctx.win, { sessionId: 's1', path: '/app.conf' });
    ctx.host.put('/app.conf', 'someone else\n');
    await save(ctx, ctx.opened[0] ?? '', 'mine\n');
    await vi.waitFor(() => {
      expect(ctx.states(editId)).toEqual(['watching', 'remote-changed']);
    });
    expect(ctx.host.text('/app.conf')).toBe('someone else\n');
    await ctx.service.reply(ctx.win, { editId, decision: 'overwrite' });
    await vi.waitFor(() => {
      expect(ctx.states(editId)).toEqual(['watching', 'remote-changed', 'uploading', 'uploaded']);
    });
    expect(ctx.host.text('/app.conf')).toBe('mine\n');
    // The new remote is the recorded one now: the next save goes straight up.
    await save(ctx, ctx.opened[0] ?? '', 'mine again\n');
    await vi.waitFor(() => {
      expect(ctx.host.text('/app.conf')).toBe('mine again\n');
    });
  });

  it('keep-remote stops watching and keeps the copy', async () => {
    const ctx = setup();
    ctx.host.put('/app.conf', 'a=1\n');
    const { editId } = await ctx.service.edit(ctx.win, { sessionId: 's1', path: '/app.conf' });
    const file = ctx.opened[0] ?? '';
    ctx.host.put('/app.conf', 'theirs\n');
    await save(ctx, file, 'mine\n');
    await vi.waitFor(() => {
      expect(ctx.states(editId)).toContain('remote-changed');
    });
    await ctx.service.reply(ctx.win, { editId, decision: 'keep-remote' });
    expect(ctx.watcher.closed(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('mine\n');
    expect(ctx.host.text('/app.conf')).toBe('theirs\n');
    // Ending it later still deletes the copy.
    await ctx.service.end(ctx.win, { editId });
    expect(readdirSync(root)).toEqual([]);
  });

  it('a reply with no question open, or for another window, is refused', async () => {
    const ctx = setup();
    ctx.host.put('/app.conf', 'a=1\n');
    const { editId } = await ctx.service.edit(ctx.win, { sessionId: 's1', path: '/app.conf' });
    await expect(ctx.service.reply(ctx.win, { editId, decision: 'overwrite' })).rejects.toMatchObject({
      code: 'sftp-edit-unknown',
    });
    await expect(ctx.service.reply(sender(2), { editId, decision: 'overwrite' })).rejects.toMatchObject({
      code: 'sftp-edit-unknown',
    });
  });

  it('a save during a running upload queues one more with the latest content, never two at once', async () => {
    const ctx = setup();
    ctx.host.put('/app.conf', 'v0\n');
    const { editId } = await ctx.service.edit(ctx.win, { sessionId: 's1', path: '/app.conf' });
    const file = ctx.opened[0] ?? '';
    ctx.host.hold();
    await save(ctx, file, 'v1\n');
    await vi.waitFor(() => {
      expect(ctx.host.isHeld()).toBe(true);
    });
    await save(ctx, file, 'v2\n');
    await save(ctx, file, 'v3\n');
    expect(ctx.host.writes).toEqual(['/app.conf.wirebench-part']);
    ctx.host.release();
    await vi.waitFor(() => {
      expect(ctx.host.text('/app.conf')).toBe('v3\n');
    });
    expect(ctx.host.writes).toHaveLength(2);
    expect(ctx.states(editId)).toEqual(['watching', 'uploading', 'uploaded', 'uploading', 'uploaded']);
  });

  it('a failed upload says so and removes the part file', async () => {
    const ctx = setup();
    ctx.host.put('/app.conf', 'a\n');
    const { editId } = await ctx.service.edit(ctx.win, { sessionId: 's1', path: '/app.conf' });
    ctx.host.session.rename = () => Promise.reject(new SftpError('sftp-permission-denied', 'denied', {}));
    await save(ctx, ctx.opened[0] ?? '', 'b\n');
    await vi.waitFor(() => {
      expect(ctx.states(editId)).toEqual(['watching', 'uploading', 'failed']);
    });
    expect(ctx.emitted.at(-1)?.error?.code).toBe('sftp-permission-denied');
    expect(ctx.host.files.has('/app.conf.wirebench-part')).toBe(false);
  });

  it('end stops the watcher and deletes the folder; idempotent', async () => {
    const ctx = setup();
    ctx.host.put('/app.conf', 'a\n');
    const { editId } = await ctx.service.edit(ctx.win, { sessionId: 's1', path: '/app.conf' });
    const file = ctx.opened[0] ?? '';
    await ctx.service.end(ctx.win, { editId });
    expect(ctx.watcher.closed(file)).toBe(true);
    expect(readdirSync(root)).toEqual([]);
    await ctx.service.end(ctx.win, { editId });
  });

  it('another window cannot end an edit', async () => {
    const ctx = setup();
    ctx.host.put('/app.conf', 'a\n');
    const { editId } = await ctx.service.edit(ctx.win, { sessionId: 's1', path: '/app.conf' });
    await ctx.service.end(sender(2), { editId });
    expect(readdirSync(root)).toHaveLength(1);
  });

  it('the session closing ends its edits', async () => {
    const ctx = setup();
    ctx.host.put('/app.conf', 'a\n');
    await ctx.service.edit(ctx.win, { sessionId: 's1', path: '/app.conf' });
    const file = ctx.opened[0] ?? '';
    ctx.sessionClosed();
    await vi.waitFor(() => {
      expect(readdirSync(root)).toEqual([]);
    });
    expect(ctx.watcher.closed(file)).toBe(true);
  });

  it('disposeFor ends the window’s edits and deletes the copies', async () => {
    const ctx = setup();
    ctx.host.put('/a.conf', 'a\n');
    ctx.host.put('/b.conf', 'b\n');
    await ctx.service.edit(ctx.win, { sessionId: 's1', path: '/a.conf' });
    await ctx.service.edit(ctx.win, { sessionId: 's1', path: '/b.conf' });
    expect(readdirSync(root)).toHaveLength(2);
    await ctx.service.disposeFor(ctx.win);
    expect(readdirSync(root)).toEqual([]);
    expect(ctx.host.writes).toEqual([]);
  });

  it('a failure to open the copy ends the edit and says why', async () => {
    const ctx = setup();
    ctx.host.put('/app.conf', 'a\n');
    const service = new SftpEditService({
      sftp: {
        session: () => ctx.host.session,
        onSessionClosed: () => () => undefined,
      },
      emit: () => undefined,
      root,
      openPath: () => Promise.resolve('No application knows how to open this file'),
      watch: ctx.watcher.watch as unknown as typeof import('node:fs').watch,
    });
    await expect(service.edit(ctx.win, { sessionId: 's1', path: '/app.conf' })).rejects.toMatchObject({
      code: 'sftp-edit-open-failed',
    });
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('sweepEditCopies', () => {
  it('an edit waits for the start-up sweep, so its copy survives it', async () => {
    await mkdir(join(root, 'edit-left-over'), { recursive: true });
    const ctx = setup();
    ctx.host.put('/app.conf', 'a\n');
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const service = new SftpEditService({
      sftp: { session: () => ctx.host.session, onSessionClosed: () => () => undefined },
      emit: () => undefined,
      root,
      openPath: () => Promise.resolve(''),
      watch: ctx.watcher.watch as unknown as typeof import('node:fs').watch,
      swept: gate.then(() => sweepEditCopies(root)),
    });
    const editing = service.edit(ctx.win, { sessionId: 's1', path: '/app.conf' });
    finish();
    await editing;
    expect(readdirSync(root)).toHaveLength(1);
    expect(readdirSync(root)[0]).not.toBe('edit-left-over');
  });

  it('empties root, and is fine when it is missing', async () => {
    await mkdir(join(root, 'x'), { recursive: true });
    await writeFile(join(root, 'x', 'f'), 'left over');
    await sweepEditCopies(root);
    expect(() => readdirSync(root)).toThrow();
    await sweepEditCopies(root);
  });
});
