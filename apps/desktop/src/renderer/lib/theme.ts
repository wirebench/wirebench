import { useEffect, useSyncExternalStore } from 'react';
import type { ThemeOsWire } from '../../shared/wire-types.js';
import type { ThemePreference } from '../state/ui-state.js';

/** The two concrete schemes a preference can resolve to. */
export type ResolvedTheme = 'dark' | 'light';

/** The order `view.toggleTheme` cycles through. */
export const THEME_CYCLE: readonly ThemePreference[] = ['dark', 'light', 'system'];

/** The next preference in {@link THEME_CYCLE}; wraps back to `dark` after `system`. */
export function nextThemePreference(current: ThemePreference): ThemePreference {
  const index = THEME_CYCLE.indexOf(current);
  return THEME_CYCLE[(index + 1) % THEME_CYCLE.length] ?? 'dark';
}

/** What the theme indicator and the palette show for each preference. */
export const THEME_LABEL: Readonly<Record<ThemePreference, string>> = {
  dark: 'Dark',
  light: 'Light',
  system: 'System',
};

/**
 * The OS colour scheme as main last reported it. Kept in a module-level store rather than a
 * React context because non-React code (the Monaco theme lookup) reads it synchronously.
 */
let osTheme: ResolvedTheme = 'dark';
const listeners = new Set<() => void>();

function subscribeOs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Publishes a new OS scheme, waking every `useSyncExternalStore` subscriber. */
export function setOsTheme(next: ResolvedTheme): void {
  if (next === osTheme) {
    return;
  }
  osTheme = next;
  for (const listener of listeners) {
    listener();
  }
}

/** The OS scheme as last reported by `theme.get`/`theme.changed` (or `prefers-color-scheme`). */
export function getOsTheme(): ResolvedTheme {
  return osTheme;
}

/** Resolves `system` against the OS scheme; a concrete preference is returned as-is. */
export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? osTheme : preference;
}

/**
 * Keeps {@link osTheme} in step with the OS.
 *
 * `nativeTheme` in main is the authority — a sandboxed renderer's `prefers-color-scheme` does
 * not see a per-app appearance override — so the bridge asks `theme.get` once and then listens
 * for `theme.changed`. When there is no preload bridge (unit tests, a bare jsdom render) it
 * falls back to the media query, which is close enough for a browser-only environment.
 *
 * @returns an unsubscribe function.
 */
export function startOsThemeBridge(): () => void {
  const api = globalThis.window?.wirebench as typeof window.wirebench | undefined;
  if (api?.theme?.get !== undefined) {
    let live = true;
    void api.theme.get(undefined).then((result) => {
      if (live && result.ok) {
        setOsTheme(result.value.os);
      }
    });
    // `defineEvent` types every event's `name` as `string`, so the derived event map cannot
    // narrow a payload by channel; the cast is the same one the store mirrors use.
    const off = api.on('theme.changed', ((payload: ThemeOsWire) => {
      setOsTheme(payload.os);
    }) as (payload: unknown) => void);
    return () => {
      live = false;
      off();
    };
  }

  const query = globalThis.matchMedia?.('(prefers-color-scheme: light)');
  const apply = (): void => {
    setOsTheme(query?.matches === true ? 'light' : 'dark');
  };
  apply();
  query?.addEventListener('change', apply);
  return () => {
    query?.removeEventListener('change', apply);
  };
}

/** Re-renders the caller whenever the resolved theme changes (an OS flip included). */
export function useResolvedTheme(preference: ThemePreference): ResolvedTheme {
  const os = useSyncExternalStore(subscribeOs, getOsTheme, getOsTheme);
  return preference === 'system' ? os : preference;
}

/**
 * Reflects the theme preference onto `<html data-theme>`, which is what `tokens.css` switches
 * on, and re-resolves when the OS flips while the preference is `system`.
 */
export function useTheme(preference: ThemePreference): void {
  useEffect(() => startOsThemeBridge(), []);
  const resolved = useResolvedTheme(preference);
  useEffect(() => {
    document.documentElement.dataset['theme'] = resolved;
  }, [resolved]);
}
