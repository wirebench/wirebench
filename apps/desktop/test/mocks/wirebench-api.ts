import { vi } from 'vitest';
import type { WirebenchApi } from '../../src/preload/build-api.js';

/** A deep-partial of the preload API: every channel may be replaced with a mock. */
type ApiOverrides = {
  [K in keyof WirebenchApi]?: WirebenchApi[K] extends object ? Partial<WirebenchApi[K]> : WirebenchApi[K];
};

/**
 * Builds a fully-stubbed `window.wirebench` so a test only has to spell out the channels it
 * actually asserts on. Everything else resolves to a failed `IpcResult` naming the channel,
 * which is far easier to debug than `undefined is not a function`. Domain overrides are
 * merged with the defaults, so stubbing `project.mutate` leaves its siblings in place.
 */
export function stubWirebenchApi(overrides: ApiOverrides = {}): WirebenchApi {
  const fail = (channel: string): unknown =>
    vi.fn().mockResolvedValue({ ok: false, error: { code: 'not-stubbed', message: `${channel} was not stubbed` } });

  const defaults: Record<string, unknown> = {
    app: { version: fail('app.version') },
    definition: {
      import: fail('definition.import'),
      close: fail('definition.close'),
      cancelImport: fail('definition.cancelImport'),
    },
    request: {
      generate: fail('request.generate'),
      send: fail('request.send'),
      cancel: fail('request.cancel'),
      preflight: fail('request.preflight'),
    },
    globals: { get: fail('globals.get'), set: fail('globals.set'), remove: fail('globals.remove') },
    project: {
      create: fail('project.create'),
      open: fail('project.open'),
      close: fail('project.close'),
      snapshot: fail('project.snapshot'),
      mutate: fail('project.mutate'),
      save: fail('project.save'),
      recent: fail('project.recent'),
      addInterface: fail('project.addInterface'),
      reload: fail('project.reload'),
    },
    dialogs: { openFile: fail('dialogs.openFile'), openFolder: fail('dialogs.openFolder') },
    secrets: {
      set: fail('secrets.set'),
      replace: fail('secrets.replace'),
      exists: fail('secrets.exists'),
      delete: fail('secrets.delete'),
      list: fail('secrets.list'),
      setShowSecrets: fail('secrets.setShowSecrets'),
      getShowSecrets: fail('secrets.getShowSecrets'),
    },
    exchanges: { get: fail('exchanges.get') },
    history: {
      list: fail('history.list'),
      get: fail('history.get'),
      clear: fail('history.clear'),
      resend: fail('history.resend'),
    },
    files: { pathFor: vi.fn().mockReturnValue('') },
    on: vi.fn().mockReturnValue(() => undefined),
  };

  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    const base = defaults[key];
    merged[key] =
      typeof base === 'object' && base !== null && typeof value === 'object' && value !== null
        ? { ...base, ...value }
        : value;
  }
  return merged as unknown as WirebenchApi;
}

/** Installs {@link stubWirebenchApi} on `window` and returns it. */
export function installWirebenchApi(overrides: ApiOverrides = {}): WirebenchApi {
  const api = stubWirebenchApi(overrides);
  Object.defineProperty(window, 'wirebench', { configurable: true, value: api });
  return api;
}
