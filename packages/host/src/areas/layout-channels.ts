import { WirebenchError } from '@wirebench/engine';
import { channels } from '@wirebench/wire/ipc';
import type { LayoutNodeWire } from '@wirebench/wire/layout-wire';
import { registerHandler, type HandlerTable } from '../ipc/register.js';
import type { LayoutStore } from '../layout-store.js';

/** The `layout.*` channels: each acts on the calling window's open workspace, never another's. */
export function registerLayoutChannels(
  table: HandlerTable,
  deps: {
    layouts: Pick<LayoutStore, 'list' | 'save' | 'rename' | 'delete'>;
    /** The calling window's open workspace. */
    workspaceId: () => string | undefined;
  },
): void {
  const workspace = (): string => {
    const id = deps.workspaceId();
    if (id === undefined) throw new WirebenchError('workspace-not-open', 'Open a workspace first');
    return id;
  };
  registerHandler(table, channels.layout.list, async () => ({ layouts: await deps.layouts.list(workspace()) }));
  registerHandler(table, channels.layout.save, async (request) => ({
    layout: await deps.layouts.save(workspace(), {
      ...(request.id === undefined ? {} : { id: request.id }),
      name: request.name,
      // Unchecked on the wire; the store refuses a bad tree as `ssh-layout-invalid`.
      root: request.root as LayoutNodeWire,
    }),
  }));
  registerHandler(table, channels.layout.rename, async (request) => {
    await deps.layouts.rename(workspace(), request.id, request.name);
    return {};
  });
  registerHandler(table, channels.layout.delete, async (request) => {
    await deps.layouts.delete(workspace(), request.id);
    return {};
  });
}
