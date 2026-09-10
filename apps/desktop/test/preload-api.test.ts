import { describe, expect, it, vi } from 'vitest';
import { buildApi } from '../src/preload/build-api.js';

describe('buildApi', () => {
  it('wires app.version to invoke with the channel name', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { version: '0.1.0', electron: '44.0.0', node: '24.0.0' } });
    const api = buildApi(invoke, vi.fn(), vi.fn());

    await api.app.version(undefined);

    expect(invoke).toHaveBeenCalledWith('app.version', undefined);
  });

  it('exposes only the channel/event surface, never ipcRenderer itself', () => {
    const api = buildApi(vi.fn(), vi.fn(), vi.fn());

    expect(Object.keys(api).sort()).toEqual([
      'app',
      'definition',
      'dialogs',
      'exchanges',
      'files',
      'fs',
      'globals',
      'history',
      'on',
      'project',
      'request',
      'secrets',
      'xml',
      'xpath',
    ]);
    expect('ipcRenderer' in api).toBe(false);
  });

  it('exposes secrets.set/replace/exists/delete/list but never secrets.get', () => {
    const api = buildApi(vi.fn(), vi.fn(), vi.fn());

    expect(Object.keys(api.secrets).sort()).toEqual([
      'delete',
      'exists',
      'getShowSecrets',
      'list',
      'replace',
      'set',
      'setShowSecrets',
    ]);
    expect('get' in api.secrets).toBe(false);
  });

  it('exposes files.pathFor as the injected pure helper, not an ipcRenderer call', () => {
    const pathFor = vi.fn().mockReturnValue('/tmp/service.wsdl');
    const api = buildApi(vi.fn(), vi.fn(), pathFor);

    const file = { name: 'service.wsdl' } as File;
    expect(api.files.pathFor(file)).toBe('/tmp/service.wsdl');
    expect(pathFor).toHaveBeenCalledWith(file);
  });

  it('registers event listeners via the injected on() and returns its unsubscribe', () => {
    const unsubscribe = vi.fn();
    const on = vi.fn().mockReturnValue(unsubscribe);
    const api = buildApi(vi.fn(), on, vi.fn());
    const listener = vi.fn();

    const result = api.on('app.ready', listener);

    expect(on).toHaveBeenCalledWith('app.ready', listener);
    expect(result).toBe(unsubscribe);
  });
});
