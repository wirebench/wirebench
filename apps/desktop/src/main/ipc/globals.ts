import { channels } from '../../shared/ipc.js';
import type { GlobalProperties } from '../global-properties.js';
import { registerHandler } from './register.js';

/**
 * Registers the `globals.*` IPC channels against the shared {@link GlobalProperties} store.
 *
 * Global properties are user-scoped, not project-scoped, so a change made in one window has to
 * reach every other one: `onChanged` is invoked after each write and `main/index.ts` broadcasts
 * it as the `globals.changed` event. Every channel answers with the whole map, so the renderer
 * never has to merge a patch into a mirror that might have drifted.
 *
 * `globals.get` awaits {@link GlobalProperties.ready} before answering: these channels can be
 * registered (and called) before the startup warm-up's `load()` resolves, and an early caller
 * must see on-disk state rather than the empty default with no way to be corrected later.
 */
export function registerGlobalsChannels(
  globals: GlobalProperties,
  onChanged: (properties: Record<string, string>) => void = () => undefined,
): void {
  registerHandler(channels.globals.get, async () => {
    await globals.ready();
    return { properties: globals.get() };
  });

  registerHandler(channels.globals.set, async (request) => {
    const properties = await globals.set(request.name, request.value);
    onChanged(properties);
    return { properties };
  });

  registerHandler(channels.globals.remove, async (request) => {
    const properties = await globals.remove(request.name);
    onChanged(properties);
    return { properties };
  });
}
