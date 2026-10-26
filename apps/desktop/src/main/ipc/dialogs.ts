import { channels } from '../../shared/ipc.js';
import type { RecordsReadPicks, RecordsWritePicks } from '../dialog-picks.js';
import type { NativeDialogs } from '../native-dialogs.js';
import { registerHandler, type HandlerTable } from './register.js';

/**
 * Registers the `dialogs.*` IPC channels: native Open-file and Save-as pickers scoped to the caller's
 * window, implemented in `main/native-dialogs.ts` so the features that run a picker of their
 * own (Export Definition, Generate Documentation) behave identically. A folder the app writes into
 * is picked by main itself, so the renderer never learns — or names — a path main has not already
 * contained; the one folder channel, `openFolder`, picks a folder to import from, and records it as
 * a read pick exactly as `openFile` records a file.
 *
 * `picks` records every path the user actually chose — a Save-as target as a *write* pick, an
 * Open-file target as a *read* pick — so main-side containment checks can treat a user-driven
 * choice as an explicit exception to "stay inside the project" (see `main/path-access.ts`).
 */
export function registerDialogsChannels(
  table: HandlerTable,
  picks: RecordsWritePicks & RecordsReadPicks,
  dialogs: Pick<NativeDialogs, 'pickFile' | 'pickFolder' | 'pickSaveFile'>,
): void {
  registerHandler(table, channels.dialogs.openFile, async (request, sender) => ({
    path: await dialogs.pickFile(sender, picks, {
      ...(request.title !== undefined ? { title: request.title } : {}),
      ...(request.filters !== undefined ? { filters: request.filters } : {}),
    }),
  }));

  registerHandler(table, channels.dialogs.openFolder, async (request, sender) => ({
    path: await dialogs.pickFolder(sender, request.title !== undefined ? { title: request.title } : {}, picks),
  }));

  registerHandler(table, channels.dialogs.saveFile, async (request, sender) => ({
    path: await dialogs.pickSaveFile(sender, picks, {
      ...(request.title !== undefined ? { title: request.title } : {}),
      ...(request.filters !== undefined ? { filters: request.filters } : {}),
      ...(request.defaultPath !== undefined ? { defaultPath: request.defaultPath } : {}),
    }),
  }));
}
