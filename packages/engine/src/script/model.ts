/**
 * What a script sees and hands back (spec §API). A request and a response cross into the sandbox as
 * a JSON snapshot; a pre-request script hands back the snapshot it changed, which the host checks and
 * applies (`apply.ts`) — nothing a script returns is trusted as it stands.
 */
import type { RequestSnapshotBase } from '../protocol/module.js';
import type { ScriptPosition } from './sandbox/model.js';

export type ScriptPhase = 'pre' | 'post';
/** Which API a script is written against: the typed one, or the Postman layer (§Postman). */
export type ScriptApi = 'wirebench' | 'postman';

/** A header or metadata entry, in order; names may repeat. */
export type HeaderPair = readonly [name: string, value: string];

/** One `test(...)` a script recorded. */
export interface ScriptTest {
  readonly name: string;
  readonly passed: boolean;
  readonly message?: string;
}

/** One `vars.set(...)` a script made. Held to ADR-0015 wherever it is used. */
export interface ScriptValue {
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
}

export type ScriptErrorCode =
  | 'script-error'
  | 'script-timeout'
  | 'script-memory'
  | 'script-syntax-error'
  | 'script-origin-change'
  | 'script-value-invalid'
  | 'script-secret-denied'
  | 'script-unsupported';

export interface ScriptFailure {
  readonly code: ScriptErrorCode;
  readonly message: string;
  readonly position?: ScriptPosition;
}

export interface ScriptLog {
  readonly lines: readonly string[];
  readonly truncated: boolean;
}

/** What running one script produced. `request` is set only for a pre-request script that succeeded. */
export type ScriptOutcome =
  | {
      readonly ok: true;
      readonly request?: RequestSnapshotBase;
      readonly tests: readonly ScriptTest[];
      readonly values: readonly ScriptValue[];
      readonly log: ScriptLog;
    }
  | {
      readonly ok: false;
      readonly error: ScriptFailure;
      readonly tests: readonly ScriptTest[];
      readonly values: readonly ScriptValue[];
      readonly log: ScriptLog;
    };

/** Caps on what a script hands back (spec §Sandbox). */
export const SCRIPT_OUTPUT_LIMITS = {
  tests: 1_000,
  values: 100,
  valueBytes: 64 * 1024,
} as const;

/** A script file as loaded. `problem` is set when it could not be used; such a request refuses to send. */
export interface ScriptSource {
  readonly text: string;
  readonly problem?: 'script-file-missing' | 'script-too-large';
}

/**
 * A request's scripts (spec §Storage): the `scripts` key of a SOAP, REST or gRPC request file, with
 * the text of each script file beside it.
 */
export interface RequestScripts {
  readonly pre?: ScriptSource;
  readonly post?: ScriptSource;
  readonly api: ScriptApi;
  /** False keeps the scripts but runs none of them; the Postman importer writes false (§Postman). */
  readonly enabled: boolean;
  /** The secrets a script may read with `secrets.get` (§Secrets). */
  readonly secrets: readonly string[];
  /** Per script; absent means {@link SCRIPT_LIMITS.defaultTimeoutMs}. */
  readonly timeoutMs?: number;
}

/**
 * The file a request's script lives in, beside the request file: `<slug>.pre.ts` for the typed API,
 * `<slug>.pre.js` for the Postman layer. Always derived from the slug, never read from the request
 * file, so a hand-edited name cannot point outside the request's directory.
 */
export function scriptFileName(slug: string, phase: ScriptPhase, api: ScriptApi): string {
  return `${slug}.${phase}.${api === 'postman' ? 'js' : 'ts'}`;
}

/** True for `<slug>.pre.ts`, `<slug>.post.ts`, `<slug>.pre.js` or `<slug>.post.js` of this slug. */
export function isScriptFileOf(name: string, slug: string): boolean {
  return /^\.(pre|post)\.(ts|js)$/.test(name.startsWith(slug) ? name.slice(slug.length) : '');
}
