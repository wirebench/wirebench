import type { AssertionResult, AssertionSubject, SoapFaultAssertion } from './model.js';

/** Checks whether a SOAP fault is present in the response. */
export function evaluateSoapFault(subject: AssertionSubject, assertion: SoapFaultAssertion): AssertionResult {
  const base = {
    type: 'soap-fault' as const,
    label: assertion.name ?? (assertion.expect === 'none' ? 'no SOAP fault' : 'a SOAP fault'),
  };
  if (subject.protocol !== 'soap' || subject.fault === undefined) {
    return { ...base, outcome: 'errored', message: 'soap-fault applies to a SOAP request only' };
  }
  const wanted = assertion.expect === 'present';
  if (subject.fault.present === wanted) {
    return { ...base, outcome: 'passed' };
  }
  return {
    ...base,
    outcome: 'failed',
    expected: wanted ? 'a fault' : 'no fault',
    actual: subject.fault.present ? (subject.fault.summary ?? 'a fault') : 'no fault',
  };
}
