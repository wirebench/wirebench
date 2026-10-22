import { app, BrowserWindow, Menu } from 'electron';
import { AREAS } from '../../shared/area-module.js';
import type { AreaId } from '../../shared/area-module.js';
import type { KindId } from '../../shared/kinds/kind-module.js';
import { appVersion } from '../app-version.js';
import { channels, events } from '../../shared/ipc.js';
import { applyCommandMenu } from '../menu.js';
import type { MenuApi } from '../menu.js';
import { emitEvent } from './events.js';
import type { AppFeaturesWire, FeatureStateWire, UpdateStatusWire } from '../../shared/wire-base.js';
import { registerHandler } from './register.js';
import { KINDS } from '../../shared/kinds/kind-module.js';

/**
 * Registers the `app.*` IPC channels: the version triple, the application menu the renderer
 * generates from its command registry, and the user-run update check.
 *
 * `menuApi` is injectable so the menu can be asserted on with a fake `Menu`; production passes
 * Electron's own. `checkForUpdates` is injectable for the same reason, and is absent in a
 * development run — the channel still answers, with the same "could not check" the offline
 * case gets, so the renderer needs no second code path. `newWindow` opens another window; absent (a
 * test), the channel answers without one.
 */
export function registerAppChannels(
  menuApi: MenuApi = {
    install: (template) => {
      Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    },
  },
  checkForUpdates: () => Promise<UpdateStatusWire> = () =>
    Promise.resolve({ kind: 'error', message: 'Could not check for updates' }),
  newWindow: () => void = () => undefined,
  enabledAreas: readonly AreaId[] = AREAS.map((area) => area.id),
  /** The calling window's workspace's kinds and feature rows (phase 4 spec §6.2); a test's default has everything on. */
  features: { kinds: () => readonly KindId[]; features?: () => readonly string[]; states: () => AppFeaturesWire } = {
    kinds: () => KINDS.map((kind) => kind.kind),
    states: () => ({ states: [] }),
  },
  localTerminal = enabledAreas.includes('ssh'),
  telnet = enabledAreas.includes('ssh'),
  serial = enabledAreas.includes('ssh'),
  /** The area rows Settings → Features → Areas shows (#360); a test's default has none. */
  areaStates: () => readonly FeatureStateWire[] = () => [],
): void {
  registerHandler(channels.app.version, () =>
    Promise.resolve({
      version: appVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
    }),
  );

  registerHandler(channels.app.areas, () =>
    Promise.resolve({ enabled: [...enabledAreas], localTerminal, telnet, serial }),
  );

  registerHandler(channels.app.kinds, () =>
    Promise.resolve({
      enabled: [...features.kinds()],
      ...(features.features !== undefined ? { features: [...features.features()] } : {}),
    }),
  );

  registerHandler(channels.app.features, () => Promise.resolve({ ...features.states(), areas: [...areaStates()] }));

  registerHandler(channels.app.checkForUpdates, async () => ({ status: await checkForUpdates() }));

  registerHandler(channels.app.newWindow, () => {
    newWindow();
    return Promise.resolve({});
  });

  registerHandler(channels.app.registerMenu, (request, sender) => {
    const items = applyCommandMenu(
      request.items,
      {
        isMac: process.platform === 'darwin',
        isDev: !app.isPackaged,
        // To the focused window, falling back to the one that registered the menu. The menu
        // is shared by every window, so the window that happened to register it last is not
        // necessarily the one the user is looking at — and a menu click must act on what they
        // are looking at. That window's registry then decides whether `when` allows it.
        dispatch: (id) => {
          const focused = BrowserWindow.getFocusedWindow();
          const target = focused === null || focused.isDestroyed() ? sender : focused.webContents;
          emitEvent(target, events.command.invoke, { id });
        },
      },
      menuApi,
    );
    return Promise.resolve({ items });
  });
}
