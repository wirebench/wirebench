import { beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeToGlobals, useGlobalsStore } from '../../src/renderer/state/globals.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const ok = (properties: Record<string, string>) => ({ ok: true, value: { properties } });

describe('useGlobalsStore', () => {
  beforeEach(() => {
    useGlobalsStore.setState({ properties: {} });
  });

  it('load() mirrors the map main returns', async () => {
    installWirebenchApi({ globals: { get: vi.fn().mockResolvedValue(ok({ token: 'abc' })) } });

    await useGlobalsStore.getState().load();

    expect(useGlobalsStore.getState().properties).toEqual({ token: 'abc' });
  });

  it('keeps the last good map when a channel fails', async () => {
    useGlobalsStore.setState({ properties: { token: 'abc' } });
    installWirebenchApi({
      globals: { get: vi.fn().mockResolvedValue({ ok: false, error: { code: 'boom', message: 'boom' } }) },
    });

    await useGlobalsStore.getState().load();

    expect(useGlobalsStore.getState().properties).toEqual({ token: 'abc' });
  });

  it('set() and remove() send the change and replace the mirror with the reply', async () => {
    const set = vi.fn().mockResolvedValue(ok({ token: 'abc', who: 'ada' }));
    const remove = vi.fn().mockResolvedValue(ok({ token: 'abc' }));
    installWirebenchApi({ globals: { set, remove } });

    await useGlobalsStore.getState().set('who', 'ada');
    expect(set).toHaveBeenCalledWith({ name: 'who', value: 'ada' });
    expect(useGlobalsStore.getState().properties).toEqual({ token: 'abc', who: 'ada' });

    await useGlobalsStore.getState().remove('who');
    expect(remove).toHaveBeenCalledWith({ name: 'who' });
    expect(useGlobalsStore.getState().properties).toEqual({ token: 'abc' });
  });

  it('subscribeToGlobals pulls the map and applies later globals.changed events', () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const off = vi.fn();
    installWirebenchApi({
      globals: { get: vi.fn().mockResolvedValue(ok({})) },
      on: vi.fn().mockImplementation((name: string, listener: (payload: unknown) => void) => {
        listeners.set(name, listener);
        return off;
      }),
    });

    const unsubscribe = subscribeToGlobals();
    listeners.get('globals.changed')?.({ properties: { who: 'ada' } });
    expect(useGlobalsStore.getState().properties).toEqual({ who: 'ada' });

    unsubscribe();
    expect(off).toHaveBeenCalled();
  });
});
