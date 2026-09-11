import { vi } from 'vitest';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import type { PreferencesWire } from '../../src/shared/wire-types.js';
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
/** The defaults with one patch merged in, section by section — what main would answer. */
function mergedPreferences(patch: Record<string, Record<string, unknown>>): PreferencesWire {
  const merged = { ...DEFAULT_PREFERENCES_WIRE } as unknown as Record<string, unknown>;
  for (const [section, values] of Object.entries(patch)) {
    merged[section] = { ...(merged[section] as object), ...values };
  }
  return merged as unknown as PreferencesWire;
}

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
      recreate: fail('request.recreate'),
      curl: fail('request.curl'),
      importCurl: fail('request.importCurl'),
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
    dialogs: {
      openFile: fail('dialogs.openFile'),
      openFolder: fail('dialogs.openFolder'),
      saveFile: fail('dialogs.saveFile'),
    },
    // Preferences resolve to the defaults rather than a failure: the shell loads them on mount,
    // so every renderer test would otherwise have to stub a channel it does not care about.
    preferences: {
      get: vi.fn().mockResolvedValue({ ok: true, value: { preferences: DEFAULT_PREFERENCES_WIRE } }),
      // Mirrors main's deep merge rather than always echoing the defaults: the renderer treats
      // the reply as authoritative, so a stub that forgot the patch would silently undo it.
      update: vi.fn((request: { patch: Record<string, Record<string, unknown>> }) =>
        Promise.resolve({ ok: true as const, value: { preferences: mergedPreferences(request.patch) } }),
      ),
      reset: vi.fn().mockResolvedValue({ ok: true, value: { preferences: DEFAULT_PREFERENCES_WIRE } }),
    },
    secrets: {
      set: fail('secrets.set'),
      replace: fail('secrets.replace'),
      exists: fail('secrets.exists'),
      delete: fail('secrets.delete'),
      list: fail('secrets.list'),
      setShowSecrets: fail('secrets.setShowSecrets'),
      getShowSecrets: fail('secrets.getShowSecrets'),
    },
    xml: {
      completions: fail('xml.completions'),
      declaration: fail('xml.declaration'),
      describeMany: vi.fn().mockResolvedValue({ ok: true, value: { results: [] } }),
    },
    exchanges: { get: fail('exchanges.get') },
    attachments: {
      saveResponse: fail('attachments.saveResponse'),
      openResponse: fail('attachments.openResponse'),
      openRequest: fail('attachments.openRequest'),
      pickFiles: fail('attachments.pickFiles'),
      addDropped: fail('attachments.addDropped'),
    },
    keystores: {
      inspect: fail('keystores.inspect'),
      pickFile: fail('keystores.pickFile'),
    },
    wss: {
      previewOutgoing: fail('wss.previewOutgoing'),
      insertEntry: fail('wss.insertEntry'),
      removeOutgoing: fail('wss.removeOutgoing'),
    },
    history: {
      list: fail('history.list'),
      get: fail('history.get'),
      clear: fail('history.clear'),
      resend: fail('history.resend'),
    },
    validate: { message: fail('validate.message') },
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
