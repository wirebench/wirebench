import { app, Menu } from 'electron';
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
        // Back to the window that registered the menu: it holds the registry that knows
        // whether the command's `when` gate allows it here and now.
        dispatch: (id) => {
          emitEvent(sender, events.command.invoke, { id });
        },
      },
      menuApi,
    );
    return Promise.resolve({ items });
  });
}
