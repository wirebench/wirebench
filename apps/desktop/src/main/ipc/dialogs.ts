import { channels } from '../../shared/ipc.js';
import type { RecordsReadPicks, RecordsWritePicks } from '../dialog-picks.js';
import { pickFile, pickFolder, pickSaveFile } from '../native-dialogs.js';
import { registerHandler } from './register.js';

/**
 * Registers the `dialogs.*` IPC channels: native file/folder pickers scoped to the caller's
 * window, implemented in `main/native-dialogs.ts` so the features that run a picker of their
 * own (Export Definition, Generate Documentation) behave identically.
 *
 * `picks` records every path the user actually chose — a Save-as target as a *write* pick, an
 * Open-file target as a *read* pick — so main-side containment checks can treat a user-driven
 * choice as an explicit exception to "stay inside the project" (see `main/path-access.ts`).
 */
export function registerDialogsChannels(picks: RecordsWritePicks & RecordsReadPicks): void {
  registerHandler(channels.dialogs.openFile, async (request, sender) => ({
    path: await pickFile(sender, picks, {
      ...(request.title !== undefined ? { title: request.title } : {}),
      ...(request.filters !== undefined ? { filters: request.filters } : {}),
    }),
  }));

  registerHandler(channels.dialogs.openFolder, async (request, sender) => ({
    path: await pickFolder(sender, request.title !== undefined ? { title: request.title } : {}),
  }));

  registerHandler(channels.dialogs.saveFile, async (request, sender) => ({
    path: await pickSaveFile(sender, picks, {
      ...(request.title !== undefined ? { title: request.title } : {}),
      ...(request.filters !== undefined ? { filters: request.filters } : {}),
      ...(request.defaultPath !== undefined ? { defaultPath: request.defaultPath } : {}),
    }),
  }));
}
