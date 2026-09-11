import { WirebenchError } from '@wirebench/engine';
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
 *
 * One field is not the renderer's to set: see {@link MAIN_ONLY_SSL_KEYS}.
 */

/**
 * The `ssl` keys `preferences.update` refuses.
 *
 * `caBundlePath` names a file main *reads on every send*, and the renderer may never name a
 * path main later reads — that is the whole containment rule, and it holds for a preference as
 * much as for an attachment. The path is set only by `ssl.pickCaBundle`, which runs a native
 * dialog in main and records the pick; `caBundlePickedByMain` is the marker that says so, and
 * would be worthless if the renderer could set it too. A patch carrying either is rejected
 * rather than silently dropped, so a renderer that still tries fails loudly in development.
 */
const MAIN_ONLY_SSL_KEYS = ['caBundlePath', 'caBundlePickedByMain'] as const;
export function registerPreferencesChannels(
  preferences: PreferencesService,
  onChanged: (preferences: PreferencesWire) => void = () => undefined,
): void {
  registerHandler(channels.preferences.get, async () => {
    return { preferences: toPreferencesWire(await preferences.ready()) };
  });

  registerHandler(channels.preferences.update, async (request) => {
    const ssl = request.patch.ssl;
    const refused = ssl === undefined ? [] : MAIN_ONLY_SSL_KEYS.filter((key) => key in ssl);
    if (refused.length > 0) {
      throw new WirebenchError(
        'preference-read-only',
        `The CA bundle is set only by picking a file (ssl.pickCaBundle), not through preferences.update: ${refused.join(', ')}`,
        { details: { keys: [...refused] } },
      );
    }
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
