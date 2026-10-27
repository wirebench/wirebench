/** Serves a {@link HandlerTable} over Electron's `ipcMain`: the only place handlers meet it. */
import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type { HandlerTable } from '@wirebench/host';
import { runAsCaller } from '@wirebench/host/desktop';
import { callerForWebContents } from './electron-platform.js';

/** Installs every entry of `table` on `ipcMain`; each call runs as a call from its sender's window. */
export function bindIpc(table: HandlerTable): void {
  for (const [name, run] of table) {
    ipcMain.handle(name, (event: IpcMainInvokeEvent, raw: unknown) => {
      const caller = callerForWebContents(event.sender);
      return runAsCaller(caller.id, () => run(raw, caller));
    });
  }
}
