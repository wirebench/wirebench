/**
 * The renderer half of a GraphQL response's check (#77): the chip's wording and the Problems rows.
 *
 * The check ran in main (see `GraphqlCheckWire`). Each entry of the response's `errors` is an error,
 * and each place its `data` does not match the operation is a warning, both located by JSON Pointer.
 * As with the contract check, the body view turns a pointer into a range against the text it shows,
 * and a Problems row reveals it through the same reveal.
 */
import type { GraphqlCheckWire } from '../../../../shared/kinds/rest/wire.js';
import { useProblemsStore } from '../../../state/problems.js';

/** How the chip reads: its tone picks the colour, and the text alone still says it all. */
export type GraphqlTone = 'success' | 'warning' | 'danger';

export interface GraphqlChipView {
  readonly label: string;
  readonly tone: GraphqlTone;
}

/** The chip for one check, or `undefined` when the response was not a GraphQL one, or too large to read. */
export function graphqlChip(check: GraphqlCheckWire): GraphqlChipView | undefined {
  if (check.schema === 'not-graphql' || check.schema === 'skipped') {
    return undefined;
  }
  const errors = check.errors.length;
  if (errors > 0) {
    return { label: `${String(errors)} GraphQL error${errors === 1 ? '' : 's'}`, tone: 'danger' };
  }
  if (check.problems.length > 0) {
    return { label: 'Schema mismatch', tone: 'warning' };
  }
  return { label: 'No GraphQL errors', tone: 'success' };
}

/** The Problems group one request's GraphQL check owns; a new send replaces exactly it. */
export function graphqlGroupId(requestId: string): string {
  return `graphql:${requestId}:response`;
}

/**
 * Files a check's errors and problems under the request's group, replacing the last send's. A check
 * with neither (or none at all) simply clears the group.
 */
export function recordGraphqlProblems(requestId: string, check: GraphqlCheckWire | undefined): void {
  const groupId = graphqlGroupId(requestId);
  const store = useProblemsStore.getState();
  store.clear(groupId);
  if (check === undefined || (check.errors.length === 0 && check.problems.length === 0)) {
    return;
  }
  const row = (severity: 'error' | 'warning', code: string, message: string, pointer: string) => ({
    groupId,
    source: 'graphql' as const,
    severity,
    requestId,
    direction: 'response' as const,
    problem: { code, message, source: 'graphql', location: pointer === '' ? '/' : pointer },
  });
  store.add([
    ...check.errors.map((error) => row('error', 'graphql-error', error.message, error.pointer)),
    ...check.problems.map((problem) => row('warning', 'graphql-schema', problem.message, problem.pointer)),
  ]);
}
