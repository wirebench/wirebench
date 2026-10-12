/**
 * Environment endpoint overrides are keyed by slug: `<containerSlug>` in a project environment,
 * `<projectSlug>/<containerSlug>` in a workspace one. A rename re-derives a container's slug, so
 * these helpers move the keys with it; otherwise the override would stop applying without a word
 * (#477).
 */

import { allContainers } from '@wirebench/engine';
import type { Environment, Project } from '@wirebench/engine';

/** Old slug → new slug for each container whose slug differs between `before` and `after`, matched by id. */
export function renamedContainerSlugs(before: Project, after: Project): ReadonlyMap<string, string> {
  const previous = new Map(allContainers(before).map((container) => [container.id, container.slug]));
  const renames = new Map<string, string>();
  for (const container of allContainers(after)) {
    const old = previous.get(container.id);
    if (old !== undefined && old !== container.slug) {
      renames.set(old, container.slug);
    }
  }
  return renames;
}

/**
 * `endpoints` with each key `<prefix><old>` moved to `<prefix><new>`, or `endpoints` itself when no
 * key moves. Every key is mapped from the original map, so two containers trading slugs swap cleanly.
 */
export function rekeyEndpoints(
  endpoints: Readonly<Record<string, string>>,
  renames: ReadonlyMap<string, string>,
  prefix = '',
): Readonly<Record<string, string>> {
  let moved = false;
  const entries = Object.entries(endpoints).map(([key, url]): [string, string] => {
    const renamed = key.startsWith(prefix) ? renames.get(key.slice(prefix.length)) : undefined;
    if (renamed === undefined) {
      return [key, url];
    }
    moved = true;
    return [`${prefix}${renamed}`, url];
  });
  return moved ? Object.fromEntries(entries) : endpoints;
}

/** `project` with its environments' endpoint keys following `renames`; `project` itself when none moves. */
export function rekeyProjectEnvironments(project: Project, renames: ReadonlyMap<string, string>): Project {
  if (renames.size === 0) {
    return project;
  }
  let moved = false;
  const environments = project.environments.map((environment): Environment => {
    const endpoints = rekeyEndpoints(environment.endpoints, renames);
    if (endpoints === environment.endpoints) {
      return environment;
    }
    moved = true;
    return { ...environment, endpoints };
  });
  return moved ? { ...project, environments } : project;
}
