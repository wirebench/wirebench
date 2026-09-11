import { app, BrowserWindow, Menu } from 'electron';
import { channels, events } from '../../shared/ipc.js';
import { applyCommandMenu } from '../menu.js';
import type { MenuApi } from '../menu.js';
import { emitEvent } from './events.js';
import { registerHandler } from './register.js';

/**
 * Registers the `app.*` IPC channels: the version triple, and the application menu the
 * renderer generates from its command registry.
 *
 * `menuApi` is injectable so the menu can be asserted on with a fake `Menu`; production passes
 * Electron's own.
 */
export function registerAppChannels(
  menuApi: MenuApi = {
    install: (template) => {
      Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    },
  },
): void {
  registerHandler(channels.app.version, () =>
    Promise.resolve({
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
    }),
  );

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
