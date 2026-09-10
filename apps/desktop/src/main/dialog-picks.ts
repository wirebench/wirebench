import { resolve } from 'node:path';

/**
 * Session-only memory of the absolute paths the user has explicitly chosen through a native
 * dialog this session — the Dump File "Browse…" Save-as picker (`dialogs.saveFile`) and the
 * attachments "Add" picker (`attachments.pickFiles`).
 *
 * It exists because main has exactly two kinds of evidence that a path is safe to touch: the
 * path is contained inside the open project folder, or the *user* drove an OS dialog to it.
 * A path that merely arrived over IPC has neither — a compromised or buggy renderer can name
 * any string it likes — so every main-side check that turns renderer text into a file read,
 * write or `shell.openPath` consults this set as its only escape hatch (see
 * `ipc/request.ts`'s dump-file check and `ProjectService`'s attachment containment).
 *
 * The set is split into a **read** half and a **write** half, kept as two independent `Set`s
 * on the same instance. `attachments.pickFiles` (an Open dialog — "let me attach this file")
 * only ever records a read pick; `dialogs.saveFile` (a Save-as dialog — "write my dump here")
 * only ever records a write pick. Without the split, picking a file to attach would silently
 * also grant it as a legal Dump File *write* target, even though the user never saw a save
 * dialog for it. Attachment reads consult only {@link hasRead}; the dump-file write check
 * consults only {@link hasWrite}.
 *
 * Paths are normalised with `resolve`, so the same file recorded and queried through different
 * spellings still matches. Cleared on app restart; never persisted to disk. A path that came
 * from an OS *drag-and-drop* (Task 33b) has no main-side evidence at all and is NOT in here:
 * 33b must add its own `attachments.rememberDropped`-style channel rather than assume a drop
 * is a pick.
 */
export class DialogPicks {
  private readonly readPicked = new Set<string>();
  private readonly writePicked = new Set<string>();

  /** Remembers `path` as an explicitly user-chosen read source (an Open dialog) this session. */
  rememberRead(path: string): void {
    this.readPicked.add(resolve(path));
  }

  /** Whether `path` was chosen as a read source through a native dialog this session. */
  hasRead(path: string): boolean {
    return this.readPicked.has(resolve(path));
  }

  /** Remembers `path` as an explicitly user-chosen write target (a Save-as dialog) this session. */
  rememberWrite(path: string): void {
    this.writePicked.add(resolve(path));
  }

  /** Whether `path` was chosen as a write target through a native dialog this session. */
  hasWrite(path: string): boolean {
    return this.writePicked.has(resolve(path));
  }
}

/** The read-check side of {@link DialogPicks}: "did the user pick this exact path to read this session?". */
export type ReadPicks = Pick<DialogPicks, 'hasRead'>;

/** The read-record side of {@link DialogPicks}, for the Open-dialog handlers that record a choice. */
export type RecordsReadPicks = Pick<DialogPicks, 'rememberRead'>;

/** The write-check side of {@link DialogPicks}: "did the user pick this exact path to write this session?". */
export type WritePicks = Pick<DialogPicks, 'hasWrite'>;

/** The write-record side of {@link DialogPicks}, for the Save-as-dialog handlers that record a choice. */
export type RecordsWritePicks = Pick<DialogPicks, 'rememberWrite'>;
