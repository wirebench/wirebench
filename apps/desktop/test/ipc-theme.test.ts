// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  nativeTheme: { shouldUseDarkColors: true, on: () => undefined },
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const { registerThemeChannels, themeOf } = await import('../src/main/ipc/theme.js');

/** A fake `nativeTheme` whose `updated` listener the test can fire by hand. */
function fakeNativeTheme(dark: boolean) {
  const listeners: (() => void)[] = [];
  return {
    shouldUseDarkColors: dark,
    on(_event: 'updated', listener: () => void) {
      listeners.push(listener);
      return this;
    },
    flip(next: boolean) {
      this.shouldUseDarkColors = next;
      for (const listener of listeners) listener();
    },
  };
}

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload);
}

describe('theme ipc', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('maps nativeTheme onto the wire shape', () => {
    expect(themeOf(fakeNativeTheme(true))).toEqual({ os: 'dark' });
    expect(themeOf(fakeNativeTheme(false))).toEqual({ os: 'light' });
  });

  it('answers theme.get with the current OS scheme', async () => {
    registerThemeChannels(vi.fn(), fakeNativeTheme(false));
    await expect(invoke('theme.get', undefined)).resolves.toEqual({ ok: true, value: { os: 'light' } });
  });

  it('broadcasts theme.changed when the OS flips', () => {
    const broadcast = vi.fn();
    const theme = fakeNativeTheme(true);
    registerThemeChannels(broadcast, theme);
    theme.flip(false);
    expect(broadcast).toHaveBeenCalledWith({ os: 'light' });
    theme.flip(true);
    expect(broadcast).toHaveBeenLastCalledWith({ os: 'dark' });
  });
});
