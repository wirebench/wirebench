/**
 * Registers the `snapshot.*` IPC channels: read, write, re-scope and remove a request's golden
 * response, kept beside its files as `<slug>.golden.yaml` (see {@link SnapshotStore}).
 */

import { channels } from '../../shared/ipc.js';
import type { SnapshotStore } from '../snapshot-store.js';
import { registerHandler, type HandlerTable } from './register.js';

export function registerSnapshotChannels(table: HandlerTable, store: SnapshotStore): void {
  registerHandler(table, channels.snapshot.read, (request) => store.read(request));
  registerHandler(table, channels.snapshot.write, (request) => store.write(request));
  registerHandler(table, channels.snapshot.setIgnore, (request) => store.setIgnore(request));
  registerHandler(table, channels.snapshot.remove, (request) => store.remove(request));
}
