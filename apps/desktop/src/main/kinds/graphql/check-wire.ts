/** A GraphQL response's check onto the wire (phase 6 spec §3.4). */
import type { Redactor } from '../../host/redactor.js';
import type { GraphqlCheckResult } from '@wirebench/engine';
import type { GraphqlCheckWire } from '@wirebench/wire/kinds/graphql/wire';

/**
 * A GraphQL check onto the wire. An error's message is the server's text, so a recorded secret in it
 * is masked unless the session shows secrets; a data problem names only the schema's side.
 */
export function toGraphqlCheckWire(redactor: Redactor, result: GraphqlCheckResult, show: boolean): GraphqlCheckWire {
  return {
    schema: result.schema,
    errors: result.errors.map((error) => ({
      message: redactor.redactSecretText(error.message, { show }),
      ...(error.path !== undefined ? { path: [...error.path] } : {}),
      pointer: error.pointer,
    })),
    problems: result.problems.map((problem) => ({ pointer: problem.pointer, message: problem.message })),
  };
}
