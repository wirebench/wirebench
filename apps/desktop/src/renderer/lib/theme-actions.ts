import type { Palette } from '@shared/palettes.js';
import { usePreferencesStore } from '../state/preferences.js';
import { useUiStore } from '../state/ui.js';
import { nextThemePreference } from './theme.js';

/**
 * Advances the theme preference one step through dark -> light -> system.
 *
 * The persisted truth is `preferences.ui.theme`; the ui store only mirrors it for rendering, so
 * this writes through the preferences store and lets the mirror follow. Shared by the
 * `view.toggleTheme` command and the status bar's indicator so there is one code path.
 */
export function cycleTheme(): void {
  void usePreferencesStore.getState().update({ ui: { theme: nextThemePreference(useUiStore.getState().theme) } });
}

/**
 * Chooses a colour theme. Like {@link cycleTheme} it writes `preferences.ui.palette` and lets the
 * ui store's mirror follow; the preferences store applies the patch before its round trip, so the
 * mirror holds the new palette by the time this returns. The command-palette picker's Enter and
 * the Settings cards both come through here or the same `update` call.
 */
export function choosePalette(palette: Palette): void {
  void usePreferencesStore.getState().update({ ui: { palette } });
}
