import { channels } from '../../shared/ipc.js';
import type { CurrentValuesStore } from '../current-values.js';
import { registerHandler } from './register.js';

/**
 * Registers the `currentValues.*` channels (cookie jar spec §5.3). Each answers with the whole state;
 * `currentValues.changed` comes from the store after every change.
 */
export function registerCurrentValuesChannels(store: Pick<CurrentValuesStore, 'state' | 'set' | 'reset'>): void {
  registerHandler(channels.currentValues.get, () => Promise.resolve(store.state()));
  registerHandler(channels.currentValues.set, (request) =>
    Promise.resolve(store.set(request.key, request.name, request.value)),
  );
  registerHandler(channels.currentValues.reset, (request) => Promise.resolve(store.reset(request.key, request.name)));
}
