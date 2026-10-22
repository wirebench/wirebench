/**
 * What a script run in the sandbox is given and what it hands back (ADR-0016).
 *
 * A job is plain data: the code to run, the prelude that installs the API over the host functions,
 * the JSON the API reads (`input`) and the run's limits. The result is plain data too. Nothing
 * crosses the boundary but strings and JSON-shaped values.
 */

/** The limits every script run is held to (spec §Sandbox). */
export const SCRIPT_LIMITS = {
  /** The default time one script may run, in milliseconds. */
  defaultTimeoutMs: 1_000,
  /** The most a request file may allow (`scripts.timeoutMs`). */
  maxTimeoutMs: 10_000,
  /** How long past its deadline the host waits before it terminates and replaces the worker. */
  backstopMs: 1_000,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  logBytes: 64 * 1024,
  logLines: 1_000,
  /** The largest result (`__finish()`'s JSON) a script may hand back. */
  outputBytes: 16 * 1024 * 1024,
  /** The largest script file (spec §Storage). */
  fileBytes: 256 * 1024,
} as const;

/** One run of a script. */
export interface SandboxJob {
  /**
   * Installs the script's API. It runs before the script, in the same context, and may use the host
   * functions (`__host.*`) and `__input`. It must define `__finish()`, whose return value (JSON-shaped)
   * is the job's `output`.
   */
  readonly prelude: string;
  /** The script, already stripped of types. */
  readonly code: string;
  /** The name errors are reported against, e.g. `Checkout.pre.ts`. */
  readonly filename: string;
  /** JSON-shaped data the prelude reads as `__input`. */
  readonly input: unknown;
  /** Milliseconds the prelude and the script may run together. */
  readonly timeoutMs: number;
}

/** Where a script failed, in the script's own file. Lines and columns are 1-based. */
export interface ScriptPosition {
  readonly line: number;
  readonly column: number;
}

export type SandboxErrorCode = 'script-error' | 'script-timeout' | 'script-memory';

export interface SandboxError {
  readonly code: SandboxErrorCode;
  readonly message: string;
  /** Set when the failure is in the script itself (not the prelude) and its position is known. */
  readonly position?: ScriptPosition;
}

export interface SandboxLog {
  /** The text `log(...)` produced, capped (`SCRIPT_LIMITS.logBytes` / `logLines`). */
  readonly lines: readonly string[];
  /** True when lines were dropped or cut short to keep within the caps. */
  readonly truncated: boolean;
}

export type SandboxResult =
  | { readonly ok: true; readonly output: unknown; readonly log: SandboxLog }
  | { readonly ok: false; readonly error: SandboxError; readonly log: SandboxLog; readonly output?: unknown };
