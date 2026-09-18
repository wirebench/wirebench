import type { AssertionResult, AssertionSubject, SlaAssertion } from './model.js';

/** Checks that the response arrived within a maximum duration. */
export function evaluateSla(subject: AssertionSubject, assertion: SlaAssertion): AssertionResult {
  const base = { type: 'sla' as const, label: assertion.name ?? `responds within ${assertion.maxMs} ms` };
  const actual = Math.round(subject.durationMs);
  return actual <= assertion.maxMs
    ? { ...base, outcome: 'passed' }
    : { ...base, outcome: 'failed', expected: `<= ${assertion.maxMs} ms`, actual: `${actual} ms` };
}
