/**
 * The preferences a first run gets.
 *
 * Restated here rather than imported, twice over: the renderer may only load the engine's
 * browser-safe `@wirebench/engine/xml` subpath (the preferences model lives in the Node-only
 * main entry), and it must not pull a *value* out of `shared/wire-types.ts` either — that
 * module's zod schemas compile validators at runtime, which the renderer's strict CSP forbids.
 * `preferences-defaults.test.ts` asserts this copy stays identical to `DEFAULT_PREFERENCES`.
 */

import type { PreferencesWire } from '../../shared/wire-types.js';

export const DEFAULT_PREFERENCES_WIRE: PreferencesWire = {
  http: {
    version: '1.1',
    userAgent: 'Wirebench/0.1',
    requestCompression: 'none',
    responseCompression: true,
    closeConnections: false,
    chunkingThreshold: 0,
    socketTimeoutMs: 60_000,
    maxConnections: 100,
    allowH2: false,
  },
  proxy: { mode: 'none', excludes: [] },
  ssl: { minVersion: 'TLSv1.2', trustAll: false },
  wsdl: {
    cacheDefinitions: true,
    prettyPrint: true,
    sampleValues: false,
    typeComments: false,
    includeOptional: true,
    strictSchema: false,
    compression: false,
    nameWithBinding: false,
  },
  wsi: { verbose: false, profile: 'BP1.1' },
  editor: {
    fontSize: 13,
    tabSize: 3,
    lineNumbers: true,
    wordWrap: false,
    autoValidateOnSend: false,
    autoFormatResponses: true,
    autosave: false,
  },
  ui: {
    theme: 'dark',
    defaultLayout: { orientation: 'side-by-side', mode: 'split' },
    confirmOnDelete: true,
    historyCap: 1000,
  },
  updates: { checkOnLaunch: false },
  shortcuts: {},
};
