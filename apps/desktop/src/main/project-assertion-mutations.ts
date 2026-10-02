/**
 * `set-request-assertions` (request-assertions spec §5.2): a request's own assertions, replaced
 * whole, on a SOAP, REST, gRPC or WebSocket request found by id wherever it sits. The engine's file
 * schema validates them first, so nothing the project file would refuse is ever saved.
 */
import { assertionsSchema, ProjectError } from '@wirebench/engine';
import type { Assertion, Project } from '@wirebench/engine';
import type { RequestAssertionWire } from '../shared/wire-types.js';
import { mapRequests } from './project-request-map.js';
import type { Identified } from './project-request-map.js';

/** Drops `undefined` members, which the wire allows and the engine's exact optional types do not. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/**
 * Replaces one request's own assertions.
 *
 * @throws ProjectError `request-assertions-invalid` when the engine's schema refuses them
 * @throws ProjectError `unknown-entity` when no request has that id
 */
export function setRequestAssertions(
  project: Project,
  requestId: string,
  assertions: readonly RequestAssertionWire[],
): { readonly project: Project } {
  const parsed = assertionsSchema.safeParse(assertions);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    const detail = issues.map((issue) => (issue.path !== '' ? `${issue.path}: ${issue.message}` : issue.message));
    throw new ProjectError('request-assertions-invalid', `The assertions are not valid: ${detail.join('; ')}`, {
      details: { issues },
    });
  }
  const next: readonly Assertion[] = assertions.map((assertion) => defined(assertion) as unknown as Assertion);
  let found = false;
  const updated = mapRequests<Identified & { readonly assertions?: readonly Assertion[] }>(
    project,
    (request) => {
      if (request.id !== requestId) return request;
      found = true;
      return { ...request, assertions: next };
    },
    { websocket: true },
  );
  if (!found) {
    throw new ProjectError('unknown-entity', `No request with id "${requestId}"`, { details: { requestId } });
  }
  return { project: updated };
}
