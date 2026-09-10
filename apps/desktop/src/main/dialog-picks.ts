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
 * Paths are normalised with `resolve`, so the same file recorded and queried through different
 * spellings still matches. Cleared on app restart; never persisted to disk. A path that came
 * from an OS *drag-and-drop* (Task 33b) has no main-side evidence at all and is NOT in here:
 * 33b must add its own `attachments.rememberDropped`-style channel rather than assume a drop
 * is a pick.
 */
export class DialogPicks {
  private readonly picked = new Set<string>();

  /** Remembers `path` as explicitly user-chosen for the rest of this session. */
  remember(path: string): void {
    this.picked.add(resolve(path));
  }

  /** Whether `path` was chosen through a native dialog this session. */
  has(path: string): boolean {
    return this.picked.has(resolve(path));
  }
}

/** The read side of {@link DialogPicks}: "did the user pick this exact path this session?". */
export type PickedPaths = Pick<DialogPicks, 'has'>;

/** The write side of {@link DialogPicks}, for the dialog handlers that record a choice. */
export type RecordsPicks = Pick<DialogPicks, 'remember'>;
