/**
 * The `ssl.*` IPC channels: the CA bundle preference, set and cleared by main alone.
 *
 * `ssl.caBundlePath` names a file main reads on every send, so it is held to the same rule as
 * a keystore or an attachment: a path becomes readable only by being *picked*. The renderer
 * therefore cannot write it — `preferences.update` refuses a patch carrying it — and instead
 * asks main to run the picker. Main records the result through `DialogPicks.rememberRead`
 * (exactly as `keystores.pickFile` does) and persists the path itself, alongside
 * `caBundlePickedByMain: true`; `main/index.ts` re-records a pick at startup only for a path
 * carrying that marker, so a `preferences.yaml` edited by hand adds no trust until the bundle
 * is picked again.
 */

import { BrowserWindow, dialog } from 'electron';
import type { WebContents } from 'electron';
import { channels } from '../../shared/ipc.js';
import type { RecordsReadPicks } from '../dialog-picks.js';
import { toPreferencesWire } from '../preferences.js';
import type { PreferencesService } from '../preferences.js';
import type { PreferencesWire } from '../../shared/wire-types.js';
import { registerHandler } from './register.js';

/** What the `ssl.*` channels need; a stub stands in for each of these in tests. */
export interface SslChannelDeps {
  /** The preferences document; main writes `ssl.caBundlePath` through it and nothing else does. */
  readonly preferences: Pick<PreferencesService, 'update'>;
  /** The session's picked-path memory, the only evidence `ProjectService.trustAnchors` accepts. */
  readonly picks: RecordsReadPicks;
  /** Called after each change so main can broadcast `preferences.changed` to every window. */
  readonly onChanged?: (preferences: PreferencesWire) => void;
}

/** The extensions the Open dialog offers for a PEM trust bundle. */
const CA_BUNDLE_EXTENSIONS = ['pem', 'crt', 'cer'];

/** e2e cannot drive a native dialog, so this env var short-circuits it, as `keystores.*` does. */
function e2eOpenPathOverride(): string | undefined {
  return process.env['WIREBENCH_E2E_OPEN_PATH'];
}

async function pickThroughDialog(sender: WebContents): Promise<string | undefined> {
  const window = BrowserWindow.fromWebContents(sender);
  const options: Electron.OpenDialogOptions = {
    title: 'Choose a CA bundle',
    properties: ['openFile'],
    filters: [
      { name: 'PEM certificates', extensions: CA_BUNDLE_EXTENSIONS },
      { name: 'All files', extensions: ['*'] },
    ],
  };
  const result = window === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options);
  return result.canceled ? undefined : result.filePaths[0];
}

/** Registers the `ssl.*` channels. */
export function registerSslChannels(deps: SslChannelDeps): void {
  registerHandler(channels.ssl.pickCaBundle, async (_request, sender) => {
    // The override goes through `rememberRead` exactly as a real pick does, so e2e exercises
    // the containment path a user does rather than a bypass of it. Comma-separated for symmetry
    // with `attachments.pickFiles`; only the first entry is used here.
    const override = e2eOpenPathOverride();
    const path =
      override !== undefined
        ? override.split(',').filter((entry) => entry.length > 0)[0]
        : await pickThroughDialog(sender);
    if (path === undefined) {
      // A cancelled dialog changes nothing, including the bundle already configured.
      return { preferences: toPreferencesWire(await deps.preferences.update({})) };
    }
    deps.picks.rememberRead(path);
    const next = toPreferencesWire(
      await deps.preferences.update({ ssl: { caBundlePath: path, caBundlePickedByMain: true } }),
    );
    deps.onChanged?.(next);
    return { path, preferences: next };
  });

  registerHandler(channels.ssl.clearCaBundle, async () => {
    // The marker goes with the path: what is cleared must not be re-recorded as a pick at the
    // next startup either.
    const next = toPreferencesWire(
      await deps.preferences.update({ ssl: { caBundlePath: '', caBundlePickedByMain: false } }),
    );
    deps.onChanged?.(next);
    return { preferences: next };
  });
}
