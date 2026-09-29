/**
 * Declarative checks on one response, as a request file carries them (`assertions:`).
 *
 * Deliberately a closed, scriptless catalogue: a check that needs code is what typed scripting is
 * for. Every member is evaluated — a failure does not stop the rest — so a report shows everything
 * that is wrong with a response, not just the first thing.
 */

/** The expression language a `match` assertion is written in. */
export type AssertionLanguage = 'xpath' | 'xquery' | 'jsonpath';

/** Checks the response status code against one or more expected values or `Nxx` classes. */
export interface StatusAssertion {
  readonly type: 'status';
  readonly equals: number | string | readonly (number | string)[];
  readonly name?: string;
}

/** Checks whether a SOAP fault is present in the response. */
export interface SoapFaultAssertion {
  readonly type: 'soap-fault';
  readonly expect: 'none' | 'present';
  readonly name?: string;
}

/** Evaluates an XPath/XQuery/JSONPath expression against the response and checks its result. */
export interface MatchAssertion {
  readonly type: 'match';
  readonly language: AssertionLanguage;
  readonly expression: string;
  readonly namespaces?: Readonly<Record<string, string>>;
  readonly equals?: string | number | boolean;
  readonly matches?: string;
  readonly exists?: boolean;
  readonly name?: string;
}

/** Validates the response body against its declared schema. */
export interface SchemaAssertion {
  readonly type: 'schema';
  readonly name?: string;
}

/** Checks that the response arrived within a maximum duration. */
export interface SlaAssertion {
  readonly type: 'sla';
  readonly maxMs: number;
  readonly name?: string;
}

/** Bounds on a callback assertion (spec §2.1) and the engine's poll interval (§2.3). */
export const CALLBACK_LIMITS = Object.freeze({
  defaultWithinMs: 30_000,
  minWithinMs: 1_000,
  maxWithinMs: 300_000,
  /** How often a waiting callback asks for new captures. A constant; tests inject their own. */
  pollIntervalMs: 1_000,
  /** A catch URL's name, as the server bounds it (`HOOKS_LIMITS.maxNameLength`). */
  maxCatchUrlLength: 100,
  maxHeaderChecks: 20,
  maxExpectChecks: 20,
});

/** One header of a capture: its name ignores case; exactly one of `equals`, `matches`, `exists`. */
export interface CallbackHeaderCheck {
  readonly name: string;
  readonly equals?: string;
  readonly matches?: string;
  readonly exists?: boolean;
}

/** An expression over a capture's body text; exactly one of `equals`, `matches`, `exists`. */
export interface CallbackBodyCheck {
  readonly language: 'jsonpath' | 'xpath';
  readonly path: string;
  readonly equals?: string;
  readonly matches?: string;
  readonly exists?: boolean;
}

/** What picks the capture (spec §2.3): every part given must hold. */
export interface CallbackMatch {
  /** Compared without regard to case. */
  readonly method?: string;
  /** Exact, against the decoded subpath (leading `/`). At most one of `path` and `pathMatches`. */
  readonly path?: string;
  readonly pathMatches?: string;
  readonly headers?: readonly CallbackHeaderCheck[];
  readonly body?: CallbackBodyCheck;
}

/** What is checked on the matched capture; every check is reported. */
export type CallbackCheck =
  { readonly body: CallbackBodyCheck } | { readonly header: CallbackHeaderCheck } | { readonly signature: 'verified' };

/**
 * Waits after the send for the first capture at `catchUrl` that fits `match`, then checks it with
 * `expect` (spec §2). Only a run evaluates it: a desktop Send and `evaluateAssertions` alone cannot.
 */
export interface CallbackAssertion {
  readonly type: 'callback';
  /** The catch URL's name in the server workspace (unique there, case-insensitive). */
  readonly catchUrl: string;
  /** How long to wait after the send finished: {@link CALLBACK_LIMITS}. */
  readonly withinMs: number;
  readonly match: CallbackMatch;
  readonly expect: readonly CallbackCheck[];
  readonly name?: string;
}

/** The union of every declarative check a request file may carry under `assertions:`. */
export type Assertion =
  StatusAssertion | SoapFaultAssertion | MatchAssertion | SchemaAssertion | SlaAssertion | CallbackAssertion;

/** The label of a callback assertion's result: its `name`, else the catch URL it waits on. */
export function callbackLabel(assertion: CallbackAssertion): string {
  return assertion.name ?? `callback ${assertion.catchUrl}`;
}

/**
 * Checks a response header (gRPC: response metadata, then trailers). Name matching ignores case; the
 * first value found is compared.
 *
 * A sequence step may carry it; a request file may not (it reads the response, which a request file's own
 * assertions already cover by `match`).
 */
export interface HeaderAssertion {
  readonly type: 'header';
  readonly header: string;
  readonly equals?: string;
  readonly matches?: string;
  readonly exists?: boolean;
  readonly name?: string;
}

/** What a sequence step may assert: the request catalogue plus {@link HeaderAssertion}. */
export type StepAssertion = Assertion | HeaderAssertion;

/** What an assertion looks at — protocol-neutral, built by the runner from an exchange. */
export interface AssertionSubject {
  readonly protocol: 'soap' | 'rest' | 'grpc';
  readonly status: number;
  readonly durationMs: number;
  /** Decoded response text: the (possibly decrypted) envelope for SOAP, the body text for REST. */
  readonly bodyText: string;
  readonly bodyKind: 'xml' | 'json' | 'other';
  /** SOAP only: whether the response carried a fault, and its summary for the report. */
  readonly fault?: { readonly present: boolean; readonly summary?: string };
  /** SOAP only, when the interface's definition is available: validates the response. */
  readonly validateContract?: () => Promise<readonly { readonly message: string }[]>;
  /**
   * The response headers in wire order (gRPC: metadata, then trailers), for `header` assertions and
   * sequence transfers. Absent means none were recorded.
   */
  readonly headers?: readonly (readonly [string, string])[];
}

/** The outcome of evaluating one assertion against a subject. */
export interface AssertionResult {
  /** `script` for a test a post-response script recorded (#63). */
  readonly type: StepAssertion['type'] | 'script';
  readonly label: string;
  readonly outcome: 'passed' | 'failed' | 'errored';
  readonly expected?: string;
  readonly actual?: string;
  /** Why it errored: an expression that does not compile, a timeout, no contract to validate against. */
  readonly message?: string;
  /** A callback assertion's matched capture, for a link to it (spec §5). */
  readonly capture?: { readonly hookId: string; readonly captureId: string };
}
