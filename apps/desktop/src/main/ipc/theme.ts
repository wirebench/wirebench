import { nativeTheme } from 'electron';
import { channels } from '../../shared/ipc.js';
import type { ThemeOsWire } from '../../shared/wire-types.js';
import { registerHandler } from './register.js';

/**
 * The slice of Electron's `nativeTheme` this module needs, so the channel can be asserted on
 * with a fake in a plain Node test (the real one only exists inside a running Electron app).
 */
export interface NativeThemeApi {
  readonly shouldUseDarkColors: boolean;
  on(event: 'updated', listener: () => void): unknown;
}

/** `nativeTheme`'s current answer as the wire shape both `theme.get` and `theme.changed` use. */
export function themeOf(theme: NativeThemeApi): ThemeOsWire {
  return { os: theme.shouldUseDarkColors ? 'dark' : 'light' };
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
 * @param theme - Injectable for tests; production uses Electron's `nativeTheme`.
 */
export function registerThemeChannels(
  broadcast: (payload: ThemeOsWire) => void,
  theme: NativeThemeApi = nativeTheme,
): void {
  registerHandler(channels.theme.get, () => Promise.resolve(themeOf(theme)));
  theme.on('updated', () => {
    broadcast(themeOf(theme));
  });
}
