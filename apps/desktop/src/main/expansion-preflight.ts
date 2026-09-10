/**
 * The dry run behind `request.preflight`: resolves the URL a saved request would be sent to
 * under the active environment, and expands every part of its send input to find `${...}`
 * property references that would not resolve — *before* anything is put on the wire.
 *
 * The engine's `expandSendInput` expands the whole input at once and reports a flat list of
 * unresolved refs; the UI needs to say *where* each one sits, so this module expands one field
 * at a time and tags each ref with the field (and header) it came from.
 *
 * Pure: no `electron`, no `fs`, no network.
 */

import { expand, ProjectError, resolveEndpoint } from '@wirebench/engine';
import type { Project, PropertyScopes, UnresolvedRef } from '@wirebench/engine';
import type { EndpointSourceWire, ExpansionField, UnresolvedRefWire } from '../shared/wire-types.js';
import { findRequest } from './project-wire.js';

/** What `request.preflight` answers: where the request would go, and what would not expand. */
export interface PreflightResult {
  readonly endpoint?: string;
  readonly endpointSource: EndpointSourceWire;
  readonly unresolved: UnresolvedRefWire[];
}

/** Copies an engine `UnresolvedRef` onto the wire, tagged with where in the request it was found. */
function toWire(ref: UnresolvedRef, field: ExpansionField, headerName?: string): UnresolvedRefWire {
  return {
    expr: ref.expr,
    ...(ref.scope !== undefined ? { scope: ref.scope } : {}),
    ...(ref.name !== undefined ? { name: ref.name } : {}),
    code: ref.code,
    start: ref.start,
    end: ref.end,
    ...(ref.via !== undefined ? { via: [...ref.via] } : {}),
    field,
    ...(headerName !== undefined ? { headerName } : {}),
  };
}

/**
 * Resolves `requestId`'s endpoint and expands its send input against `scopes`.
 *
 * `envId` selects the environment endpoint overrides are read from; pass the project's active
 * environment. Throws `ProjectError('not-found')` when the project holds no such request.
 */
export function preflightRequest(
  project: Project,
  requestId: string,
  scopes: PropertyScopes,
  envId?: string,
): PreflightResult {
  const location = findRequest(project, requestId);
  if (location === undefined) {
    throw new ProjectError('not-found', `No request with id "${requestId}"`, { details: { id: requestId } });
  }
  const { iface, request } = location;
  const resolved = resolveEndpoint(project, envId, iface, request);

  const unresolved: UnresolvedRefWire[] = [];
  const check = (text: string, field: ExpansionField, headerName?: string): void => {
    for (const ref of expand(text, scopes).unresolved) {
      unresolved.push(toWire(ref, field, headerName));
    }
  };

  if (resolved.url !== undefined) {
    check(resolved.url, 'endpoint');
  }
  check(request.envelopeXml, 'envelopeXml');
  if (request.soapAction !== undefined) {
    check(request.soapAction, 'soapAction');
  }
  for (const header of request.headers) {
    // The header's *name* can be an expansion too; both refs are attributed to the name the
    // user typed, since that is what the UI has to point at.
    check(header.name, 'header', header.name);
    check(header.value, 'header', header.name);
  }

  return {
    ...(resolved.url !== undefined ? { endpoint: resolved.url } : {}),
    endpointSource: resolved.source,
    unresolved,
  };
}
