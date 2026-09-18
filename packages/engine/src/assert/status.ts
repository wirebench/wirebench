import type { AssertionResult, AssertionSubject, StatusAssertion } from './model.js';

function holds(expected: number | string, status: number): boolean {
  return typeof expected === 'number' ? expected === status : Number(expected[0]) === Math.floor(status / 100);
}

/** Checks the response status code against one or more expected values or `Nxx` classes. */
export function evaluateStatus(subject: AssertionSubject, assertion: StatusAssertion): AssertionResult {
  const expected: readonly (number | string)[] =
    typeof assertion.equals === 'number' || typeof assertion.equals === 'string'
      ? [assertion.equals]
      : assertion.equals;
  const text = expected.join(' or ');
  const base = { type: 'status' as const, label: assertion.name ?? `status is ${text}` };
  return expected.some((value) => holds(value, subject.status))
    ? { ...base, outcome: 'passed' }
    : { ...base, outcome: 'failed', expected: text, actual: String(subject.status) };
}
