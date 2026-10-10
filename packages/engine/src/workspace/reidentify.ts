/**
 * Gives a {@link Project} a fresh identity: every entity id becomes a new one, and every
 * reference to an old id is rewritten to match — so a project folder copied into a workspace
 * never shares an id with the project it was copied from.
 *
 * Used when a project folder is imported as a copy (see the workspace import flow); a *linked*
 * project keeps its ids, since it stays the same on-disk project.
 */

import { generateId } from '../project/model.js';
import type { IdGenerator, Project, WssRef } from '../project/model.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import { defaultRegistry } from '../protocols.js';

/** Every entity id in `project`, in visit order (an id shared by two entities is deduplicated). */
function collectIds(project: Project, registry: ProtocolRegistry): string[] {
  const ids: string[] = [project.id];
  for (const module of registry.modules) {
    const { storage } = module;
    if (storage.entityIds === undefined) continue;
    for (const container of storage.containers(project)) ids.push(...storage.entityIds(container));
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
 * @param registry whose modules' storage says which of a container's ids to renew
 * @returns a new `Project` with fresh ids throughout
 */
export function reidentifyProject(
  project: Project,
  newId: IdGenerator = generateId,
  registry: ProtocolRegistry = defaultRegistry(),
): Project {
  const idMap = buildIdMap(collectIds(project, registry), newId);
  const mapId = (id: string): string => idMap.get(id) ?? id;
  const mapRef = (id: string | undefined): string | undefined => (id === undefined ? undefined : mapId(id));
  const mapWssRef = (ref: WssRef): WssRef => ({
    ...ref,
    id: mapId(ref.id),
    document: remapValue(ref.document, idMap) as Readonly<Record<string, unknown>>,
  });

  let next = project;
  for (const { storage } of registry.modules) {
    if (storage.withEntityIds === undefined) continue;
    const containers = storage.containers(next);
    if (containers.length === 0) continue;
    const renewed = [];
    for (const container of containers) renewed.push(storage.withEntityIds(container, mapId));
    next = storage.withContainers(next, renewed);
  }

  return {
    ...next,
    id: mapId(project.id),
    environments: project.environments.map((environment) => ({ ...environment, id: mapId(environment.id) })),
    ...optional('activeEnvironmentId', mapRef(project.activeEnvironmentId)),
    wss: {
      outgoing: project.wss.outgoing.map(mapWssRef),
      incoming: project.wss.incoming.map(mapWssRef),
      keystores: project.wss.keystores.map(mapWssRef),
    },
  };
}
