/**
 * The native folder/save pickers, factored out of `ipc/dialogs.ts` so main-side features that
 * write a file *themselves* (Export Definition, Generate Documentation) run the very same
 * dialog — and record the very same pick — instead of taking a path the renderer typed.
 *
 * The e2e overrides live here too, for the same reason: one place decides what a picker
 * answers, whether the caller is the `dialogs.*` channel or a feature handler.
 */

import { BrowserWindow, dialog } from 'electron';
import type { WebContents } from 'electron';
import type { RecordsReadPicks, RecordsWritePicks } from './dialog-picks.js';

/** A file-type filter, matching Electron's shape. */
export interface DialogFilter {
  readonly name: string;
  readonly extensions: readonly string[];
}

/**
 * e2e cannot drive a native folder picker, so `WIREBENCH_E2E_DIALOG_FOLDER` short-circuits it
 * to a fixed path. Read at call time (not module load) so a spec can set it per launch.
 */
function folderOverride(): string | undefined {
  return process.env['WIREBENCH_E2E_DIALOG_FOLDER'];
}

/** The save-dialog counterpart of {@link folderOverride}. */
function saveOverride(): string | undefined {
  return process.env['WIREBENCH_E2E_DIALOG_SAVE'];
}

/**
 * The open-file counterpart of {@link folderOverride}. A distinct variable from the keystore
 * picker's `WIREBENCH_E2E_OPEN_PATH` so a spec can pin the two independently — a spec that adds
 * a keystore *and* picks a CA bundle needs different answers from each.
 */
function openFileOverride(): string | undefined {
  return process.env['WIREBENCH_E2E_FILE_DIALOG_PATH'];
}

function windowOf(sender: WebContents): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(sender) ?? undefined;
}

/** Runs the Open-file picker, recording the chosen path as a read pick. */
export async function pickFile(
  sender: WebContents,
  picks: RecordsReadPicks,
  options: { readonly title?: string; readonly filters?: readonly DialogFilter[] },
): Promise<string | undefined> {
  // The override goes through `rememberRead` exactly as a real pick does, so e2e exercises the
  // same containment path a user drives rather than a bypass of it.
  const override = openFileOverride();
  if (override !== undefined && override.length > 0) {
    picks.rememberRead(override);
    return override;
  }
  const result = await dialog.showOpenDialog(windowOf(sender) as BrowserWindow, {
    properties: ['openFile'],
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.filters !== undefined
      ? { filters: options.filters.map((f) => ({ ...f, extensions: [...f.extensions] })) }
      : {}),
  });
  const path = result.canceled ? undefined : result.filePaths[0];
  if (path !== undefined) {
    picks.rememberRead(path);
  }
  return path;
}

/**
 * Runs the folder picker, honouring the e2e override.
 *
 * `picks` is optional only because the original callers (Export Definition, Generate
 * Documentation) pick a folder they are about to write *inside the open project*, where
 * containment alone already answers for the path. A caller that picks a folder **outside** any
 * project — linking or importing a project folder — has no such evidence and must pass `picks`,
 * so the folder is recorded as a read pick exactly as `pickFile` records a file.
 */
export async function pickFolder(
  sender: WebContents,
  options: { readonly title?: string } = {},
  picks?: RecordsReadPicks,
): Promise<string | undefined> {
  // The override is recorded exactly as a real pick is, so e2e exercises the containment path
  // a user drives rather than a bypass of it.
  const override = folderOverride();
  if (override !== undefined) {
    picks?.rememberRead(override);
    return override;
  }
  const result = await dialog.showOpenDialog(windowOf(sender) as BrowserWindow, {
    properties: ['openDirectory'],
    ...(options.title !== undefined ? { title: options.title } : {}),
  });
  const path = result.canceled ? undefined : result.filePaths[0];
  if (path !== undefined) {
    picks?.rememberRead(path);
  }
  return path;
}

/**
 * The write-side folder picker: the same dialog as {@link pickFolder}, recording the chosen
 * folder as a *write* pick. Exporting a project is a "write my project here" choice, and the
 * read/write split in {@link RecordsWritePicks} exists precisely so picking a folder to read
 * from never silently also grants it as a legal write target.
 */
export async function pickFolderToWrite(
  sender: WebContents,
  picks: RecordsWritePicks,
  options: { readonly title?: string } = {},
): Promise<string | undefined> {
  const override = folderOverride();
  if (override !== undefined) {
    picks.rememberWrite(override);
    return override;
  }
  const result = await dialog.showOpenDialog(windowOf(sender) as BrowserWindow, {
    properties: ['openDirectory', 'createDirectory'],
    ...(options.title !== undefined ? { title: options.title } : {}),
  });
  const path = result.canceled ? undefined : result.filePaths[0];
  if (path !== undefined) {
    picks.rememberWrite(path);
  }
  return path;
}

/** Runs the Save-as picker, recording the chosen path as a write pick and honouring the override. */
export async function pickSaveFile(
  sender: WebContents,
  picks: RecordsWritePicks,
  options: {
    readonly title?: string;
    readonly filters?: readonly DialogFilter[];
    readonly defaultPath?: string;
  } = {},
): Promise<string | undefined> {
  const override = saveOverride();
  if (override !== undefined) {
    picks.rememberWrite(override);
    return override;
  }
  const result = await dialog.showSaveDialog(windowOf(sender) as BrowserWindow, {
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.filters !== undefined
      ? { filters: options.filters.map((f) => ({ ...f, extensions: [...f.extensions] })) }
      : {}),
    ...(options.defaultPath !== undefined ? { defaultPath: options.defaultPath } : {}),
  });
  if (!result.canceled && result.filePath !== undefined) {
    picks.rememberWrite(result.filePath);
  }
  return result.canceled ? undefined : result.filePath;
}
