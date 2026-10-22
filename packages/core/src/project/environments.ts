/**
 * Environment resolution: named sets of endpoints and property overrides, which let a
 * saved project be pointed at different deployments (endpoints + property
 * overrides) without editing the project itself.
 *
 * Precedence for the endpoint a request is actually sent to: an active
 * environment's override for the interface or API (an explicit deployment choice)
 * wins over everything else. What a SOAP interface's endpoints add to that ladder
 * is `soap/endpoints.ts`; a REST API's base URL is `resolveApiBaseUrl` below.
 */

import type { Environment, Project, PropertyMap } from './model.js';
import type { PropertyScopes } from './properties.js';
import { enabledProperties } from './properties.js';

/** Finds the environment with `envId` in `project`, or `undefined` when there is none or it isn't found. */
export function findEnvironment(project: Project, envId: string | undefined): Environment | undefined {
  if (envId === undefined) {
    return undefined;
  }
  return project.environments.find((environment) => environment.id === envId);
}

/** Where a SOAP request's URL came from (`soap/endpoints.ts`, `resolveEndpoint`). */
export type EndpointSource =
  'environment' | 'workspace-environment' | 'request-custom' | 'request-endpoint' | 'interface-default' | 'none';

/** Where an API's effective base URL came from. */
export type BaseUrlSource = 'environment' | 'workspace-environment' | 'api';

/**
 * Resolves the base URL a REST API's requests are sent against.
 *
 * The same shape as SOAP's `resolveEndpoint` and the same precedence as far as it goes: an active
 * environment's override for the API wins over the API's own base URL, because choosing an
 * environment is how a user says "point everything at test". An API has no per-request URL
 * override to consider — a request that needs another host writes an absolute URL instead.
 */
export function resolveApiBaseUrl(
  project: Project,
  envId: string | undefined,
  api: { readonly slug: string; readonly baseUrl: string },
): { url: string; source: BaseUrlSource } {
  const environment = findEnvironment(project, envId);
  const override = environment?.endpoints[api.slug];
  return override !== undefined ? { url: override, source: 'environment' } : { url: api.baseUrl, source: 'api' };
}

/**
 * Builds the {@link PropertyScopes} for expanding properties against `project`
 * under the (optional) active environment `envId`. `env` is omitted entirely
 * when there is no active environment, so shorthand lookups correctly skip it.
 * A property switched off via `disabledProperties` (on the project, or on the
 * active environment) is excluded from its scope's map, so it resolves exactly
 * as if it were absent — see {@link enabledProperties}.
 */
export function resolveScopes(
  project: Project,
  envId: string | undefined,
  globals: PropertyMap,
  system?: PropertyScopes['system'],
): PropertyScopes {
  const environment = findEnvironment(project, envId);
  return {
    project: enabledProperties(project.properties, project.disabledProperties),
    global: globals,
    ...(environment !== undefined
      ? { env: enabledProperties(environment.properties, environment.disabledProperties) }
      : {}),
    ...(system !== undefined ? { system } : {}),
  };
}

/** Replaces the environment with `env.id` if present, else appends it; preserves relative order otherwise. */
export function upsertEnvironment(project: Project, env: Environment): Project {
  const exists = project.environments.some((candidate) => candidate.id === env.id);
  const environments = exists
    ? project.environments.map((candidate) => (candidate.id === env.id ? env : candidate))
    : [...project.environments, env];
  return { ...project, environments };
}

/** Removes the environment with `envId`, keeping the remaining environments' relative order. */
export function removeEnvironment(project: Project, envId: string): Project {
  return { ...project, environments: project.environments.filter((candidate) => candidate.id !== envId) };
}
