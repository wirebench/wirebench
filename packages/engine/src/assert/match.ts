import { evaluateWithTimeout } from '../xpath/evaluate-async.js';
import type { QueryResult } from '../xpath/evaluate.js';
import type { AssertionResult, AssertionSubject, MatchAssertion } from './model.js';

/** Long enough to read, short enough that a report stays a report. */
const MAX_ACTUAL_CHARS = 200;

function truncate(text: string): string {
  return text.length > MAX_ACTUAL_CHARS ? `${text.slice(0, MAX_ACTUAL_CHARS)}…` : text;
}

/** The result as one string: the first item's text, which is what a scalar comparison means. */
function firstText(result: QueryResult): string | undefined {
  if (result.kind === 'nodes') {
    return result.items[0]?.text;
  }
  if (result.kind === 'values') {
    return result.items[0]?.text;
  }
  return undefined;
}

/** Evaluates an XPath/XQuery/JSONPath expression against the response and checks its result. */
export async function evaluateMatch(subject: AssertionSubject, assertion: MatchAssertion): Promise<AssertionResult> {
  const base = {
    type: 'match' as const,
    label: assertion.name ?? `${assertion.language}: ${truncate(assertion.expression)}`,
  };
  const wantsJson = assertion.language === 'jsonpath';
  if (wantsJson && subject.bodyKind !== 'json') {
    return { ...base, outcome: 'errored', message: 'jsonpath needs a JSON response body' };
  }
  if (!wantsJson && subject.bodyKind === 'other') {
    return { ...base, outcome: 'errored', message: `${assertion.language} needs an XML or JSON response body` };
  }
  const result = await evaluateWithTimeout(
    subject.bodyText,
    assertion.expression,
    {
      language: assertion.language,
      ...(assertion.namespaces !== undefined ? { namespaces: assertion.namespaces } : {}),
    },
    { kind: subject.bodyKind === 'json' ? 'json' : 'xml' },
  );
  if (result.kind === 'error') {
    return { ...base, outcome: 'errored', message: result.message };
  }
  const found = result.kind !== 'empty';
  if (assertion.exists !== undefined) {
    return found === assertion.exists
      ? { ...base, outcome: 'passed' }
      : {
          ...base,
          outcome: 'failed',
          expected: assertion.exists ? 'a result' : 'no result',
          actual: found ? 'a result' : 'no result',
        };
  }
  const actual = firstText(result) ?? '';
  if (assertion.matches !== undefined) {
    return new RegExp(assertion.matches).test(actual)
      ? { ...base, outcome: 'passed' }
      : { ...base, outcome: 'failed', expected: `/${assertion.matches}/`, actual: truncate(actual) };
  }
  const expected = String(assertion.equals);
  return actual === expected
    ? { ...base, outcome: 'passed' }
    : { ...base, outcome: 'failed', expected, actual: truncate(actual) };
}
