import { matchRegexWithTimeout } from '../xpath/evaluate-async.js';
import type { AssertionResult, AssertionSubject, HeaderAssertion } from './model.js';

/** Long enough to read, short enough that a report stays a report. */
const MAX_ACTUAL_CHARS = 200;

function truncate(text: string): string {
  return text.length > MAX_ACTUAL_CHARS ? `${text.slice(0, MAX_ACTUAL_CHARS)}…` : text;
}

/** The first value of `name` among `headers`, compared without regard to case. */
export function firstHeaderValue(
  headers: readonly (readonly [string, string])[] | undefined,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  return headers?.find(([key]) => key.toLowerCase() === wanted)?.[1];
}

/** Checks one response header: that it exists, equals a value, or matches a pattern. */
export async function evaluateHeader(subject: AssertionSubject, assertion: HeaderAssertion): Promise<AssertionResult> {
  const base = { type: 'header' as const, label: assertion.name ?? `header ${assertion.header}` };
  const actual = firstHeaderValue(subject.headers, assertion.header);
  if (assertion.exists !== undefined) {
    const found = actual !== undefined;
    return found === assertion.exists
      ? { ...base, outcome: 'passed' }
      : {
          ...base,
          outcome: 'failed',
          expected: assertion.exists ? 'present' : 'absent',
          actual: found ? 'present' : 'absent',
        };
  }
  if (actual === undefined) {
    return {
      ...base,
      outcome: 'failed',
      expected: assertion.matches !== undefined ? `/${assertion.matches}/` : String(assertion.equals),
      actual: 'absent',
    };
  }
  if (assertion.matches !== undefined) {
    const matched = await matchRegexWithTimeout(assertion.matches, actual);
    if (matched.kind === 'error') {
      return { ...base, outcome: 'errored', message: matched.message };
    }
    return matched.matched
      ? { ...base, outcome: 'passed' }
      : { ...base, outcome: 'failed', expected: `/${assertion.matches}/`, actual: truncate(actual) };
  }
  const expected = String(assertion.equals);
  return actual === expected
    ? { ...base, outcome: 'passed' }
    : { ...base, outcome: 'failed', expected, actual: truncate(actual) };
}
