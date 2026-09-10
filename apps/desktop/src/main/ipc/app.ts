import { app } from 'electron';
import { channels } from '../../shared/ipc.js';
import { registerHandler } from './register.js';

/** Registers the `app.*` IPC channels (currently just `app.version`). */
export function registerAppChannels(): void {
  registerHandler(channels.app.version, () =>
    Promise.resolve({
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
    }),
  );
}
