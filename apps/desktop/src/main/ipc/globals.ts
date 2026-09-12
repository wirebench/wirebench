import { channels } from '../../shared/ipc.js';
import type { GlobalsState } from '../../shared/wire-types.js';
import type { GlobalProperties } from '../global-properties.js';
import { registerHandler } from './register.js';

/**
 * Registers the `globals.*` IPC channels against the shared {@link GlobalProperties} store.
 *
 * Global properties are user-scoped, not project-scoped, so a change made in one window has to
 * reach every other one: `onChanged` is invoked after each write and `main/index.ts` broadcasts
 * it as the `globals.changed` event. Every channel answers with the whole state (map plus its
 * `disabled` names), so the renderer never has to merge a patch into a mirror that might have
 * drifted.
 *
 * `globals.get` awaits {@link GlobalProperties.ready} before answering: these channels can be
 * registered (and called) before the startup warm-up's `load()` resolves, and an early caller
 * must see on-disk state rather than the empty default with no way to be corrected later.
 */
export function registerGlobalsChannels(
  globals: GlobalProperties,
  onChanged: (state: GlobalsState) => void = () => undefined,
): void {
  registerHandler(channels.globals.get, async () => {
    await globals.ready();
    return globals.get();
  });

  registerHandler(channels.globals.set, async (request) => {
    const state = await globals.set(request.name, request.value);
    onChanged(state);
    return state;
  });

  registerHandler(channels.globals.remove, async (request) => {
    const state = await globals.remove(request.name);
    onChanged(state);
    return state;
  });

  registerHandler(channels.globals.setEnabled, async (request) => {
    const state = await globals.setEnabled(request.name, request.enabled);
    onChanged(state);
    return state;
  });
}
