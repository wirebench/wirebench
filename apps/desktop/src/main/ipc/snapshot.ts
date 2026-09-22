/**
 * Registers the `snapshot.*` IPC channels: read, write, re-scope and remove a request's golden
 * response, kept beside its files as `<slug>.golden.yaml` (see {@link SnapshotStore}).
 */

import { channels } from '../../shared/ipc.js';
import type { SnapshotStore } from '../snapshot-store.js';
import { registerHandler } from './register.js';

export function registerSnapshotChannels(store: SnapshotStore): void {
  registerHandler(channels.snapshot.read, (request) => store.read(request));
  registerHandler(channels.snapshot.write, (request) => store.write(request));
  registerHandler(channels.snapshot.setIgnore, (request) => store.setIgnore(request));
  registerHandler(channels.snapshot.remove, (request) => store.remove(request));
}
