import { channels } from '../../shared/ipc.js';
import { toPreferencesWire } from '../preferences.js';
import type { PreferencesService } from '../preferences.js';
import type { PreferencesWire } from '../../shared/wire-types.js';
import { registerHandler } from './register.js';

/**
 * Registers the `preferences.*` IPC channels against the shared {@link PreferencesService}.
 *
 * Preferences are user-scoped, not project-scoped, so a change made in one window has to reach
 * every other one: `onChanged` is invoked after each write and `main/index.ts` broadcasts it as
 * the `preferences.changed` event. Every channel answers with the whole document, so the
 * renderer never merges a patch into a mirror that might have drifted.
 *
 * `preferences.get` awaits {@link PreferencesService.ready} before answering: these channels can
 * be called before the startup warm-up's `load()` resolves, and an early caller must see on-disk
 * state rather than the defaults with no way to be corrected later.
 */
export function registerPreferencesChannels(
  preferences: PreferencesService,
  onChanged: (preferences: PreferencesWire) => void = () => undefined,
): void {
  registerHandler(channels.preferences.get, async () => {
    return { preferences: toPreferencesWire(await preferences.ready()) };
  });

  registerHandler(channels.preferences.update, async (request) => {
    const next = toPreferencesWire(await preferences.update(request.patch));
    onChanged(next);
    return { preferences: next };
  });

  registerHandler(channels.preferences.reset, async (request) => {
    const next = toPreferencesWire(await preferences.reset(request.section));
    onChanged(next);
    return { preferences: next };
  });
}
