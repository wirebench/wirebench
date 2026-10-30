import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { cycleTheme } from '../../src/renderer/lib/theme-actions.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import type { Palette } from '@shared/palettes.js';
import {
  applyInitialTheme,
  applyPalette,
  getOsTheme,
  nextThemePreference,
  resolveTheme,
  setOsTheme,
  startOsThemeBridge,
  usePalette,
  useTheme,
} from '../../src/renderer/lib/theme.js';

/** A component whose only job is to run the hook under test. */
function ThemeHost({
  preference,
  palette = 'default',
}: {
  preference: 'dark' | 'light' | 'system';
  palette?: Palette;
}) {
  useTheme(preference, palette);
  return null;
}

/** Shows what {@link usePalette} returns. */
function PaletteProbe() {
  return <span data-testid="palette">{usePalette()}</span>;
}

/** The `theme.changed` listeners a fake preload bridge collected. */
let themeListeners: ((payload: unknown) => void)[] = [];

function stubBridge(os: 'dark' | 'light') {
  themeListeners = [];
  Object.defineProperty(window, 'wirebench', {
    configurable: true,
    value: {
      // Baked in at preload time from main's `nativeTheme`, so the very first paint knows the
      // OS scheme without waiting for an IPC round trip.
      env: { e2e: false, osTheme: os },
      theme: { get: vi.fn().mockResolvedValue({ ok: true, value: { os } }) },
      on: (name: string, listener: (payload: unknown) => void) => {
        if (name === 'theme.changed') themeListeners.push(listener);
        return () => {
          themeListeners = themeListeners.filter((candidate) => candidate !== listener);
        };
      },
    },
  });
}

describe('theme preference cycle', () => {
  it('cycles dark -> light -> system -> dark', () => {
    expect(nextThemePreference('dark')).toBe('light');
    expect(nextThemePreference('light')).toBe('system');
    expect(nextThemePreference('system')).toBe('dark');
  });
});

describe('resolveTheme', () => {
  afterEach(() => {
    setOsTheme('dark');
  });

  it('returns a concrete preference untouched', () => {
    setOsTheme('light');
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
  });

  it('resolves system against the OS scheme main reported', () => {
    setOsTheme('light');
    expect(resolveTheme('system')).toBe('light');
    setOsTheme('dark');
    expect(resolveTheme('system')).toBe('dark');
  });
});

describe('startOsThemeBridge', () => {
  beforeEach(() => {
    setOsTheme('dark');
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'wirebench');
    setOsTheme('dark');
  });

  it('seeds the OS scheme from theme.get and follows theme.changed', async () => {
    stubBridge('light');
    const stop = startOsThemeBridge();
    await act(async () => {
      await Promise.resolve();
    });
    expect(getOsTheme()).toBe('light');

    act(() => {
      for (const listener of themeListeners) listener({ os: 'dark' });
    });
    expect(getOsTheme()).toBe('dark');
    stop();
  });

  it('follows env.onOsThemeChanged and not theme.get where the page has its own source', async () => {
    stubBridge('light');
    const pageListeners: ((os: 'dark' | 'light') => void)[] = [];
    const api = window.wirebench as unknown as { env: Record<string, unknown>; theme: { get: () => unknown } };
    api.env = {
      ...api.env,
      osTheme: 'dark',
      onOsThemeChanged: (listener: (os: 'dark' | 'light') => void) => {
        pageListeners.push(listener);
        return () => pageListeners.splice(pageListeners.indexOf(listener), 1);
      },
    };
    const stop = startOsThemeBridge();
    await act(async () => {
      await Promise.resolve();
    });
    // The host's `theme.get` (a server's fixed light) does not override the page's dark.
    expect(api.theme.get).not.toHaveBeenCalled();
    expect(getOsTheme()).toBe('dark');
    act(() => {
      pageListeners[0]?.('light');
    });
    expect(getOsTheme()).toBe('light');
    stop();
    expect(pageListeners).toHaveLength(0);
  });

  it('falls back to prefers-color-scheme when there is no bridge', () => {
    Reflect.deleteProperty(window, 'wirebench');
    const listeners: (() => void)[] = [];
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: (_name: string, listener: () => void) => listeners.push(listener),
      removeEventListener: () => undefined,
    }));
    const stop = startOsThemeBridge();
    expect(getOsTheme()).toBe('light');
    stop();
    vi.unstubAllGlobals();
  });
});

