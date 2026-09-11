/**
 * WS-I Basic Profile 1.1 conformance analysis: of a WSDL description (`run-wsdl.ts`) and of one
 * SOAP exchange (`run-message.ts`), plus the shared HTML report renderer.
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
  WsiMessageAssertion,
  WsiMessageBinding,
  WsiMessageContext,
  WsiMessageDirection,
  WsiMessageView,
} from './types.js';
export { NOT_APPLICABLE, isNotApplicable } from './types.js';
export { WSI_WSDL_ASSERTIONS } from './assertions/index.js';
export { runWsdlAssertions, wsiWsdlContext, wsiProblems } from './run-wsdl.js';
export type { RunWsdlAssertionsOptions, WsiWsdlContextInput } from './run-wsdl.js';
export { WSI_MESSAGE_ASSERTIONS } from './assertions/message/index.js';
export { messageBindingFor, runMessageAssertions, wsiMessageContext } from './run-message.js';
export type { RunMessageAssertionsOptions } from './run-message.js';
export { renderWsiAssertionsMarkdown, WSI_PLANNED_ASSERTIONS } from './docs.js';
export type { PlannedAssertion } from './docs.js';
