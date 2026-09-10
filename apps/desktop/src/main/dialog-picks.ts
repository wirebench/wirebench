/**
 * Session-only memory of absolute paths the user has explicitly chosen through a native
 * Save-as dialog (`dialogs.saveFile`) — today, only the Dump File "Browse…" picker calls it.
 *
 * `request.send`'s dump-file containment check (see `ipc/request.ts`) treats a picked path as
 * an explicit escape hatch: the user drove the OS picker themselves, which is a stronger signal
 * of intent than a path that was merely typed (or left over from an imported/cloned request).
 * Cleared on app restart; never persisted to disk.
 */
export class DialogPicks {
  private readonly picked = new Set<string>();

  /** Remembers `path` as explicitly user-chosen for the rest of this session. */
  remember(path: string): void {
    this.picked.add(path);
  }

  /** Whether `path` was chosen through a Save-as dialog this session. */
  has(path: string): boolean {
    return this.picked.has(path);
  }
}
