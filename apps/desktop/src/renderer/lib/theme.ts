import { useEffect, useSyncExternalStore } from 'react';
import type { Palette } from '@shared/palettes.js';
import type { ThemeOsWire } from '@shared/wire-base.js';
import { useUiStore } from '../state/ui.js';
import { readUi, type ThemePreference } from '../state/ui-state.js';

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

/** What Settings, the picker and the status bar call each colour theme, in `PALETTES` order. */
export const PALETTE_LABEL: Readonly<Record<Palette, string>> = {
  default: 'Default',
  'field-kit': 'Field kit',
  sandstone: 'Sandstone',
  dusk: 'Dusk',
  seed: 'Seed',
  pith: 'Pith',
  rind: 'Rind',
  plume: 'Plume',
};

/**
 * The OS colour scheme as main last reported it. Kept in a module-level store rather than a
 * React context because non-React code (the Monaco theme lookup) reads it synchronously.
 *
 * The seed is `dark` only until {@link osThemeFromEnv} is consulted; every entry point that can
 * paint (the pre-render {@link applyInitialTheme} and {@link startOsThemeBridge}) does that
 * first, so `system` never resolves to a guess.
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

/**
 * The OS scheme the preload baked in at load time from main's `nativeTheme`, if there is a
 * preload at all. Synchronous by construction — `theme.get` is an IPC round trip, and anything
 * awaited would land after the first paint, which is exactly the flash this avoids.
 */
export function osThemeFromEnv(): ResolvedTheme | undefined {
  return globalThis.window?.wirebench?.env?.osTheme;
}

/**
 * Puts the colour theme on `<html data-palette>`, which `tokens.css` switches on beside
 * `data-theme`. `default` removes the attribute, so the Default look is the plain `:root` and
 * `[data-theme]` cascade with nothing layered over it.
 */
export function applyPalette(palette: Palette): void {
  const root = document.documentElement;
  if (palette === 'default') {
    delete root.dataset['palette'];
  } else {
    root.dataset['palette'] = palette;
  }
}

/**
 * Applies the theme to `<html data-theme>` and the colour theme to `<html data-palette>` before
 * React mounts, from the things that are knowable synchronously: the preferences mirrored in
 * `localStorage` and the OS scheme the preload baked in. Called from `main.tsx` ahead of
 * `createRoot`, so a `system` preference on a light OS never paints a dark frame first, and a
 * chosen colour theme never paints a Default frame first.
 *
 * @param preference - Defaults to the persisted UI mirror.
 * @param palette - Defaults to the persisted UI mirror.
 * @returns the concrete theme that was applied.
 */
export function applyInitialTheme(preference?: ThemePreference, palette?: Palette): ResolvedTheme {
  const stored = preference === undefined || palette === undefined ? readUi() : undefined;
  const fromEnv = osThemeFromEnv();
  if (fromEnv !== undefined) {
    setOsTheme(fromEnv);
  }
  const resolved = resolveTheme(preference ?? stored?.theme ?? 'dark');
  document.documentElement.dataset['theme'] = resolved;
  applyPalette(palette ?? stored?.palette ?? 'default');
  return resolved;
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
 * for `theme.changed`. Where `env.onOsThemeChanged` is set (the browser client) it follows that
 * instead. When there is no preload bridge (unit tests, a bare jsdom render) it falls back to the
 * media query, which is close enough for a browser-only environment.
 *
 * @returns an unsubscribe function.
 */
export function startOsThemeBridge(): () => void {
  const api = globalThis.window?.wirebench as typeof window.wirebench | undefined;
  const fromEnv = osThemeFromEnv();
  if (fromEnv !== undefined) {
    setOsTheme(fromEnv);
  }
  // A page with its own OS-theme source (the browser's media query) follows that: the host it talks to
  // may run on a server, whose `theme.get` knows nothing of the user's screen.
  const pageSource = api?.env?.onOsThemeChanged;
  if (pageSource !== undefined) {
    return pageSource((os) => {
      setOsTheme(os);
    });
  }
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
 * The colour theme the command palette's picker is showing while its highlight moves, or
 * `undefined` when nothing is being previewed. Deliberately outside the ui store: that store is
 * persisted to `localStorage` and mirrors preferences, and a preview must touch neither.
 */
let previewed: Palette | undefined;
const previewListeners = new Set<() => void>();

function subscribePreview(listener: () => void): () => void {
  previewListeners.add(listener);
  return () => {
    previewListeners.delete(listener);
  };
}

function getPreview(): Palette | undefined {
  return previewed;
}

function setPreview(next: Palette | undefined): void {
  if (next === previewed) {
    return;
  }
  previewed = next;
  for (const listener of previewListeners) {
    listener();
  }
}

/**
 * Shows `palette` on the whole window without choosing it: `<html data-palette>` for the chrome
 * and the terminals, and {@link usePalette} for Monaco. Nothing is written; {@link endPalettePreview}
 * puts the stored colour theme back.
 */
export function previewPalette(palette: Palette): void {
  setPreview(palette);
  applyPalette(palette);
}

/**
 * Ends a preview, re-applying the stored colour theme — the one that was active, or the one just
 * chosen, since choosing writes preferences (and so the ui store) synchronously first. A no-op
 * when nothing is being previewed.
 */
export function endPalettePreview(): void {
  if (previewed === undefined) {
    return;
  }
  setPreview(undefined);
  applyPalette(useUiStore.getState().palette);
}

/**
 * The colour theme the window wears: a picker's preview while one runs, else the one mirrored into
 * the ui store from preferences.
 */
export function usePalette(): Palette {
  const stored = useUiStore((state) => state.palette);
  const preview = useSyncExternalStore(subscribePreview, getPreview, getPreview);
  return preview ?? stored;
}

/**
 * Reflects the theme preference onto `<html data-theme>` and the colour theme onto
 * `<html data-palette>`, which are what `tokens.css` switches on, and re-resolves when the OS
 * flips while the preference is `system`.
 */
export function useTheme(preference: ThemePreference, palette: Palette): void {
  useEffect(() => startOsThemeBridge(), []);
  const resolved = useResolvedTheme(preference);
  useEffect(() => {
    document.documentElement.dataset['theme'] = resolved;
  }, [resolved]);
  useEffect(() => {
    applyPalette(palette);
  }, [palette]);
}
