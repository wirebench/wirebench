import type { AssertionResult, AssertionSubject, StatusAssertion } from './model.js';

/** The shape of a status name (`NOT_FOUND`), as opposed to an `Nxx` class. */
const STATUS_NAME = /^[A-Z][A-Z_]*$/;

function holdsHttp(expected: number | string, status: number): boolean {
  return typeof expected === 'number' ? expected === status : Number(expected[0]) === Math.floor(status / 100);
}

/**
 * Checks the response status against one or more expected values. A subject that carries
 * `statusNames` is compared by exact code or by name; any other by HTTP code or `Nxx` class.
 */
export function evaluateStatus(subject: AssertionSubject, assertion: StatusAssertion): AssertionResult {
  const expected: readonly (number | string)[] =
    typeof assertion.equals === 'number' || typeof assertion.equals === 'string'
      ? [assertion.equals]
      : assertion.equals;
  const text = expected.join(' or ');
  const base = { type: 'status' as const, label: assertion.name ?? `status is ${text}` };

  const names = subject.statusNames;
  if (names !== undefined) {
    const unknownName = expected.find((value) => typeof value === 'string' && !names.byName.has(value));
    if (unknownName !== undefined) {
      return { ...base, outcome: 'errored', message: `${String(unknownName)} is not a gRPC status name` };
    }
    const matched = expected.some((value) =>
      typeof value === 'number' ? value === subject.status : names.byName.get(value) === subject.status,
    );
    return matched
      ? { ...base, outcome: 'passed' }
      : { ...base, outcome: 'failed', expected: text, actual: names.nameOf(subject.status) };
  }

  const statusName = expected.find((value) => typeof value === 'string' && STATUS_NAME.test(value));
  if (statusName !== undefined) {
    return { ...base, outcome: 'errored', message: `${String(statusName)} is a gRPC status name, not an HTTP one` };
  }
  const notHttp = expected.find((value) => typeof value === 'number' && value < 100);
  if (notHttp !== undefined) {
    return { ...base, outcome: 'errored', message: `${String(notHttp)} is not an HTTP status` };
  }
  return expected.some((value) => holdsHttp(value, subject.status))
    ? { ...base, outcome: 'passed' }
    : { ...base, outcome: 'failed', expected: text, actual: String(subject.status) };
}
