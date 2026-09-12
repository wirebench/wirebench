/**
 * Gives a {@link Project} a fresh identity: every entity id becomes a new one, and every
 * reference to an old id is rewritten to match — so a project folder copied into a workspace
 * never shares an id with the project it was copied from.
 *
 * Used when a project folder is imported as a copy (see the workspace import flow); a *linked*
 * project keeps its ids, since it stays the same on-disk project.
 */

import { defaultContentId, generateId } from '../project/model.js';
import type { Attachment, IdGenerator, Project, RequestDef, WssRef } from '../project/model.js';

/** Every entity id in `project`, in visit order (an id shared by two entities is deduplicated). */
function collectIds(project: Project): string[] {
  const ids: string[] = [project.id];
  for (const iface of project.interfaces) {
    ids.push(iface.id);
    for (const endpoint of iface.endpoints) {
      ids.push(endpoint.id);
    }
    for (const operation of iface.operations) {
      for (const request of operation.requests) {
        ids.push(request.id);
        for (const attachment of request.attachments) {
          ids.push(attachment.id);
        }
      }
    }
  }
  for (const environment of project.environments) {
    ids.push(environment.id);
  }
  for (const ref of [...project.wss.outgoing, ...project.wss.incoming, ...project.wss.keystores]) {
    ids.push(ref.id);
  }
  return ids;
}

/** Assigns one new id per unique old id, calling `newId` exactly once per old id. */
function buildIdMap(ids: readonly string[], newId: IdGenerator): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const id of ids) {
    if (!map.has(id)) {
      map.set(id, newId());
    }
  }
  return map;
}

/** Recursively replaces any string in `value` that is a key of `idMap`, arrays and nested objects included. */
function remapValue(value: unknown, idMap: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') {
    return idMap.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => remapValue(item, idMap));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, remapValue(v, idMap)]),
    );
  }
  return value;
}

/** `{ [key]: value }` when `value` is defined, `{}` otherwise — keeps an omitted optional field omitted. */
function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: string });
}

/**
 * Reassigns `project` and every one of its entities a new id, rewriting every internal
 * reference (including the ids buried inside `WssRef.document` bags) to match. An id this
 * project does not have an entity for — a dangling reference — is left untouched rather than
 * invented. `secretRef`/`passwordRef`/`passwordSecretRef` values and attachment `sha256`
 * sources are never ids, and are carried through byte-identical.
 *
 * @param project the project to give a fresh identity
 * @param newId id generator; defaults to {@link generateId}. Injectable so the result is
 *   deterministic in tests.
 * @returns a new `Project` with fresh ids throughout
 */
export function reidentifyProject(project: Project, newId: IdGenerator = generateId): Project {
  const idMap = buildIdMap(collectIds(project), newId);
  const mapId = (id: string): string => idMap.get(id) ?? id;
  const mapRef = (id: string | undefined): string | undefined => (id === undefined ? undefined : mapId(id));
  const mapWssRef = (ref: WssRef): WssRef => ({
    ...ref,
    id: mapId(ref.id),
    document: remapValue(ref.document, idMap) as Readonly<Record<string, unknown>>,
  });

  const reidentifyAttachment = (attachment: Attachment): Attachment => {
    const id = mapId(attachment.id);
    const hadDefaultContentId = attachment.contentId === defaultContentId(attachment.id);
    return {
      ...attachment,
      id,
      contentId: hadDefaultContentId ? defaultContentId(id) : attachment.contentId,
    };
  };

  const reidentifyRequest = (request: RequestDef): RequestDef => ({
    ...request,
    id: mapId(request.id),
    ...optional('endpointId', mapRef(request.endpointId)),
    ...optional('wssOutgoingRef', mapRef(request.wssOutgoingRef)),
    ...optional('wssIncomingRef', mapRef(request.wssIncomingRef)),
    attachments: request.attachments.map(reidentifyAttachment),
    properties: { ...request.properties, ...optional('sslKeystoreRef', mapRef(request.properties.sslKeystoreRef)) },
  });

  return {
    ...project,
    id: mapId(project.id),
    interfaces: project.interfaces.map((iface) => ({
      ...iface,
      id: mapId(iface.id),
      endpoints: iface.endpoints.map((endpoint) => ({ ...endpoint, id: mapId(endpoint.id) })),
      ...optional('defaultEndpointId', mapRef(iface.defaultEndpointId)),
      operations: iface.operations.map((operation) => ({
        ...operation,
        requests: operation.requests.map(reidentifyRequest),
      })),
    })),
    environments: project.environments.map((environment) => ({ ...environment, id: mapId(environment.id) })),
    ...optional('activeEnvironmentId', mapRef(project.activeEnvironmentId)),
    wss: {
      outgoing: project.wss.outgoing.map(mapWssRef),
      incoming: project.wss.incoming.map(mapWssRef),
      keystores: project.wss.keystores.map(mapWssRef),
    },
  };
}
