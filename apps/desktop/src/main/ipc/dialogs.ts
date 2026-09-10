import { BrowserWindow, dialog } from 'electron';
import { channels } from '../../shared/ipc.js';
import type { DialogPicks } from '../dialog-picks.js';
import { registerHandler } from './register.js';

/**
 * e2e cannot drive a native folder picker, so `WIREBENCH_E2E_DIALOG_FOLDER` short-circuits
 * `dialogs.openFolder` to a fixed path. Read at call time (not module load) so a spec can set
 * it per launch; only ever consulted in a test build's environment.
 */
function e2eFolderOverride(): string | undefined {
  return process.env['WIREBENCH_E2E_DIALOG_FOLDER'];
}

/**
 * e2e cannot drive a native save dialog either, so `WIREBENCH_E2E_DIALOG_SAVE` short-circuits
 * `dialogs.saveFile` to a fixed path, mirroring the folder override above.
 */
function e2eSaveOverride(): string | undefined {
  return process.env['WIREBENCH_E2E_DIALOG_SAVE'];
}

/**
 * Registers the `dialogs.*` IPC channels: native file/folder pickers scoped to the caller's
 * window. `picks` records every path a Save-as dialog returns — today, only the Dump File
 * "Browse…" picker uses `saveFile` — so `request.send`'s containment check can treat a
 * user-picked path as an explicit exception to "stay inside the project".
 */
export function registerDialogsChannels(picks: DialogPicks): void {
  registerHandler(channels.dialogs.openFile, async (request, sender) => {
    const window = BrowserWindow.fromWebContents(sender) ?? undefined;
    const result = await dialog.showOpenDialog(window as BrowserWindow, {
      properties: ['openFile'],
      ...(request.title !== undefined ? { title: request.title } : {}),
      ...(request.filters !== undefined ? { filters: request.filters } : {}),
    });
    return { path: result.canceled ? undefined : result.filePaths[0] };
  });

  registerHandler(channels.dialogs.openFolder, async (request, sender) => {
    const override = e2eFolderOverride();
    if (override !== undefined) {
      return { path: override };
    }
    const window = BrowserWindow.fromWebContents(sender) ?? undefined;
    const result = await dialog.showOpenDialog(window as BrowserWindow, {
      properties: ['openDirectory'],
      ...(request.title !== undefined ? { title: request.title } : {}),
    });
    return { path: result.canceled ? undefined : result.filePaths[0] };
  });

  registerHandler(channels.dialogs.saveFile, async (request, sender) => {
    const override = e2eSaveOverride();
    if (override !== undefined) {
      picks.remember(override);
      return { path: override };
    }
    const window = BrowserWindow.fromWebContents(sender) ?? undefined;
    const result = await dialog.showSaveDialog(window as BrowserWindow, {
      ...(request.title !== undefined ? { title: request.title } : {}),
      ...(request.filters !== undefined ? { filters: request.filters } : {}),
      ...(request.defaultPath !== undefined ? { defaultPath: request.defaultPath } : {}),
    });
    if (!result.canceled && result.filePath !== undefined) {
      picks.remember(result.filePath);
    }
    return { path: result.canceled ? undefined : result.filePath };
  });
}
