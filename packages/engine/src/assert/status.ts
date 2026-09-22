import { GRPC_STATUS_NAMES, grpcStatusName } from '../grpc/status.js';
import type { AssertionResult, AssertionSubject, StatusAssertion } from './model.js';

/** Maps a gRPC status name (`OK`, `NOT_FOUND`, …) back to its code. */
const GRPC_CODE_BY_NAME: ReadonlyMap<string, number> = new Map(
  Object.entries(GRPC_STATUS_NAMES).map(([code, name]) => [name, Number(code)]),
);

function holdsHttp(expected: number | string, status: number): boolean {
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

  if (subject.protocol === 'grpc') {
    const unknownName = expected.find((value) => typeof value === 'string' && !GRPC_CODE_BY_NAME.has(value));
    if (unknownName !== undefined) {
      return { ...base, outcome: 'errored', message: `${String(unknownName)} is not a gRPC status name` };
    }
    const matched = expected.some((value) =>
      typeof value === 'number' ? value === subject.status : GRPC_CODE_BY_NAME.get(value) === subject.status,
    );
    return matched
      ? { ...base, outcome: 'passed' }
      : { ...base, outcome: 'failed', expected: text, actual: grpcStatusName(subject.status) };
  }

  const grpcName = expected.find((value) => typeof value === 'string' && GRPC_CODE_BY_NAME.has(value));
  if (grpcName !== undefined) {
    return { ...base, outcome: 'errored', message: `${String(grpcName)} is a gRPC status name, not an HTTP one` };
  }
  return expected.some((value) => holdsHttp(value, subject.status))
    ? { ...base, outcome: 'passed' }
    : { ...base, outcome: 'failed', expected: text, actual: String(subject.status) };
}
