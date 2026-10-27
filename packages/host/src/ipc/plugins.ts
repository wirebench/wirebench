import { WirebenchError } from '@wirebench/engine';
import { channels } from '@wirebench/wire/ipc';
import type { DialogPicks } from '../dialog-picks.js';
import type { DesktopPlugins } from '../plugins/desktop-plugins.js';
import { registerHandler, type HandlerTable } from './register.js';

/**
 * Registers `plugins.*` (phase 7 §9, ADR-0031): Settings → Plugins. A plugin is staged only from a
 * path the person picked in this window's Open dialog, so a renderer cannot name a folder for main to
 * install from; installing is a second call, after the renderer showed what the plugin declares.
 */
export function registerPluginChannels(
  table: HandlerTable,
  deps: {
    readonly plugins: () => DesktopPlugins;
    readonly picks: Pick<DialogPicks, 'hasRead'>;
  },
): void {
  registerHandler(table, channels.plugins.list, () => Promise.resolve(deps.plugins().list()));

  registerHandler(table, channels.plugins.stage, async (request) => {
    if (!deps.picks.hasRead(request.path)) {
      throw new WirebenchError('path-not-picked', 'Pick the plugin with Install from folder… or Install from file…');
    }
    return await deps.plugins().stage(request.path);
  });

  registerHandler(table, channels.plugins.install, async (request) => await deps.plugins().install(request.token));

  registerHandler(table, channels.plugins.remove, async (request) => {
    await deps.plugins().remove(request.id);
    return {};
  });
}
