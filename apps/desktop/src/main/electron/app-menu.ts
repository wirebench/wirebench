/** The Electron end of `app.registerMenu`: builds the native application menu and routes clicks. */
import { BrowserWindow, Menu } from 'electron';
import { events } from '@wirebench/wire/ipc';
import type { HostPlatform } from '@wirebench/host';
import { emitEvent, type AppMenu } from '@wirebench/host/desktop';
import { callerForWebContents } from './electron-platform.js';
import { applyCommandMenu } from './menu.js';
import type { MenuApi } from './menu.js';

/**
 * The handler `registerAppChannels` calls with the renderer's command manifest.
 *
 * `menuApi` is injectable so the menu can be asserted on with a fake `Menu`; production installs
 * Electron's own.
 */
export function createElectronAppMenu(
  app: Pick<HostPlatform['app'], 'packaged'>,
  menuApi: MenuApi = {
    install: (template) => {
      Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    },
  },
): AppMenu {
  return (items, sender) =>
    applyCommandMenu(
      items,
      {
        isMac: process.platform === 'darwin',
        isDev: !app.packaged(),
        // To the focused window, falling back to the one that registered the menu. The menu
        // is shared by every window, so the window that happened to register it last is not
        // necessarily the one the user is looking at — and a menu click must act on what they
        // are looking at. That window's registry then decides whether `when` allows it.
        dispatch: (id) => {
          const focused = BrowserWindow.getFocusedWindow();
          const target = focused === null || focused.isDestroyed() ? sender : callerForWebContents(focused.webContents);
          emitEvent(target, events.command.invoke, { id });
        },
      },
      menuApi,
    );
}
