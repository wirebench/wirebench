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

/** The union of every declarative check a request file may carry under `assertions:`. */
export type Assertion = StatusAssertion | SoapFaultAssertion | MatchAssertion | SchemaAssertion | SlaAssertion;
