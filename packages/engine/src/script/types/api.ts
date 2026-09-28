/**
 * The static half of a script's types: the API's declarations, per protocol and phase (spec §API).
 * They refer to the aliases the generated half defines from the request's contract
 * (`rest.ts`, `grpc.ts`, `xsd.ts`): `WbRequestBody` / `WbResponse` for REST, `WbSoapRequestBody` /
 * `WbSoapResponseBody` for SOAP, `WbRequestMessage` / `WbResponseMessage` for gRPC, and `WbSecretName`.
 *
 * A script is a global script, not a module: these are ambient declarations, one file per script.
 */
import type { ScriptPhase, ScriptProtocol } from '../model.js';

const range = (from: number, to: number): string =>
  Array.from({ length: to - from + 1 }, (_, i) => String(from + i)).join(' | ');

/** Every HTTP status a response can have, as literals, so an arm's status narrows exactly. */
const STATUS_TYPES = `
/** Any HTTP status, as literals, so that checking \`response.status\` narrows the response. */
type WbStatus = ${range(100, 599)};
type WbRange1 = Extract<WbStatus, ${range(100, 199)}>;
type WbRange2 = Extract<WbStatus, ${range(200, 299)}>;
type WbRange3 = Extract<WbStatus, ${range(300, 399)}>;
type WbRange4 = Extract<WbStatus, ${range(400, 499)}>;
type WbRange5 = Extract<WbStatus, ${range(500, 599)}>;
`;

const COMMON = `
/** A case-insensitive list of headers (or gRPC metadata), in order. Names may repeat. */
interface WbPairs {
  get(name: string): string | undefined;
  getAll(name: string): string[];
  has(name: string): boolean;
  list(): { name: string; value: string }[];
  toObject(): Record<string, string>;
}
/** Headers a pre-request script can change. A value may not hold CR, LF or NUL. */
interface WbWritablePairs extends WbPairs {
  /** Replaces every entry of that name with one, where the first one was. */
  set(name: string, value: string): void;
  add(name: string, value: string): void;
  delete(name: string): void;
}

interface WbExpectation<T> {
  toBe(expected: T): void;
  toEqual(expected: T): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  toBeNull(): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toContain(item: T extends readonly (infer I)[] ? I : string): void;
  toMatch(pattern: RegExp | string): void;
  toBeGreaterThan(value: number): void;
  toBeLessThan(value: number): void;
  toHaveLength(length: number): void;
  toHaveProperty(path: string | readonly string[], value?: unknown): void;
  readonly not: Omit<WbExpectation<T>, 'not'>;
}

/** This run's values: set here, read by later requests as \`\${#Sequence#name}\`. */
declare const vars: {
  get(name: string): string | undefined;
  /** A value is used exactly as set: never expanded, always escaped where it lands. */
  set(name: string, value: string | number | boolean, options?: { secret?: boolean }): void;
};
/** Resolved properties. A secret is never returned. */
declare const props: { get(name: string): string | undefined };
/** The secrets this request's \`scripts.secrets\` lists, and no others. */
declare const secrets: { get(name: WbSecretName): string };
declare const crypto: {
  hash(algorithm: 'md5' | 'sha1' | 'sha256' | 'sha512', data: string, encoding?: 'hex' | 'base64'): string;
  hmac(algorithm: 'sha1' | 'sha256' | 'sha512', key: string, data: string, encoding?: 'hex' | 'base64'): string;
  randomUUID(): string;
};
declare const encoding: {
  base64(text: string): string;
  fromBase64(text: string): string;
  base64url(text: string): string;
  urlEncode(text: string): string;
};
declare function log(...values: unknown[]): void;
declare const console: {
  log(...values: unknown[]): void;
  info(...values: unknown[]): void;
  warn(...values: unknown[]): void;
  error(...values: unknown[]): void;
  debug(...values: unknown[]): void;
};
/** Records a test; a failed \`expect\` inside it fails the test, and the script goes on. */
declare function test(name: string, check: () => void): void;
declare function expect<T>(actual: T): WbExpectation<T>;
`;

