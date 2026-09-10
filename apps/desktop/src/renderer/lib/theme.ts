import { useEffect } from 'react';
import type { ThemePreference } from '../state/ui-state.js';

/** Resolves `system` against the OS preference; `dark` when the query is unavailable (jsdom). */
export function resolveTheme(preference: ThemePreference): 'dark' | 'light' {
  if (preference !== 'system') {
    return preference;
  }
  const query = globalThis.matchMedia?.('(prefers-color-scheme: light)');
  return query?.matches === true ? 'light' : 'dark';
}

/**
 * Reflects the theme preference onto `<html data-theme>`, which is what `tokens.css` switches
 * on, and re-resolves when the OS flips while the preference is `system`.
 */
export function useTheme(preference: ThemePreference): void {
  useEffect(() => {
    const apply = (): void => {
      document.documentElement.dataset['theme'] = resolveTheme(preference);
    };
    apply();

    if (preference !== 'system') {
      return;
    }
    const query = globalThis.matchMedia?.('(prefers-color-scheme: light)');
    query?.addEventListener('change', apply);
    return () => {
      query?.removeEventListener('change', apply);
    };
  }, [preference]);
}
