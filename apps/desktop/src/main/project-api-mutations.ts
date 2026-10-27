/**
 * What every API kind's mutations share (spec §5.2): the error for an id that names nothing, the
 * slugs taken at the project's top level, and the wire-to-engine conversions of auth and table rows.
 * Core, so no kind folder imports another's.
 */

import { ProjectError, takenContainerSlugs } from '@wirebench/engine';
import type { AuthConfig, KeyValueEntry, Project } from '@wirebench/engine';
import type { AuthConfigWire, KeyValueWire } from '@wirebench/wire/wire-base';

/** @throws ProjectError `project-entity-not-found` naming `what` and `id`. */
export function notFound(what: string, id: string): never {
  throw new ProjectError('project-entity-not-found', `No ${what} with id ${id}`, { details: { what, id } });
}

/**
 * Every slug in use at the project's top level: the APIs of every kind (they share `apis/`), the
 * interfaces and the placeholders (spec R3, §6). Hand it to `uniqueSlug` when naming an API.
 *
 * With `exceptApiId`, that API's own slug is left out so a rename may keep it — unless another API,
 * an interface or a placeholder holds the same slug too: the slug is dropped by leaving the API out,
 * never by deleting it from the set, so it is never freed while someone else still has it.
 */
export function takenApiSlugs(project: Project, exceptApiId?: string): Set<string> {
  const others: Project =
    exceptApiId === undefined
      ? project
      : {
          ...project,
          containers: Object.fromEntries(
            Object.entries(project.containers).map(([kind, containers]) => [
              kind,
              containers.filter((container) => container.id !== exceptApiId),
            ]),
          ),
        };
  // The built-in registry only says where each kind's containers live; a kind that is off holds none
  // (its folders are placeholders, which are counted whatever the registry), so the run's would agree.
  return new Set([...takenContainerSlugs(others, 'apis'), ...takenContainerSlugs(others, 'interfaces')]);
}

/** Turns a wire auth configuration into the engine's, dropping keys the sender left undefined. */
export function toEngineAuthConfig(auth: AuthConfigWire): AuthConfig {
  const entries = Object.entries(auth).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as unknown as AuthConfig;
}

/** One table row from the wire, with an absent description absent rather than undefined. */
export function toEngineRows(rows: readonly KeyValueWire[]): KeyValueEntry[] {
  return rows.map((row) => ({
    name: row.name,
    value: row.value,
    enabled: row.enabled,
    ...(row.description !== undefined ? { description: row.description } : {}),
  }));
}
