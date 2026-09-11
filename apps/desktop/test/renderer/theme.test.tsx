import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { cycleTheme } from '../../src/renderer/lib/theme-actions.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import {
  getOsTheme,
  nextThemePreference,
  resolveTheme,
  setOsTheme,
  startOsThemeBridge,
  useTheme,
} from '../../src/renderer/lib/theme.js';

/** A component whose only job is to run the hook under test. */
function ThemeHost({ preference }: { preference: 'dark' | 'light' | 'system' }) {
  useTheme(preference);
  return null;
}

/** The `theme.changed` listeners a fake preload bridge collected. */
let themeListeners: ((payload: unknown) => void)[] = [];

function stubBridge(os: 'dark' | 'light') {
  themeListeners = [];
  Object.defineProperty(window, 'wirebench', {
    configurable: true,
    value: {
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
