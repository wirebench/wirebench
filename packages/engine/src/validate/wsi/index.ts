/**
 * WS-I Basic Profile 1.1 conformance analysis of a WSDL description.
 */

export type {
  WsiAssertion,
  WsiAssertionLevel,
  WsiAssertionReport,
  WsiAssertionResult,
  WsiCheckOutcome,
  WsiFinding,
  WsiLocation,
  WsiNotApplicable,
  WsiReport,
  WsiSummary,
  WsiWsdlContext,
} from './types.js';
export { NOT_APPLICABLE, isNotApplicable } from './types.js';
export { WSI_WSDL_ASSERTIONS } from './assertions/index.js';
export { runWsdlAssertions, wsiWsdlContext, wsiProblems } from './run-wsdl.js';
export type { RunWsdlAssertionsOptions, WsiWsdlContextInput } from './run-wsdl.js';
export { renderWsiAssertionsMarkdown, WSI_PLANNED_ASSERTIONS } from './docs.js';
export type { PlannedAssertion } from './docs.js';
