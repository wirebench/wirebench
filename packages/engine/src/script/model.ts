/**
 * What a script sees and hands back (spec §API). A request and a response cross into the sandbox as
 * a JSON snapshot; a pre-request script hands back the snapshot it changed, which the host checks and
 * applies (`apply.ts`) — nothing a script returns is trusted as it stands.
 */
import type { ScriptPosition } from './sandbox/model.js';

export type ScriptProtocol = 'rest' | 'soap' | 'grpc';
export type ScriptPhase = 'pre' | 'post';
/** Which API a script is written against: the typed one, or the Postman layer (§Postman). */
export type ScriptApi = 'wirebench' | 'postman';

/** A header or metadata entry, in order; names may repeat. */
export type HeaderPair = readonly [name: string, value: string];

/** A REST request body as a script sees it: text it can read and replace, or a kind it cannot edit. */
export type RestBodySnapshot =
  | { readonly kind: 'none' }
  | { readonly kind: 'text'; readonly text: string; readonly language: string }
  /** A form, multipart or binary body: kept as it is, and not editable from a script. */
  | { readonly kind: 'other'; readonly description: string };

export interface RestRequestSnapshot {
  readonly protocol: 'rest';
  readonly method: string;
  /** The full URL, query included, as it will be sent. */
  readonly url: string;
  readonly headers: readonly HeaderPair[];
  readonly body: RestBodySnapshot;
}

export interface SoapRequestSnapshot {
  readonly protocol: 'soap';
  readonly endpoint: string;
  readonly soapAction: string;
  readonly headers: readonly HeaderPair[];
  /** The whole envelope, after property expansion and before WS-Addressing or WS-Security. */
  readonly envelope: string;
}

export interface GrpcRequestSnapshot {
  readonly protocol: 'grpc';
  readonly target: string;
  /** `package.Service/Method`; a script cannot change it. */
  readonly method: string;
  readonly metadata: readonly HeaderPair[];
  /** The request message in its JSON form. */
  readonly message: unknown;
}

export type RequestSnapshot = RestRequestSnapshot | SoapRequestSnapshot | GrpcRequestSnapshot;

export interface RestResponseSnapshot {
  readonly protocol: 'rest';
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly HeaderPair[];
  readonly text: string;
  readonly durationMs: number;
}

export interface SoapResponseSnapshot {
  readonly protocol: 'soap';
  readonly status: number;
  readonly headers: readonly HeaderPair[];
  /** The response envelope. */
  readonly text: string;
  readonly durationMs: number;
  readonly fault?: { readonly code: string; readonly reason: string };
}

export interface GrpcResponseSnapshot {
  readonly protocol: 'grpc';
  readonly status: { readonly code: number; readonly name: string; readonly message: string };
  readonly metadata: readonly HeaderPair[];
  readonly trailers: readonly HeaderPair[];
  /** The response message in its JSON form, when there was one. */
  readonly message: unknown;
  readonly durationMs: number;
}

export type ResponseSnapshot = RestResponseSnapshot | SoapResponseSnapshot | GrpcResponseSnapshot;

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
      readonly request?: RequestSnapshot;
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
