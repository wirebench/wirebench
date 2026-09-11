/**
 * The WS-I Basic Profile 1.1 assertion contracts.
 *
 * An *assertion* is one testable requirement of the profile (`R2001`, `R2705`, …). Each lives in
 * its own module under `assertions/`, is registered in `assertions/index.ts`, and is evaluated by
 * `runWsdlAssertions` against a {@link WsiWsdlContext} — the parsed WSDL plus the raw documents it
 * was parsed from, so an assertion can look at constructs the model deliberately drops.
 *
 * Profile text is quoted only in short fragments (it is published under the WS-I document
 * licence); the rest of every assertion's description is a paraphrase.
 */

import type { Document } from '@xmldom/xmldom';
import type { WsdlDefinition } from '../../wsdl/model.js';
import type { DefinitionBundle } from '../../wsdl/resolver.js';
import type { SchemaSet } from '../../xsd/schema-set.js';

/** Conformance level of an assertion: a `MUST`, a `SHOULD`, or a `MAY` in the profile's wording. */
export type WsiAssertionLevel = 'REQUIRED' | 'RECOMMENDED' | 'PERMITTED';

/**
 * Outcome of evaluating one assertion:
 * - `passed` — the construct occurs and conforms;
 * - `failed` — a `REQUIRED` assertion is violated;
 * - `warning` — a `RECOMMENDED` assertion is violated;
 * - `notApplicable` — the construct the assertion is about does not occur at all.
 */
export type WsiAssertionResult = 'passed' | 'failed' | 'warning' | 'notApplicable';

/** Where in the description a finding was raised. */
export interface WsiLocation {
  /** Absolute location of the document holding the offending construct. */
  readonly document: string;
  /** 1-based line within that document. */
  readonly line?: number;
  /** 1-based column within that document. */
  readonly column?: number;
  /** A readable element path, e.g. `/definitions/binding[@name='EchoBinding']`. */
  readonly xpath?: string;
}

/** One concrete violation of an assertion. */
export interface WsiFinding {
  readonly message: string;
  readonly location?: WsiLocation;
}

/** The sentinel a `check` returns when the construct it examines does not occur. */
export interface WsiNotApplicable {
  readonly applicable: false;
}

/** The sentinel value assertions return instead of vacuously passing. */
export const NOT_APPLICABLE: WsiNotApplicable = Object.freeze({ applicable: false });

/** What an assertion's `check` returns: findings (possibly none), or {@link NOT_APPLICABLE}. */
export type WsiCheckOutcome = readonly WsiFinding[] | WsiNotApplicable;

/** Narrows a {@link WsiCheckOutcome} to the not-applicable sentinel. */
export function isNotApplicable(outcome: WsiCheckOutcome): outcome is WsiNotApplicable {
  return 'applicable' in outcome;
}

/** Everything a WSDL-level assertion may inspect. */
export interface WsiWsdlContext {
  /** The merged, parsed definition. */
  readonly definition: WsdlDefinition;
  /** The resolved import graph, including every document's raw text and kind. */
  readonly bundle: DefinitionBundle;
  /** The compiled schema set, for resolving element/type references. */
  readonly schemaSet: SchemaSet;
  /** Every document of the bundle, keyed by its canonical location. */
  readonly documents: ReadonlyMap<string, Document>;
}

/** One testable requirement of the profile. */
export interface WsiAssertion {
  /** The profile's requirement id, e.g. `R2001`. */
  readonly id: string;
  /** A one-line, paraphrased statement of the requirement. */
  readonly title: string;
  readonly level: WsiAssertionLevel;
  /** The profile section the requirement belongs to, e.g. `4.1 Required Description Formats`. */
  readonly section: string;
  /** Evaluates the requirement against one description. */
  check(context: WsiWsdlContext): WsiCheckOutcome;
}

/** One assertion's entry in a {@link WsiReport}. */
export interface WsiAssertionReport {
  readonly id: string;
  readonly title: string;
  readonly level: WsiAssertionLevel;
  readonly section: string;
  readonly result: WsiAssertionResult;
  readonly findings: readonly WsiFinding[];
}

/** How many assertions ended in each result. Always counts every assertion that ran. */
export interface WsiSummary {
  readonly passed: number;
  readonly failed: number;
  readonly warning: number;
  readonly notApplicable: number;
}

/** The result of analysing one description against the profile. */
export interface WsiReport {
  /** The location of the description that was analysed (the bundle's root document). */
  readonly target: string;
  readonly profile: 'BP1.1';
  /** Counts across every assertion that ran, regardless of `verbose`. */
  readonly summary: WsiSummary;
  /** Every assertion when `verbose`, only the failed/warning ones otherwise. */
  readonly assertions: readonly WsiAssertionReport[];
}