const REST_REQUEST = `
interface WbRestQuery {
  get(name: string): string | undefined;
  getAll(name: string): string[];
  list(): { name: string; value: string }[];
}
interface WbWritableRestQuery extends WbRestQuery {
  set(name: string, value: string): void;
  add(name: string, value: string): void;
  delete(name: string): void;
}
interface WbRestBody {
  /** \`other\` is a form, multipart or binary body, which a script cannot read or change. */
  readonly kind: 'none' | 'text' | 'other';
  readonly text: string;
  readonly json: WbRequestBody;
}
interface WbResponseArm<S extends number, B> {
  readonly status: S;
  readonly statusText: string;
  readonly headers: WbPairs;
  readonly text: string;
  /** The body parsed as JSON, typed from the contract's response for this status. */
  json(): B;
  readonly durationMs: number;
}
interface WbWritableRestBody {
  readonly kind: 'none' | 'text' | 'other';
  text: string;
  json: WbRequestBody;
}
`;

const REST_PRE = `
declare const request: {
  method: string;
  /** The full URL. A script may change the path, query and fragment, never the scheme, host or port. */
  url: string;
  readonly query: WbWritableRestQuery;
  readonly headers: WbWritablePairs;
  readonly body: WbWritableRestBody;
};
`;

const REST_POST = `
declare const request: {
  readonly method: string;
  readonly url: string;
  readonly query: WbRestQuery;
  readonly headers: WbPairs;
  readonly body: WbRestBody;
};
declare const response: WbResponse;
`;

const SOAP_PRE = `
declare const request: {
  readonly endpoint: string;
  soapAction: string;
  readonly headers: WbWritablePairs;
  /** The whole envelope, after property expansion and before WS-Addressing and WS-Security. */
  envelope: string;
  /** The SOAP body's element, typed from the operation's input message. */
  body: WbSoapRequestBody;
};
`;

const SOAP_POST = `
declare const request: {
  readonly endpoint: string;
  readonly soapAction: string;
  readonly headers: WbPairs;
  readonly envelope: string;
  readonly body: WbSoapRequestBody;
};
declare const response: {
  readonly status: number;
  readonly headers: WbPairs;
  readonly envelope: string;
  readonly text: string;
  /** The SOAP body's element, typed from the operation's output message. */
  readonly body: WbSoapResponseBody;
  readonly fault?: { readonly code: string; readonly reason: string };
  /** Strings an XPath expression selects in the response envelope. */
  select(xpath: string, namespaces?: Record<string, string>): string[];
  readonly durationMs: number;
};
`;

const GRPC_PRE = `
declare const request: {
  readonly target: string;
  readonly method: string;
  readonly metadata: WbWritablePairs;
  message: WbRequestMessage;
};
`;

const GRPC_POST = `
declare const request: {
  readonly target: string;
  readonly method: string;
  readonly metadata: WbPairs;
  readonly message: WbRequestMessage;
};
declare const response: {
  readonly status: { readonly code: number; readonly name: string; readonly message: string };
  readonly metadata: WbPairs;
  readonly trailers: WbPairs;
  readonly message: WbResponseMessage | undefined;
  readonly durationMs: number;
};
`;

/** The API's declarations for one protocol and phase. */
export function apiDeclarations(protocol: ScriptProtocol, phase: ScriptPhase): string {
  const parts = [COMMON];
  switch (protocol) {
    case 'rest':
      parts.push(STATUS_TYPES, REST_REQUEST, phase === 'pre' ? REST_PRE : REST_POST);
      break;
    case 'soap':
      parts.push(phase === 'pre' ? SOAP_PRE : SOAP_POST);
      break;
    case 'grpc':
      parts.push(phase === 'pre' ? GRPC_PRE : GRPC_POST);
      break;
  }
  return parts.join('\n');
}

/** `type WbSecretName = ...` for the secrets a request lists (`never` when it lists none). */
export function secretNameType(secrets: readonly string[]): string {
  const names = secrets.map((name) => JSON.stringify(name));
  return `type WbSecretName = ${names.length > 0 ? names.join(' | ') : 'never'};\n`;
}

/** Everything a script is checked against: the API, its secret names, and the request's generated types. */
export function scriptDeclarations(
  protocol: ScriptProtocol,
  phase: ScriptPhase,
  secrets: readonly string[],
  generated: string,
): string {
  return `${apiDeclarations(protocol, phase)}\n${secretNameType(secrets)}\n${generated}`;
}
