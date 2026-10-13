/**
 * What the Files tab remembers on this machine: whether hidden entries show, and the folder each host's
 * pane was last in. Kept in `localStorage` like the rest of the renderer's per-device UI state: losing it
 * only sends a pane back to the host's home folder.
 */

export const FILES_PREFS_KEY = 'wirebench.ssh.files';

export interface FilesPrefs {
  readonly showHidden: boolean;
  /** The last folder per host, keyed by {@link folderKey} (host ids are only unique within a workspace). */
  readonly lastFolder: Readonly<Record<string, string>>;
}

export const DEFAULT_FILES_PREFS: FilesPrefs = { showHidden: false, lastFolder: {} };

/** The `lastFolder` key of a host in a workspace. */
export function folderKey(workspaceId: string, hostId: string): string {
  return `${workspaceId}/${hostId}`;
}

/** The stored prefs; anything missing or malformed falls back to the default. */
export function readFilesPrefs(storage: Storage = localStorage): FilesPrefs {
  try {
    const raw = storage.getItem(FILES_PREFS_KEY);
    if (raw === null) return DEFAULT_FILES_PREFS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return DEFAULT_FILES_PREFS;
    const { showHidden, lastFolder } = parsed as Record<string, unknown>;
    const folders: Record<string, string> = {};
    if (typeof lastFolder === 'object' && lastFolder !== null && !Array.isArray(lastFolder)) {
      for (const [key, value] of Object.entries(lastFolder)) {
        if (typeof value === 'string' && value.startsWith('/')) folders[key] = value;
      }
    }
    return { showHidden: showHidden === true, lastFolder: folders };
  } catch {
    return DEFAULT_FILES_PREFS;
  }
}

export function writeFilesPrefs(prefs: FilesPrefs, storage: Storage = localStorage): void {
  try {
    storage.setItem(FILES_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // A full or blocked storage only costs the remembered folders.
  }
}

/** Reads, changes and writes back in one step. */
export function updateFilesPrefs(
  change: (prefs: FilesPrefs) => FilesPrefs,
  storage: Storage = localStorage,
): FilesPrefs {
  const next = change(readFilesPrefs(storage));
  writeFilesPrefs(next, storage);
  return next;
}
