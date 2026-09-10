import { describe, expect, it, vi } from 'vitest';
import { buildApi } from '../src/preload/build-api.js';

describe('buildApi', () => {
  it('wires app.version to invoke with the channel name', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { version: '0.1.0', electron: '44.0.0', node: '24.0.0' } });
    const api = buildApi(invoke, vi.fn());

    await api.app.version(undefined);

    expect(invoke).toHaveBeenCalledWith('app.version', undefined);
  });

  it('exposes only the channel/event surface, never ipcRenderer itself', () => {
    const api = buildApi(vi.fn(), vi.fn());

    expect(Object.keys(api).sort()).toEqual(['app', 'definition', 'on', 'request']);
    expect('ipcRenderer' in api).toBe(false);
  });

  it('registers event listeners via the injected on() and returns its unsubscribe', () => {
    const unsubscribe = vi.fn();
    const on = vi.fn().mockReturnValue(unsubscribe);
    const api = buildApi(vi.fn(), on);
    const listener = vi.fn();

    const result = api.on('app.ready', listener);

    expect(on).toHaveBeenCalledWith('app.ready', listener);
    expect(result).toBe(unsubscribe);
  });
});