describe('useTheme', () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'wirebench');
    setOsTheme('dark');
  });

  it('writes the resolved theme onto <html data-theme>', async () => {
    stubBridge('light');
    render(<ThemeHost preference="system" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.documentElement.dataset['theme']).toBe('light');

    act(() => {
      for (const listener of themeListeners) listener({ os: 'dark' });
    });
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('ignores the OS while the preference is explicit', async () => {
    stubBridge('light');
    render(<ThemeHost preference="dark" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });
});

describe('applyInitialTheme', () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'wirebench');
    localStorage.clear();
    setOsTheme('dark');
  });

  it('paints a light OS under the system preference before the first render', () => {
    stubBridge('light');
    expect(applyInitialTheme('system')).toBe('light');
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(getOsTheme()).toBe('light');
  });

  it('reads the stored preference when none is passed', () => {
    stubBridge('light');
    localStorage.setItem('wirebench.ui', JSON.stringify({ version: 2, state: { theme: 'dark' } }));
    expect(applyInitialTheme()).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('does not flash dark: the first render under system already carries the light theme', () => {
    stubBridge('light');
    applyInitialTheme('system');
    render(<ThemeHost preference="system" />);
    // No promise flush: if the OS scheme only arrived via `theme.get`, this would read `dark`.
    expect(document.documentElement.dataset['theme']).toBe('light');
  });
});

describe('cycleTheme', () => {
  it('writes the next preference through the preferences store', () => {
    const update = vi.fn().mockResolvedValue(undefined);
    usePreferencesStore.setState({ update });
    useUiStore.setState({ theme: 'light' });

    cycleTheme();
    expect(update).toHaveBeenCalledWith({ ui: { theme: 'system' } });

    useUiStore.setState({ theme: 'system' });
    cycleTheme();
    expect(update).toHaveBeenLastCalledWith({ ui: { theme: 'dark' } });
  });
});

describe('data-palette', () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'wirebench');
    localStorage.clear();
    setOsTheme('dark');
    delete document.documentElement.dataset['palette'];
    useUiStore.getState().setPalette('default');
  });

  it('applyPalette sets the attribute, and default removes it', () => {
    applyPalette('dusk');
    expect(document.documentElement.dataset['palette']).toBe('dusk');
    applyPalette('default');
    expect(document.documentElement.hasAttribute('data-palette')).toBe(false);
  });

  it('applyInitialTheme paints a stored palette before the first render', () => {
    stubBridge('light');
    localStorage.setItem(
      'wirebench.ui',
      JSON.stringify({ version: 5, state: { theme: 'system', palette: 'sandstone' } }),
    );
    expect(applyInitialTheme()).toBe('light');
    expect(document.documentElement.dataset['palette']).toBe('sandstone');
    expect(document.documentElement.dataset['theme']).toBe('light');
  });

  it('applyInitialTheme leaves no attribute for the default palette', () => {
    document.documentElement.dataset['palette'] = 'seed';
    localStorage.setItem('wirebench.ui', JSON.stringify({ version: 4, state: { theme: 'dark' } }));
    expect(applyInitialTheme()).toBe('dark');
    expect(document.documentElement.hasAttribute('data-palette')).toBe(false);
  });

  it('applyInitialTheme takes an explicit palette', () => {
    applyInitialTheme('light', 'rind');
    expect(document.documentElement.dataset['palette']).toBe('rind');
    expect(document.documentElement.dataset['theme']).toBe('light');
  });

  it('useTheme keeps data-palette in step, removing it when switched back to default', () => {
    stubBridge('dark');
    const { rerender } = render(<ThemeHost preference="light" palette="dusk" />);
    expect(document.documentElement.dataset['palette']).toBe('dusk');
    expect(document.documentElement.dataset['theme']).toBe('light');

    rerender(<ThemeHost preference="light" palette="default" />);
    expect(document.documentElement.hasAttribute('data-palette')).toBe(false);
    // The mode resolves as before.
    expect(document.documentElement.dataset['theme']).toBe('light');
  });

  it('usePalette reads the ui store', () => {
    const { getByTestId } = render(<PaletteProbe />);
    expect(getByTestId('palette').textContent).toBe('default');
    act(() => {
      useUiStore.getState().setPalette('pith');
    });
    expect(getByTestId('palette').textContent).toBe('pith');
  });
});
