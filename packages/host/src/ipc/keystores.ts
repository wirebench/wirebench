/**
 * The `keystores.*` IPC channels.
 *
 * Two channels, one rule between them: key material never crosses the context bridge.
 * `inspect` reads the file in main and answers with alias *metadata* only; `pickFile` is the
 * only way a path outside the project folder becomes readable at all, and it records the pick
 * exactly as the attachments picker does (see `dialog-picks.ts`).
 */

import type { Caller, HostPlatform } from '../host/platform.js';
import { requireCapability } from '../host/capability.js';
import { channels } from '@wirebench/wire/ipc';
import type { RecordsReadPicks } from '../dialog-picks.js';
import type { ProjectRouter } from '../project-router.js';
import { registerHandler, type HandlerTable } from './register.js';

/** What the `keystores.*` channels need; a stub stands in for each of these in tests. */
export interface KeystoreChannelDeps {
  /** Reads and parses the keystore behind a registry id. */
  readonly project: Pick<ProjectRouter, 'inspectKeystore'>;
  /**
   * The session's picked-path memory. `pickFile` records what it returns here, which is the
   * only evidence `add-keystore` accepts for a file outside the project folder.
   */
  readonly picks: RecordsReadPicks;
  /** The native Open-file dialog `pickFile` runs. */
  readonly platform: Pick<HostPlatform, 'dialogs'>;
}

/** The extensions the Open dialog offers; the same set `keystoreTypeForPath` recognises. */
const KEYSTORE_EXTENSIONS = ['p12', 'pfx', 'pem', 'crt', 'cer', 'key'];

/** e2e cannot drive a native dialog, so this env var short-circuits it, as `attachments.*` does. */
function e2eOpenPathOverride(): string | undefined {
  return process.env['WIREBENCH_E2E_OPEN_PATH'];
}

async function pickThroughDialog(platform: Pick<HostPlatform, 'dialogs'>, sender: Caller): Promise<string | undefined> {
  const result = await requireCapability(platform, 'dialogs').openFile(sender, {
    title: 'Choose a keystore',
    properties: ['openFile'],
    filters: [
      { name: 'Keystores', extensions: KEYSTORE_EXTENSIONS },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return result.canceled ? undefined : result.filePaths[0];
}

/** Registers the `keystores.*` channels. */
export function registerKeystoreChannels(table: HandlerTable, deps: KeystoreChannelDeps): void {
  registerHandler(table, channels.keystores.inspect, (request) => deps.project.inspectKeystore(request.keystoreId));

  registerHandler(table, channels.keystores.pickFile, async (_request, sender) => {
    // The override goes through `rememberRead` exactly as a real pick does, so e2e exercises
    // the same containment path a user does rather than a bypass of it. Comma-separated for
    // symmetry with `attachments.pickFiles`; only the first entry is used here.
    const override = e2eOpenPathOverride();
    const path =
      override !== undefined
        ? override.split(',').filter((entry) => entry.length > 0)[0]
        : await pickThroughDialog(deps.platform, sender);
    if (path === undefined) {
      return {};
    }
    deps.picks.rememberRead(path);
    return { path };
  });
}
