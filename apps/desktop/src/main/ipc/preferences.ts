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
 * Some fields are not the renderer's to set: see {@link MAIN_ONLY_KEYS}.
 */

/**
 * The keys `preferences.update` refuses, one array per section that has any.
 *
 * `ssl.caBundlePath` names a file main *reads on every send*; `git.path` names an executable
 * main *executes* on the tree it opens, a stricter reason still. Either way the renderer may
 * never name a path main later reads or runs — that is the whole containment rule, and it holds
 * for a preference as much as for an attachment. Each path is set only by its own picker
 * (`ssl.pickCaBundle`, `git.locate`), which runs in main and records the pick; the matching
 * `...PickedByMain` marker says so, and would be worthless if the renderer could set it too. A
 * patch carrying any of these is rejected rather than silently dropped, so a renderer that still
 * tries fails loudly in development.
 */
const MAIN_ONLY_KEYS = {
  ssl: ['caBundlePath', 'caBundlePickedByMain'],
  git: ['path', 'pathPickedByMain'],
} as const;

/** Per-section message naming the channel that is the actual way to change a main-only key. */
const MAIN_ONLY_MESSAGE: Record<keyof typeof MAIN_ONLY_KEYS, string> = {
  ssl: 'The CA bundle is set only by picking a file (ssl.pickCaBundle), not through preferences.update',
  git: 'The git executable is set only by detection or picking a file (git.locate), not through preferences.update',
};

export function registerPreferencesChannels(
  preferences: PreferencesService,
  onChanged: (preferences: PreferencesWire) => void = () => undefined,
): void {
  registerHandler(channels.preferences.get, async () => {
    return { preferences: toPreferencesWire(await preferences.ready()) };
  });

  registerHandler(channels.preferences.update, async (request) => {
    for (const section of Object.keys(MAIN_ONLY_KEYS) as (keyof typeof MAIN_ONLY_KEYS)[]) {
      const value = request.patch[section];
      const refused = value === undefined ? [] : MAIN_ONLY_KEYS[section].filter((key) => key in value);
      if (refused.length > 0) {
        throw new WirebenchError('preference-read-only', `${MAIN_ONLY_MESSAGE[section]}: ${refused.join(', ')}`, {
          details: { keys: [...refused] },
        });
      }
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
