import type { AssertionResult, AssertionSubject, SchemaAssertion } from './model.js';

/** Validates the response body against its declared schema. */
export async function evaluateContract(
  subject: AssertionSubject,
  assertion: SchemaAssertion,
): Promise<AssertionResult> {
  const base = { type: 'schema' as const, label: assertion.name ?? 'response complies with the contract' };
  if (subject.protocol !== 'soap') {
    return { ...base, outcome: 'errored', message: 'schema applies to a SOAP request only, for now' };
  }
  if (subject.validateContract === undefined) {
    return { ...base, outcome: 'errored', message: "the interface's definition is not cached in the project" };
  }
  const problems = await subject.validateContract();
  const first = problems[0];
  if (first === undefined) {
    return { ...base, outcome: 'passed' };
  }
  const count = problems.length === 1 ? '1 problem' : `${problems.length} problems`;
  return { ...base, outcome: 'failed', expected: 'no problems', actual: `${count}; first: ${first.message}` };
}
