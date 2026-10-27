import type { Caller } from './host/platform.js';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, watch as fsWatch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WirebenchError } from '@wirebench/engine';
import type { SftpSession } from '@wirebench/ssh';
import { events } from '@wirebench/wire/ipc';
import { EDIT_ASK_ABOVE_BYTES, EDIT_DEBOUNCE_MS, PART_SUFFIX } from '@wirebench/wire/sftp-defaults';
import type { SftpEditEvent, SftpEditReplyRequest, SftpEditRequest } from '@wirebench/wire/sftp-wire';
import { asWirebenchError } from './hosts-service.js';
import { safeLocalName } from './safe-name.js';
import type { SftpService } from './sftp-service.js';
import type { SshServiceDeps } from './ssh-service.js';
import { errorWire, remotePlace } from './transfers.js';

export interface SftpEditDeps {
  readonly sftp: Pick<SftpService, 'session' | 'onSessionClosed'>;
  readonly emit: SshServiceDeps['emit'];
  /** `userData/sftp-edit` */
  readonly root: string;
  /** `shell.openPath`: `''` on success, else the OS's message. */
  readonly openPath: (path: string) => Promise<string>;
  /** The start-up {@link sweepEditCopies}: an edit waits for it, so it never sweeps a new copy. */
  readonly swept?: Promise<void>;
  /** Tests inject a controllable watcher. */
  readonly watch?: typeof fsWatch;
}

interface Edit {
  readonly id: string;
  readonly sender: Caller;
  readonly sessionId: string;
  readonly session: SftpSession;
  /** The server's real path: a symlink is edited at its target, never replaced by a file. */
  readonly remotePath: string;
  readonly mode: number | undefined;
  /** The `0700` folder holding the copy. */
  readonly dir: string;
  readonly file: string;
  /** What the remote held when last downloaded or uploaded; a difference means someone else wrote it. */
  remote: { size: number; mtime: number };
  /** The content last downloaded or uploaded: a save that matches it uploads nothing. */
  hash: string;
  watcher: FSWatcher | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** An upload is running; a save meanwhile sets {@link again}. */
  busy: boolean;
  again: boolean;
  /** `remote-changed` is waiting for `sftp.editReply`. */
  asking: boolean;
  ended: boolean;
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/**
 * Editing a remote file in the system editor (spec D4). The file is downloaded into a fresh `0700` folder
 * under `root` and opened with the OS's default app; each save, once quiet for `EDIT_DEBOUNCE_MS`, is
 * uploaded through a part file. A remote that changed since is asked about, never overwritten silently.
 * Edits belong to the window and the SFTP session they were started in: either going ends them and
 * deletes the copies. Events carry states only, never the file's content.
 */
export class SftpEditService {
  private readonly edits = new Map<string, Edit>();

  constructor(private readonly deps: SftpEditDeps) {
    deps.sftp.onSessionClosed((sender, sessionId) => {
      for (const edit of [...this.edits.values()]) {
        if (edit.sender.id === sender.id && edit.sessionId === sessionId) void this.finish(edit);
      }
    });
  }

  /**
   * @throws WirebenchError `sftp-session-unknown` | `sftp-edit-large` `{ path, size }` without
   *   `confirmedLarge` | `sftp-failed` `{ reason: 'not-a-file' | 'unsafe-name' }` | `sftp-edit-open-failed` |
   *   another `sftp-*` | `local-fs-failed`
   */
  async edit(sender: Caller, request: SftpEditRequest): Promise<{ editId: string }> {
    const session = this.deps.sftp.session(sender, request.sessionId);
    const remotePath = await session.realpath(request.path).catch((error: unknown) => {
      throw asWirebenchError(error);
    });
    const entry = await session.stat(remotePath).catch((error: unknown) => {
      throw asWirebenchError(error);
    });
    if (entry.type !== 'file') {
      throw new WirebenchError('sftp-failed', `${request.path} is not a file`, {
        details: { path: request.path, reason: 'not-a-file' },
      });
    }
    if (entry.size > EDIT_ASK_ABOVE_BYTES && request.confirmedLarge !== true) {
      throw new WirebenchError('sftp-edit-large', `${request.path} is larger than 50 MB`, {
        details: { path: request.path, size: entry.size },
      });
    }
    // A name from the host becomes a path part here only once it is known to be one (spec D9).
    const name = safeLocalName(posix.basename(remotePath));
    await this.deps.swept;
    await mkdir(this.deps.root, { recursive: true, mode: 0o700 });
    // `mkdtemp` makes the folder `0700`: the copy is readable by this user only.
    const dir = await mkdtemp(join(this.deps.root, 'edit-'));
    const edit: Edit = {
      id: randomUUID(),
      sender,
      sessionId: request.sessionId,
      session,
      remotePath,
      mode: entry.mode,
      dir,
      file: join(dir, name),
      remote: { size: entry.size, mtime: entry.mtime },
      hash: '',
      watcher: undefined,
      timer: undefined,
      busy: false,
      again: false,
      asking: false,
      ended: false,
    };
    this.edits.set(edit.id, edit);
    try {
      await pipeline(session.readStream(remotePath), createWriteStream(edit.file, { mode: 0o600 }));
      edit.hash = sha256(await readFile(edit.file));
      // The folder, not the file: editors that save by writing a new file and renaming it over the old
      // one would leave a file watcher on the gone original.
      const watcher = (this.deps.watch ?? fsWatch)(dir, (_event, filename) => {
        if (filename === null || filename === name) this.changed(edit);
      });
      watcher.on('error', () => {
        this.stopWatching(edit);
      });
      edit.watcher = watcher;
      if (edit.ended) throw new WirebenchError('ssh-session-closed', 'The session closed before the file opened');
      const failure = await this.deps.openPath(edit.file);
      if (failure !== '') {
        throw new WirebenchError('sftp-edit-open-failed', failure, { details: { path: request.path } });
      }
    } catch (error) {
      await this.finish(edit);
      throw asWirebenchError(error);
    }
    this.send(edit, { editId: edit.id, state: 'watching' });
    return { editId: edit.id };
  }

