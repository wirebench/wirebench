/**
 * Wires the pure {@link UpdateController} to the real world: `electron-updater`'s
 * `autoUpdater`, two native confirmation dialogs and a status broadcast for the status bar.
 *
 * Split from `updater.ts` so the state machine — which decides whether anything is downloaded
 * or installed — stays free of `electron` imports and is unit-tested with fakes. Everything
 * here is the plumbing that cannot be: dialogs, the release feed, and reading `repository` out
 * of the app's own `package.json`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, dialog } from 'electron';
// `electron-updater` is CommonJS: under this package's ESM output a named import of
// `autoUpdater` throws at load ("Named export not found"), so the default export is
// destructured instead. The main bundle externalises it, so this is what actually runs.
import electronUpdater from 'electron-updater';
import { githubFeedFrom, UpdateController } from './updater.js';
import type { UpdateStatus } from './updater.js';

const { autoUpdater } = electronUpdater;

/**
 * The `repository.url` of the running app, from the `package.json` next to its code — the same
 * field electron-builder wrote the GitHub publish config from. Unreadable or absent means "no
 * feed", which the controller reports as a failed check instead of guessing at a URL.
 */
export function repositoryUrl(appPath: string): string | undefined {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8'));
    const repository = (manifest as { repository?: string | { url?: string } }).repository;
    return typeof repository === 'string' ? repository : repository?.url;
  } catch {
    return undefined;
  }
}

/** Yes/no dialog with the "no" button as the default, so Escape never starts a download. */
async function confirm(message: string, detail: string, confirmLabel: string): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: [confirmLabel, 'Not Now'],
    defaultId: 1,
    cancelId: 1,
    message,
    detail,
  });
  return response === 0;
}

/**
 * Builds the app's single {@link UpdateController}.
 *
 * @param report - broadcasts a status to every window (the status bar renders it)
 */
export function createUpdateController(report: (status: UpdateStatus) => void): UpdateController {
  const feed = githubFeedFrom(repositoryUrl(app.getAppPath()));
  if (feed !== undefined) {
    autoUpdater.setFeedURL({ provider: 'github', owner: feed.owner, repo: feed.repo });
  }
  // `electron-updater` logs to a file by default; Wirebench sends nothing anywhere it was not
  // asked to, and an update check is not worth a log file of its own.
  autoUpdater.logger = null;

  return new UpdateController(
    autoUpdater,
    {
      confirmDownload: async (version) =>
        await confirm(
          `Wirebench ${version} is available.`,
          `You are running ${app.getVersion()}. Download the update now? Nothing is installed until you say so.`,
          'Download',
        ),
      confirmInstall: async (version) =>
        await confirm(
          `Wirebench ${version} is ready to install.`,
          'Wirebench will restart to finish installing.',
          'Restart and Install',
        ),
      report,
    },
    { feedConfigured: feed !== undefined && app.isPackaged },
  );
}
