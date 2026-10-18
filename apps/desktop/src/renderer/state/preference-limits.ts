/**
 * Every numeric preference's accepted range, keyed by dotted preference key — restated from the
 * engine's `PREFERENCE_NUMBER_LIMITS` for the same reason as `preferences-defaults.ts`: the
 * renderer cannot load the engine's Node-only entry, nor a zod value (its CSP forbids the eval
 * zod probes for). `preference-limits.test.ts` asserts this copy matches the engine's exactly.
 *
 * Main refuses a patch outside these limits, so a Settings field that used looser ones would let
 * the user type a value that then fails to save.
 */

/** The range a numeric preference accepts; `max` absent means no upper bound. */
export interface PreferenceLimit {
  readonly min: number;
  readonly max?: number;
  readonly integer: boolean;
}

export const PREFERENCE_LIMITS = {
  'http.chunkingThreshold': { min: 0, integer: true },
  'http.socketTimeoutMs': { min: 0, max: 3_600_000, integer: true },
  'http.maxConnections': { min: 1, max: 1000, integer: true },
  'proxy.port': { min: 1, max: 65_535, integer: true },
  'ssl.expiryWarningDays': { min: 0, max: 3650, integer: true },
  'rest.maxRedirects': { min: 0, max: 50, integer: true },
  'rest.prettyPrintMaxBytes': { min: 1, max: 1024 * 1024 * 1024, integer: true },
  'rest.oauth2CallbackPort': { min: 1024, max: 65_535, integer: true },
  'editor.fontSize': { min: 6, max: 72, integer: true },
  'editor.tabSize': { min: 1, max: 16, integer: true },
  'ui.historyCap': { min: 1, max: 100_000, integer: true },
  'ui.logSize': { min: 100, max: 5000, integer: true },
  'secrets.sourceCacheSeconds': { min: 0, max: 3600, integer: true },
  'secrets.appLockIdleMinutes': { min: 1, max: 240, integer: true },
  'terminal.reconnectAttempts': { min: 1, max: 100, integer: true },
  'terminal.fontSize': { min: 6, max: 72, integer: true },
  'terminal.lineHeight': { min: 1, max: 2, integer: false },
  'terminal.sessionLogMaxMb': { min: 10, max: 100_000, integer: true },
  'ssh.keepAlive': { min: 0, max: 3600, integer: true },
  'ssh.connectTimeout': { min: 1, max: 600, integer: true },
} as const satisfies Readonly<Record<string, PreferenceLimit>>;
