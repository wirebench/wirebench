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
import { app } from 'electron';
import type { HostPlatform } from '@wirebench/host';
import { appVersion, requireCapability } from '@wirebench/host/desktop';
// `electron-updater` is CommonJS: under this package's ESM output a named import of
// `autoUpdater` throws at load ("Named export not found"), so the default export is
// destructured instead. The main bundle externalises it, so this is what actually runs.
import electronUpdater from 'electron-updater';
import { githubFeedFrom, UpdateController } from '@wirebench/host/desktop';
import type { UpdateChannel, UpdateStatus } from '@wirebench/host/desktop';

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
async function confirm(
  platform: Pick<HostPlatform, 'dialogs'>,
  message: string,
  detail: string,
  confirmLabel: string,
): Promise<boolean> {
  const { response } = await requireCapability(platform, 'dialogs').message(undefined, {
    type: 'question',
    buttons: [confirmLabel, 'Not Now'],
    defaultId: 1,
    cancelId: 1,
    message,
    detail,
  });
  return response === 0;
}

/** "6.2.0-rc.1 (preview)" for a pre-release, the bare version otherwise. */
export function versionLabel(version: string): string {
  return version.includes('-') ? `${version} (preview)` : version;
}

/**
 * Builds the app's single {@link UpdateController}.
 *
 * @param report - broadcasts a status to every window (the status bar renders it)
 * @param options.portable - the portable Windows build, which is updated by downloading the new
 *   zip rather than by running an installer (see `portable.ts`)
 * @param options.channel - the `updates.channel` preference, read at every check
 */
export function createUpdateController(
  platform: Pick<HostPlatform, 'app' | 'dialogs' | 'shell'>,
  report: (status: UpdateStatus) => void,
  options: { readonly portable?: boolean; readonly channel?: () => UpdateChannel } = {},
): UpdateController {
  const portable = options.portable === true;
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
        portable
          ? await confirm(
              platform,
              `Wirebench ${versionLabel(version)} is available.`,
              `You are running ${appVersion(platform.app)}, the portable build. Open the release page to download the new zip? Unpack it and move this copy's data folder into it.`,
              'Open Release Page',
            )
          : await confirm(
              platform,
              `Wirebench ${versionLabel(version)} is available.`,
              `You are running ${appVersion(platform.app)}. Download the update now? Nothing is installed until you say so.`,
              'Download',
            ),
      confirmInstall: async (version) =>
        await confirm(
          platform,
          `Wirebench ${versionLabel(version)} is ready to install.`,
          'Wirebench will restart to finish installing.',
          'Restart and Install',
        ),
      openReleasePage: async (version) => {
        if (feed !== undefined) {
          await requireCapability(platform, 'shell').openExternal(
            `https://github.com/${feed.owner}/${feed.repo}/releases/tag/v${version}`,
          );
        }
      },
      report,
    },
    {
      feedConfigured: feed !== undefined && platform.app.packaged(),
      selfInstall: !portable,
      ...(options.channel !== undefined ? { channel: options.channel } : {}),
    },
  );
}
