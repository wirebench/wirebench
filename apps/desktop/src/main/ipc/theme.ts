import type { HostPlatform } from '../host/platform.js';
import { channels } from '@wirebench/wire/ipc';
import type { ThemeOsWire } from '@wirebench/wire/wire-base';
import { registerHandler, type HandlerTable } from './register.js';

/** What this module needs of the platform: the OS appearance and word of it changing. */
export type ThemeSource = Pick<HostPlatform['app'], 'osTheme' | 'onOsThemeChanged'>;

/** The OS appearance's current answer as the wire shape both `theme.get` and `theme.changed` use. */
export function themeOf(theme: Pick<ThemeSource, 'osTheme'>): ThemeOsWire {
  return { os: theme.osTheme() };
}

/**
 * Registers `theme.get` and starts pushing `theme.changed`.
 *
 * The renderer cannot read the OS appearance itself: `prefers-color-scheme` in a sandboxed
 * renderer tracks the *system* setting, not a per-app appearance override, and does not fire
 * reliably when the user flips appearance while the window is hidden. `nativeTheme` is the
 * authority, so `system` resolves against this channel and this event.
 *
 * @param broadcast - Sends the event to every open window; injected so main owns window fan-out.
 * @param theme - The platform's `app`, which knows the OS appearance.
 */
export function registerThemeChannels(
  table: HandlerTable,
  broadcast: (payload: ThemeOsWire) => void,
  theme: ThemeSource,
): void {
  registerHandler(table, channels.theme.get, () => Promise.resolve(themeOf(theme)));
  theme.onOsThemeChanged(() => {
    broadcast(themeOf(theme));
  });
}
