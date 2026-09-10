import { BrowserWindow, dialog } from 'electron';
import { channels } from '../../shared/ipc.js';
import { registerHandler } from './register.js';

/** Registers the `dialogs.*` IPC channels: native file/folder pickers scoped to the caller's window. */
export function registerDialogsChannels(): void {
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
    const window = BrowserWindow.fromWebContents(sender) ?? undefined;
    const result = await dialog.showOpenDialog(window as BrowserWindow, {
      properties: ['openDirectory'],
      ...(request.title !== undefined ? { title: request.title } : {}),
    });
    return { path: result.canceled ? undefined : result.filePaths[0] };
  });
}
