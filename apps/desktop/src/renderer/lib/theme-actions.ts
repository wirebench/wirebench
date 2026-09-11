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
