/**
 * What a plugin call in the sandbox is given and hands back (phase 7 spec §7, ADR-0031). Plain data
 * only: the plugin's module text, which export to call, its arguments as JSON, and the limits.
 */

/** The limits every plugin call is held to. */
export const PLUGIN_LIMITS = {
  /** Wall clock for one call, network included. */
  callMs: 60_000,
  /** What `detect` gets: it runs on every import no built-in claims. */
  detectMs: 1_000,
  /** How much of a file `detect` is shown. */
  detectBytes: 1024 * 1024,
  /** How long past its deadline the host waits before it terminates and replaces the worker. */
  backstopMs: 1_000,
  memoryBytes: 128 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  /** The largest input and the largest result. */
  ioBytes: 32 * 1024 * 1024,
  logLines: 1_000,
  logLineBytes: 1_000,
  /** Calls waiting behind the running one before new ones are refused. */
  queue: 16,
} as const;

/** The three contribution points, as the module exports them. */
export type PluginPoint = 'importers' | 'reporters' | 'codeGenerators';

/** One call of one contribution's method. */
export interface PluginJob {
  readonly pluginId: string;
  /** The plugin's `main.js`, the bytes the loader hashed. */
  readonly code: string;
  readonly point: PluginPoint;
  readonly contribution: string;
  readonly method: 'detect' | 'import' | 'render' | 'generate';
  /** JSON-shaped arguments, before the context the sandbox adds last. */
  readonly args: readonly unknown[];
  /** Whether the context gets `net`: only an importer's `import` of a plugin that lists origins. */
  readonly net: boolean;
  readonly timeoutMs: number;
}

export type PluginFailureCause = 'timeout' | 'memory' | 'error';

export type PluginJobResult =
  | { readonly ok: true; readonly value: unknown; readonly log: readonly string[] }
  | {
      readonly ok: false;
      readonly cause: PluginFailureCause;
      readonly message: string;
      readonly log: readonly string[];
    };

/** What the worker asks the host when the plugin calls `net.fetch`; the host answers with JSON text. */
export interface PluginFetchAsk {
  readonly kind: 'fetch';
  readonly id: number;
  readonly fetchId: number;
  /** The request as the plugin wrote it, JSON text; the host validates it. */
  readonly request: string;
}

export interface PluginFetchAnswer {
  readonly kind: 'fetched';
  readonly fetchId: number;
  readonly ok: boolean;
  /** A `NetResponse` as JSON text when `ok`, else the error message. */
  readonly text: string;
}
