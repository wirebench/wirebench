/**
 * The types a mock operation's `dispatch.ts` is checked against (#352): the shared helpers, and the
 * request, responses, scenarios and `respond` the dispatch prelude (`../../mock/script.ts`) defines.
 * A dispatch script has no vars, props, secrets or tests, so none of those are declared.
 *
 * `WbResponseName` is the union of the operation's response names, so naming a response the
 * operation does not have is a type error rather than a `mock-script-failed` at the first request.
 */
import type { ApiReferenceSection } from './api.js';
import { SCRIPT_UTILITIES } from './utilities.js';

const DISPATCH = `
/** The request the mock received. */
declare const request: {
  /** The operation's key: a SOAP operation name, or REST \`<method> <path>\`. */
  readonly operation: string;
  /** Upper case. */
  readonly method: string;
  /** The path as received, without the query, percent-encoding kept. */
  readonly path: string;
  /** Each query parameter's values, in order, decoded. */
  readonly query: { readonly [name: string]: readonly string[] };
  /** Every header in order; names may repeat. */
  readonly headers: readonly (readonly [name: string, value: string])[];
  /** REST: the values of the operation path's parameters. Empty on SOAP. */
  readonly pathParams: { readonly [name: string]: string };
  /** The body as text, cut to its first MiB. */
  readonly body: string;
};
/** The operation's responses that may be sent in the current scenario states, in order. */
declare const responses: readonly { readonly id: string; readonly name: WbResponseName }[];
/** Scenario states. Every scenario starts in \`Started\`. */
declare const scenarios: {
  get(name: string): string;
  /** A name and a state hold only letters, digits, _, . and -, at most 64. */
  set(name: string, state: string): void;
};
/** Sends the named response. Without a call, the operation's default response is sent. */
declare function respond(name: WbResponseName): void;
`;

/** `type WbResponseName = ...` for an operation's response names (`never` when it has none). */
function responseNameType(names: readonly string[]): string {
  const unique = [...new Set(names)].map((name) => JSON.stringify(name));
  return `type WbResponseName = ${unique.length > 0 ? unique.join(' | ') : 'never'};\n`;
}

/** Everything a dispatch script is checked against, for an operation whose responses are `responseNames`. */
export function dispatchDeclarations(responseNames: readonly string[]): string {
  return `${SCRIPT_UTILITIES}\n${DISPATCH}\n${responseNameType(responseNames)}`;
}

/** The dispatch API as the docs site's reference shows it. */
export function dispatchReference(): ApiReferenceSection {
  return { title: 'Mock dispatch scripts', declarations: DISPATCH };
}
