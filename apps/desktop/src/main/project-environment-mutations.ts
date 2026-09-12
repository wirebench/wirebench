/**
 * Pure reducers for the four environment-related {@link ProjectChange} variants, split out of
 * `project-mutations.ts` to keep both files small. Same contract as every other reducer: never
 * mutates its input, and validates ids up front so a stale renderer mirror surfaces as
 * `ProjectError('not-found')` rather than a silent no-op.
 */

import { generateId, ProjectError, removeEnvironment, uniqueSlug, upsertEnvironment } from '@wirebench/engine';
import type { Environment, Project } from '@wirebench/engine';
import type { EnvironmentPatchWire } from '../shared/wire-types.js';

function notFound(environmentId: string): never {
  throw new ProjectError('not-found', `No environment with id "${environmentId}"`, {
    details: { id: environmentId },
  });
}

function requireEnvironment(project: Project, environmentId: string): Environment {
  return project.environments.find((candidate) => candidate.id === environmentId) ?? notFound(environmentId);
}

/**
 * Rebuilds a project with (or without) `activeEnvironmentId`, so "no active environment" is an
 * *absent* key rather than an explicit `undefined` — which `exactOptionalPropertyTypes` treats
 * as a different thing, and which the manifest serialiser would otherwise write out as `null`.
 */
function withActiveEnvironment(project: Project, activeEnvironmentId: string | undefined): Project {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
  const { activeEnvironmentId: dropped, ...rest } = project;
  return activeEnvironmentId === undefined ? rest : { ...rest, activeEnvironmentId };
}

/** Appends a new, empty environment; its slug is unique among the project's environments. */
export function addEnvironment(project: Project, name: string): { project: Project; environment: Environment } {
  const taken = new Set(project.environments.map((environment) => environment.slug));
  const highestOrder = project.environments.reduce((max, environment) => Math.max(max, environment.order), -1);
  const environment: Environment = {
    id: generateId(),
    name,
    slug: uniqueSlug(name, taken),
    order: highestOrder + 1,
    endpoints: {},
    properties: {},
    disabledProperties: [],
  };
  return { project: { ...project, environments: [...project.environments, environment] }, environment };
}

/**
 * Applies a patch to one environment. A rename re-derives the slug (kept unique among the
 * other environments); `endpoints` and `properties` REPLACE the whole map rather than merging,
 * so the renderer can delete a key by sending the map without it.
 */
export function updateEnvironment(project: Project, environmentId: string, patch: EnvironmentPatchWire): Project {
  const existing = requireEnvironment(project, environmentId);
  const taken = new Set(
    project.environments.filter((candidate) => candidate.id !== environmentId).map((candidate) => candidate.slug),
  );
  const name = patch.name ?? existing.name;
  const slug = patch.name === undefined || patch.name === existing.name ? existing.slug : uniqueSlug(name, taken);
  const next: Environment = {
    id: existing.id,
    name,
    slug,
    order: existing.order,
    endpoints: patch.endpoints === undefined ? existing.endpoints : { ...patch.endpoints },
    properties: patch.properties === undefined ? existing.properties : { ...patch.properties },
    disabledProperties: existing.disabledProperties,
  };
  return upsertEnvironment(project, next);
}

/** Deletes an environment, deactivating it first when it was the active one. */
export function deleteEnvironment(project: Project, environmentId: string): Project {
  requireEnvironment(project, environmentId);
  const cleared = project.activeEnvironmentId === environmentId ? withActiveEnvironment(project, undefined) : project;
  return removeEnvironment(cleared, environmentId);
}

/** Switches the active environment; `null` deactivates. The id must name a known environment. */
export function setActiveEnvironment(project: Project, environmentId: string | null): Project {
  if (environmentId === null) {
    return withActiveEnvironment(project, undefined);
  }
  requireEnvironment(project, environmentId);
  return withActiveEnvironment(project, environmentId);
}