  /**
   * Answers `remote-changed`: `overwrite` uploads the copy as it is now; `keep-remote` stops watching and
   * leaves the copy until the edit ends.
   *
   * @throws WirebenchError `sftp-edit-unknown` when no question is open for this window's edit
   */
  reply(sender: Caller, request: SftpEditReplyRequest): Promise<void> {
    const edit = this.own(sender, request.editId);
    if (!edit?.asking) return Promise.reject(new WirebenchError('sftp-edit-unknown', 'No such edit is asking'));
    edit.asking = false;
    if (request.decision === 'overwrite') void this.save(edit, true);
    else this.stopWatching(edit);
    return Promise.resolve();
  }

  /** Stops watching and deletes the copy. Idempotent; another window's edit is left as it is. */
  async end(sender: Caller, request: { editId: string }): Promise<void> {
    const edit = this.own(sender, request.editId);
    if (edit) await this.finish(edit);
  }

  /** The window went away, reloaded or switched workspace: its edits end and their copies go. */
  async disposeFor(sender: Caller): Promise<void> {
    await Promise.all([...this.edits.values()].filter((e) => e.sender.id === sender.id).map((e) => this.finish(e)));
  }

  /** Quit: every edit ends (start-up sweeps whatever the quit leaves behind). */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.edits.values()].map((e) => this.finish(e)));
  }

  private own(sender: Caller, editId: string): Edit | undefined {
    const edit = this.edits.get(editId);
    return edit?.sender.id === sender.id ? edit : undefined;
  }

  private changed(edit: Edit): void {
    if (edit.ended || edit.asking) return;
    if (edit.timer !== undefined) clearTimeout(edit.timer);
    edit.timer = setTimeout(() => {
      edit.timer = undefined;
      void this.save(edit, false);
    }, EDIT_DEBOUNCE_MS);
  }

  /** One upload at a time per edit; a save meanwhile runs once more afterwards with the latest content. */
  private async save(edit: Edit, overwrite: boolean): Promise<void> {
    if (edit.busy) {
      edit.again = true;
      return;
    }
    edit.busy = true;
    try {
      let force = overwrite;
      do {
        edit.again = false;
        await this.uploadOnce(edit, force);
        force = false;
      } while (edit.again && !edit.ended && !edit.asking);
    } finally {
      edit.busy = false;
    }
  }

  private async uploadOnce(edit: Edit, overwrite: boolean): Promise<void> {
    if (edit.ended) return;
    const part = `${edit.remotePath}${PART_SUFFIX}`;
    let wrote = false;
    try {
      const data = await readFile(edit.file);
      const hash = sha256(data);
      if (hash === edit.hash) return;
      if (!overwrite) {
        const now = await edit.session.stat(edit.remotePath);
        if (now.size !== edit.remote.size || now.mtime !== edit.remote.mtime) {
          edit.asking = true;
          this.send(edit, { editId: edit.id, state: 'remote-changed' });
          return;
        }
      }
      this.send(edit, { editId: edit.id, state: 'uploading' });
      wrote = true;
      await pipeline(
        Readable.from([data]),
        edit.session.writeStream(part, edit.mode === undefined ? {} : { mode: edit.mode }),
      );
      await remotePlace(edit.session).commit(part, edit.remotePath, true);
      wrote = false;
      const after = await edit.session.stat(edit.remotePath);
      edit.remote = { size: after.size, mtime: after.mtime };
      edit.hash = hash;
      this.send(edit, { editId: edit.id, state: 'uploaded' });
    } catch (error) {
      if (wrote) await edit.session.remove(part, { recursive: false }).catch(() => undefined);
      // The copy vanished mid-save (an editor's rename): the next event brings it back.
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return;
      this.send(edit, { editId: edit.id, state: 'failed', error: errorWire(error) });
    }
  }

  private stopWatching(edit: Edit): void {
    if (edit.timer !== undefined) clearTimeout(edit.timer);
    edit.timer = undefined;
    edit.watcher?.close();
    edit.watcher = undefined;
  }

  private async finish(edit: Edit): Promise<void> {
    edit.ended = true;
    this.stopWatching(edit);
    this.edits.delete(edit.id);
    await rm(edit.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  private send(edit: Edit, payload: SftpEditEvent): void {
    if (edit.ended || edit.sender.isClosed()) return;
    this.deps.emit(edit.sender, events.sftp.edit, payload);
  }
}

/** Removes everything under `root` (copies a crash left behind); once at start-up. */
export async function sweepEditCopies(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
