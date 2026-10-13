import { randomUUID } from 'node:crypto';
import { lstat, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import { Transform } from 'node:stream';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { WebContents } from 'electron';
import { WirebenchError } from '@wirebench/engine';
import { joinRemote } from '@wirebench/ssh';
import type { SftpSession } from '@wirebench/ssh';
import { events } from '../shared/ipc.js';
import { PART_SUFFIX, PROGRESS_EVENTS_PER_SECOND, TRANSFER_CONCURRENCY } from '../shared/sftp-defaults.js';
import type {
  ConflictDecisionWire,
  SftpCopyRequest,
  SftpEntryWire,
  SftpPlaceWire,
  SftpResolveRequest,
  TransferStateWire,
} from '../shared/sftp-wire.js';
import { asWirebenchError } from './hosts-service.js';
import { localEntry, localFsError, localList, localMkdir, localReadStream, localWriteStream } from './local-fs.js';
import { keepBothName, safeLocalName, safeRemoteName } from './safe-name.js';
import type { SftpService } from './sftp-service.js';
import type { SshServiceDeps } from './ssh-service.js';

/** One side of a copy, this machine or one SFTP session, as the queue needs it. */
export interface PlaceFs {
  /** `local`, or the session id: two places with one key are the same file system. */
  readonly key: string;
  readonly local: boolean;
  /** The entry itself (a symlink is not followed), or `undefined` when nothing is there. */
  lstat(path: string): Promise<SftpEntryWire | undefined>;
  list(path: string): Promise<readonly SftpEntryWire[]>;
  mkdir(path: string): Promise<void>;
  /** Moves a finished part file onto its target; only with `replace` may the target already exist. */
  commit(part: string, target: string, replace: boolean): Promise<void>;
  removeFile(path: string): Promise<void>;
  readStream(path: string): Readable;
  writeStream(path: string, mode: number | undefined): Writable;
  /** Throws for a name that is not a single path part. */
  join(dir: string, name: string): string;
  /** `inner` is `outer` or below it. */
  within(inner: string, outer: string): boolean;
}

const isNotFound = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'sftp-not-found';

const withinBy =
  (path: { relative(from: string, to: string): string; isAbsolute(path: string): boolean }, separator: string) =>
  (inner: string, outer: string): boolean => {
    const rel = path.relative(outer, inner);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${separator}`) && !path.isAbsolute(rel));
  };

/** A host's side, through the window's own session. */
export function remotePlace(session: SftpSession): PlaceFs {
  return {
    key: session.id,
    local: false,
    lstat: async (path) => {
      try {
        return await session.stat(path);
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },
    list: (path) => session.list(path),
    mkdir: (path) => session.mkdir(path),
    // Servers differ on renaming onto an existing name, so a replace removes the old file first; the new
    // content is complete in the part file by then, so only that last step can leave the target missing.
    commit: async (part, target, replace) => {
      if (replace) {
        await session.remove(target, { recursive: false }).catch((error: unknown) => {
          if (!isNotFound(error)) throw error;
        });
      }
      await session.rename(part, target);
    },
    removeFile: (path) => session.remove(path, { recursive: false }),
    readStream: (path) => session.readStream(path),
    writeStream: (path, mode) => session.writeStream(path, mode === undefined ? {} : { mode }),
    join: (dir, name) => joinRemote(dir, name),
    within: withinBy(posix, '/'),
  };
}

/** This machine's side: paths as given (spec R5). */
export function localPlace(): PlaceFs {
  return {
    key: 'local',
    local: true,
    lstat: localEntry,
    list: async (path) => (await localList(path)).entries,
    mkdir: localMkdir,
    commit: async (part, target, replace) => {
      if (!replace) {
        const taken = await lstat(target).then(
          () => true,
          () => false,
        );
        if (taken) {
          throw new WirebenchError('sftp-exists', `${target} already exists`, { details: { path: target } });
        }
      }
      try {
        await rename(part, target);
      } catch (error) {
        throw localFsError(error, 'rename', part);
      }
    },
    removeFile: async (path) => {
      try {
        await rm(path, { force: true });
      } catch (error) {
        throw localFsError(error, 'remove', path);
      }
    },
    readStream: localReadStream,
    writeStream: (path) => localWriteStream(path),
    join: (dir, name) => join(dir, safeLocalName(name)),
    within: withinBy({ relative, isAbsolute }, sep),
  };
}

interface ErrorWire {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** A failure as the event carries it: a code, a message and details; never a file's content. */
export function errorWire(error: unknown): ErrorWire {
  let known = asWirebenchError(error);
  const errno = (known as NodeJS.ErrnoException | null)?.code;
  if (!(known instanceof WirebenchError) && typeof errno === 'string' && /^E[A-Z]+$/.test(errno)) {
    known = localFsError(known, 'write', (known as NodeJS.ErrnoException).path ?? '');
  }
  if (known instanceof WirebenchError) {
    return { code: known.code, message: known.message, ...(known.details ? { details: { ...known.details } } : {}) };
  }
  return { code: 'sftp-failed', message: known instanceof Error ? known.message : 'The transfer failed' };
}

const FINAL: ReadonlySet<TransferStateWire> = new Set(['done', 'failed', 'cancelled', 'skipped']);

/** One thing the walk found: a file to copy, an entry it skips (a folder symlink), or a name it refused. */
interface Item {
  readonly kind: 'file' | 'skip' | 'fail';
  /** Under the target folder, `/`-separated. */
  readonly name: string;
  readonly source: string;
  readonly targetDir: string;
  readonly targetName: string;
  readonly size: number;
  readonly mtime: number;
  readonly mode?: number;
  readonly error?: unknown;
}

interface Transfer {
  readonly id: string;
  readonly batch: Batch;
  readonly item: Item;
  state: TransferStateWire;
  done: number;
  total: number;
  bytesPerSecond: number;
  error?: ErrorWire;
  /** Why the current run is ending early: the user cancelled, or its session went. */
  stop?: { readonly cancel: true } | { readonly cancel: false; readonly error: unknown };
  controller?: AbortController;
  /** Set while the conflict question for this transfer is open. */
  answer?: (decision: ConflictDecisionWire | undefined) => void;
  /** Waiting for an earlier question of the batch to be answered. */
  inLine: boolean;
  startedAt: number;
  lastProgress: number;
}

interface BatchDir {
  readonly path: string;
  /** The parent, when the batch makes that folder too. */
  readonly parent?: string;
}

interface Batch {
  readonly id: string;
  readonly from: SftpPlaceWire;
  readonly to: SftpPlaceWire;
  /** Target folders, parents before children. */
  readonly dirs: readonly BatchDir[];
  readonly transfers: Transfer[];
  /** Folder creations, once each; a failed one is dropped so a retry tries again. */
  readonly made: Map<string, Promise<void>>;
  /** Transfers whose target existed when the batch started and that have not been asked yet. */
  readonly expected: Set<Transfer>;
  prepared?: Promise<void>;
  /** An answer given "for the rest". */
  rule?: ConflictDecisionWire;
  /** One question at a time: the tail of the batch's questions. */
  asking: Promise<void>;
  current?: Transfer;
}

interface Window {
  readonly sender: WebContents;
  readonly transfers: Map<string, Transfer>;
  readonly batches: Map<string, Batch>;
  /** Waiting to run, oldest first. */
  readonly queue: Transfer[];
  /** Targets being written, by place and path: a second transfer to one waits for the first. */
  readonly targets: Map<string, Promise<void>>;
  running: number;
  disposed: boolean;
}

interface Walk {
  readonly from: PlaceFs;
  readonly to: PlaceFs;
  readonly items: Item[];
  readonly dirs: BatchDir[];
}

export interface TransferQueueDeps {
  readonly sftp: Pick<SftpService, 'session' | 'onSessionClosed'>;
  readonly emit: SshServiceDeps['emit'];
  readonly now?: () => number;
  readonly concurrency?: number;
  /** Tests replace this machine's side. */
  readonly local?: PlaceFs;
}

/** Thrown inside a run that was cancelled or lost its session; the run's catch reads why from `stop`. */
const STOPPED = new Error('stopped');

/**
 * The Files tab's copies (spec D3), a queue per window. A batch is walked when it arrives (folders depth
 * first, folder symlinks skipped, refused names failed); each file is one transfer, three run at a time.
 * Every write goes to `<name>.wirebench-part` and is renamed at the end, so a failure or a cancel leaves
 * an existing target as it was and removes the part file. A clash asks the window (`sftp.conflict`), one
 * question per batch at a time, until an answer is given for the rest.
 */
export class TransferQueue {
  private readonly windows = new Map<number, Window>();
  private readonly local: PlaceFs;
  private readonly now: () => number;
  private readonly concurrency: number;

  constructor(private readonly deps: TransferQueueDeps) {
    this.local = deps.local ?? localPlace();
    this.now = deps.now ?? Date.now;
    this.concurrency = deps.concurrency ?? TRANSFER_CONCURRENCY;
    deps.sftp.onSessionClosed((sender, sessionId) => {
      this.sessionClosed(sender, sessionId);
    });
  }

  /**
   * Walks the batch and queues its files; answers once the walk is done, before anything is written.
   *
   * @throws WirebenchError `sftp-session-unknown` | `sftp-failed` `{ reason: 'into-itself' }` | a source
   *   that cannot be read (`sftp-not-found`, `local-fs-failed`, …)
   */
  async copy(sender: WebContents, request: SftpCopyRequest): Promise<{ transferIds: string[] }> {
    const from = this.place(sender, request.from.place);
    const to = this.place(sender, request.to.place);
    const sources: { path: string; entry: SftpEntryWire }[] = [];
    for (const path of request.from.paths) {
      const entry = await wirebench(() => from.lstat(path));
      if (!entry) {
        throw new WirebenchError(from.local ? 'local-fs-failed' : 'sftp-not-found', `${path} does not exist`, {
          details: { path, op: 'stat', ...(from.local ? { errno: 'ENOENT' } : {}) },
        });
      }
      if (entry.type === 'dir' && from.key === to.key && to.within(request.to.dir, path)) {
        throw new WirebenchError('sftp-failed', `${path} cannot be copied into itself`, {
          details: { path, op: 'copy', reason: 'into-itself' },
        });
      }
      sources.push({ path, entry });
    }
    const walk: Walk = { from, to, items: [], dirs: [] };
    for (const { path, entry } of sources) await this.walk(walk, entry, path, request.to.dir, entry.name);

    const win = this.windowOf(sender);
    const batch: Batch = {
      id: request.batchId,
      from: request.from.place,
      to: request.to.place,
      dirs: walk.dirs,
      transfers: [],
      made: new Map(),
      expected: new Set(),
      asking: Promise.resolve(),
    };
    win.batches.set(batch.id, batch);
    for (const item of walk.items) {
      const transfer: Transfer = {
        id: randomUUID(),
        batch,
        item,
        state: item.kind === 'file' ? 'queued' : item.kind === 'skip' ? 'skipped' : 'failed',
        done: 0,
        total: item.size,
        bytesPerSecond: 0,
        ...(item.kind === 'fail' ? { error: errorWire(item.error) } : {}),
        inLine: false,
        startedAt: 0,
        lastProgress: 0,
      };
      batch.transfers.push(transfer);
      win.transfers.set(transfer.id, transfer);
      if (transfer.state === 'queued') win.queue.push(transfer);
      this.send(win, transfer);
    }
    // Folders with nothing to copy in them are still made.
    if (!batch.transfers.some((t) => t.state === 'queued')) void this.prepare(batch, to);
    this.pump(win);
    return { transferIds: batch.transfers.map((t) => t.id) };
  }

  /** Answers the batch's open question; `applyToRest` answers its later clashes too. A stale answer is ignored. */
  resolve(sender: WebContents, request: SftpResolveRequest): void {
    const batch = this.windows.get(sender.id)?.batches.get(request.batchId);
    const current = batch?.current;
    if (!batch || !current) return;
    if (request.applyToRest) batch.rule = request.decision;
    current.answer?.(request.decision);
  }

  /** Idempotent; a finished transfer is left as it is. */
  cancel(sender: WebContents, request: { transferId: string }): void {
    const win = this.windows.get(sender.id);
    const transfer = win?.transfers.get(request.transferId);
    if (!win || !transfer || FINAL.has(transfer.state)) return;
    if (transfer.state === 'queued') {
      win.queue.splice(win.queue.indexOf(transfer), 1);
      this.setState(win, transfer, 'cancelled');
      return;
    }
    this.stop(transfer, { cancel: true });
  }

  /** A failed or cancelled transfer starts over (its clash is checked again); anything else is left. */
  retry(sender: WebContents, request: { transferId: string }): void {
    const win = this.windows.get(sender.id);
    const transfer = win?.transfers.get(request.transferId);
    if (!win || !transfer || (transfer.state !== 'failed' && transfer.state !== 'cancelled')) return;
    transfer.done = 0;
    transfer.total = transfer.item.size;
    transfer.bytesPerSecond = 0;
    delete transfer.error;
    delete transfer.stop;
    win.queue.push(transfer);
    this.setState(win, transfer, 'queued');
    this.pump(win);
  }

  /**
   * The window went away, reloaded or switched workspace: every transfer stops, each part file is removed,
   * and nothing more is sent to it.
   */
  disposeFor(sender: WebContents): void {
    const win = this.windows.get(sender.id);
    if (!win) return;
    win.disposed = true;
    this.windows.delete(sender.id);
    win.queue.length = 0;
    for (const transfer of win.transfers.values()) {
      if (!FINAL.has(transfer.state)) this.stop(transfer, { cancel: true });
    }
  }

  /** Quit: every window's transfers stop. */
  disposeAll(): void {
    for (const win of [...this.windows.values()]) this.disposeFor(win.sender);
  }

  private sessionClosed(sender: WebContents, sessionId: string): void {
    const win = this.windows.get(sender.id);
    if (!win) return;
    const error = new WirebenchError('ssh-session-closed', 'The session closed');
    const uses = (place: SftpPlaceWire) => place.kind === 'remote' && place.sessionId === sessionId;
    for (const transfer of win.transfers.values()) {
      if (FINAL.has(transfer.state) || !(uses(transfer.batch.from) || uses(transfer.batch.to))) continue;
      if (transfer.state === 'queued') {
        win.queue.splice(win.queue.indexOf(transfer), 1);
        transfer.error = errorWire(error);
        this.setState(win, transfer, 'failed');
      } else {
        this.stop(transfer, { cancel: false, error });
      }
    }
  }

  private stop(transfer: Transfer, why: NonNullable<Transfer['stop']>): void {
    transfer.stop ??= why;
    transfer.controller?.abort();
    transfer.answer?.(undefined);
  }

  /** @throws WirebenchError `sftp-session-unknown` */
  private place(sender: WebContents, place: SftpPlaceWire): PlaceFs {
    if (place.kind === 'local') return this.local;
    try {
      return remotePlace(this.deps.sftp.session(sender, place.sessionId));
    } catch (error) {
      throw asWirebenchError(error);
    }
  }

  private async walk(
    walk: Walk,
    entry: SftpEntryWire,
    source: string,
    targetDir: string,
    name: string,
    parent?: string,
  ): Promise<void> {
    const { from, to, items, dirs } = walk;
    const base = { name, source, targetDir, size: entry.size, mtime: entry.mtime };
    let targetName: string;
    try {
      // A name from the other side becomes a path part here only once it is known to be one (spec D9).
      targetName = to.local ? safeLocalName(entry.name) : safeRemoteName(entry.name);
    } catch (error) {
      items.push({ ...base, kind: 'fail', targetName: entry.name, error });
      return;
    }
    if (entry.type === 'dir') {
      const dir = to.join(targetDir, targetName);
      dirs.push(parent === undefined ? { path: dir } : { path: dir, parent });
      let children: readonly SftpEntryWire[];
      try {
        children = await from.list(source);
      } catch (error) {
        items.push({ ...base, kind: 'fail', targetName, error });
        return;
      }
      for (const child of children) {
        const childName = `${name}/${child.name}`;
        let childSource: string;
        try {
          childSource = from.join(source, child.name);
        } catch (error) {
          items.push({ ...base, name: childName, kind: 'fail', targetName: child.name, error });
          continue;
        }
        await this.walk(walk, child, childSource, dir, childName, dir);
      }
      return;
    }
    // A symlink to a file is followed; one to a folder is never walked (no loops), nor is anything else.
    const file = entry.type === 'file' || (entry.type === 'symlink' && entry.targetType === 'file');
    items.push({
      ...base,
      kind: file ? 'file' : 'skip',
      targetName,
      ...(entry.mode === undefined ? {} : { mode: entry.mode }),
    });
  }

  private windowOf(sender: WebContents): Window {
    const existing = this.windows.get(sender.id);
    if (existing) return existing;
    const win: Window = {
      sender,
      transfers: new Map(),
      batches: new Map(),
      queue: [],
      targets: new Map(),
      running: 0,
      disposed: false,
    };
    this.windows.set(sender.id, win);
    sender.once('destroyed', () => {
      if (this.windows.get(sender.id) === win) this.disposeFor(sender);
    });
    return win;
  }

  private pump(win: Window): void {
    while (!win.disposed && win.running < this.concurrency) {
      const next = win.queue.shift();
      if (!next) return;
      win.running += 1;
      this.setState(win, next, 'running');
      void this.run(win, next).finally(() => {
        win.running -= 1;
        this.pump(win);
      });
    }
  }

  /** Makes the batch's folders, parents first, and notes which targets already exist. Once per batch; never rejects. */
  private prepare(batch: Batch, to: PlaceFs): Promise<void> {
    batch.prepared ??= (async () => {
      for (const dir of batch.dirs) await this.ensureDir(batch, to, dir.path).catch(() => undefined);
      // One listing per target folder, not one stat per file.
      const listings = new Map<string, Promise<Set<string>>>();
      const names = (dir: string): Promise<Set<string>> => {
        let listing = listings.get(dir);
        if (!listing) {
          listing = to.list(dir).then(
            (entries) => new Set(entries.map((e) => e.name)),
            () => new Set<string>(),
          );
          listings.set(dir, listing);
        }
        return listing;
      };
      for (const transfer of batch.transfers) {
        const { item } = transfer;
        if (item.kind !== 'file' || FINAL.has(transfer.state)) continue;
        if ((await names(item.targetDir)).has(item.targetName)) batch.expected.add(transfer);
      }
    })();
    return batch.prepared;
  }

  /** The folder exists (made, or already there as a folder); a parent of the batch's is made first. */
  private ensureDir(batch: Batch, to: PlaceFs, path: string): Promise<void> {
    const dir = batch.dirs.find((d) => d.path === path);
    if (!dir) return Promise.resolve();
    let made = batch.made.get(path);
    if (!made) {
      made = (async () => {
        if (dir.parent !== undefined) await this.ensureDir(batch, to, dir.parent);
        const existing = await to.lstat(path);
        if (!existing) await to.mkdir(path);
        else if (existing.type !== 'dir' && existing.targetType !== 'dir') {
          throw new WirebenchError('sftp-exists', `${path} exists and is not a folder`, {
            details: { path, op: 'mkdir' },
          });
        }
      })();
      batch.made.set(path, made);
      made.catch(() => {
        batch.made.delete(path);
      });
    }
    return made;
  }

  /** Waits for any other transfer writing `path` in that place, then holds it; returns the release. */
  private async claim(win: Window, to: PlaceFs, path: string): Promise<() => void> {
    const key = `${to.key}\0${path}`;
    for (let held = win.targets.get(key); held; held = win.targets.get(key)) await held;
    let release!: () => void;
    win.targets.set(
      key,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return () => {
      win.targets.delete(key);
      release();
    };
  }

  private async run(win: Window, transfer: Transfer): Promise<void> {
    const { batch, item } = transfer;
    const stopped = (): void => {
      if (transfer.stop) throw STOPPED;
    };
    let to: PlaceFs | undefined;
    let part: string | undefined;
    let release: (() => void) | undefined;
    try {
      if (item.kind === 'fail') throw item.error;
      const from = this.place(win.sender, batch.from);
      const place = this.place(win.sender, batch.to);
      to = place;
      await this.prepare(batch, place);
      stopped();
      await this.ensureDir(batch, place, item.targetDir);
      stopped();
      let target = place.join(item.targetDir, item.targetName);
      // One transfer per target at a time, so the same name twice in a batch clashes the second time.
      release = await this.claim(win, place, target);
      stopped();
      const existing = await place.lstat(target);
      let replace = false;
      if (existing) {
        const decision = await this.decide(win, transfer, existing);
        if (decision === 'skip') {
          this.setState(win, transfer, 'skipped');
          return;
        }
        if (decision === 'replace') {
          replace = true;
        } else {
          const name = await keepBothName(item.targetName, async (candidate) => {
            const path = place.join(item.targetDir, candidate);
            return win.targets.has(`${place.key}\0${path}`) || (await place.lstat(path)) !== undefined;
          });
          const previous = release;
          target = place.join(item.targetDir, name);
          release = await this.claim(win, place, target);
          previous();
        }
      }
      batch.expected.delete(transfer);
      stopped();

      const controller = new AbortController();
      transfer.controller = controller;
      transfer.startedAt = this.now();
      transfer.lastProgress = transfer.startedAt;
      part = `${target}${PART_SUFFIX}`;
      // An upload keeps the local permission bits; a download takes this machine's default (umask).
      const mode = from.local && !place.local ? item.mode : undefined;
      await pipeline(from.readStream(item.source), this.meter(win, transfer), place.writeStream(part, mode), {
        signal: controller.signal,
      });
      stopped();
      await place.commit(part, target, replace);
      part = undefined;
      this.setState(win, transfer, 'done');
    } catch (error) {
      if (part !== undefined && to) await to.removeFile(part).catch(() => undefined);
      const stop = transfer.stop;
      if (stop?.cancel) {
        this.setState(win, transfer, 'cancelled');
      } else {
        transfer.error = errorWire(stop ? stop.error : error);
        this.setState(win, transfer, 'failed');
      }
    } finally {
      batch.expected.delete(transfer);
      delete transfer.controller;
      release?.();
    }
  }

  /** The batch's standing answer, or the window's: one question per batch at a time. Dismissed is Skip. */
  private async decide(win: Window, transfer: Transfer, existing: SftpEntryWire): Promise<ConflictDecisionWire> {
    const { batch, item } = transfer;
    if (batch.rule) return batch.rule;
    transfer.inLine = true;
    const previous = batch.asking;
    let asked!: () => void;
    batch.asking = new Promise<void>((resolve) => {
      asked = resolve;
    });
    try {
      await previous;
      transfer.inLine = false;
      if (batch.rule) return batch.rule;
      if (transfer.stop) throw STOPPED;
      const answer = new Promise<ConflictDecisionWire | undefined>((resolve) => {
        transfer.answer = resolve;
      });
      batch.current = transfer;
      batch.expected.delete(transfer);
      this.setState(win, transfer, 'waiting');
      if (!win.disposed && !win.sender.isDestroyed()) {
        this.deps.emit(win.sender, events.sftp.conflict, {
          batchId: batch.id,
          transferId: transfer.id,
          name: item.name,
          existing: { size: existing.size, mtime: existing.mtime },
          incoming: { size: item.size, mtime: item.mtime },
          remaining: batch.transfers.filter(
            (t) => t !== transfer && !FINAL.has(t.state) && (batch.expected.has(t) || t.inLine),
          ).length,
        });
      }
      const decision = await answer;
      if (transfer.stop) throw STOPPED;
      this.setState(win, transfer, 'running');
      return decision ?? 'skip';
    } finally {
      transfer.inLine = false;
      delete transfer.answer;
      if (batch.current === transfer) delete batch.current;
      asked();
    }
  }

  /** Counts bytes through; a progress event at most {@link PROGRESS_EVENTS_PER_SECOND} times a second. */
  private meter(win: Window, transfer: Transfer): Transform {
    const gap = 1000 / PROGRESS_EVENTS_PER_SECOND;
    return new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        transfer.done += chunk.length;
        transfer.total = Math.max(transfer.total, transfer.done);
        const now = this.now();
        transfer.bytesPerSecond = Math.round((transfer.done * 1000) / Math.max(1, now - transfer.startedAt));
        if (now - transfer.lastProgress >= gap) {
          transfer.lastProgress = now;
          this.send(win, transfer);
        }
        callback(null, chunk);
      },
    });
  }

  private setState(win: Window, transfer: Transfer, state: TransferStateWire): void {
    transfer.state = state;
    this.send(win, transfer);
  }

  private send(win: Window, transfer: Transfer): void {
    if (win.disposed || win.sender.isDestroyed()) return;
    this.deps.emit(win.sender, events.sftp.transfer, {
      transferId: transfer.id,
      batchId: transfer.batch.id,
      name: transfer.item.name,
      state: transfer.state,
      done: transfer.done,
      total: transfer.total,
      bytesPerSecond: transfer.bytesPerSecond,
      ...(transfer.error ? { error: transfer.error } : {}),
    });
  }
}

/** Runs `read`, turning a package error into a `WirebenchError`. */
async function wirebench<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw asWirebenchError(error);
  }
}
