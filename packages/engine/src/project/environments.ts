/**
 * Environment resolution: SoapUI Pro's "environments" feature, which lets a
 * saved project be pointed at different deployments (endpoints + property
 * overrides) without editing the project itself.
 *
 * Precedence for the endpoint a request is actually sent to: an active
 * environment's override for the interface (an explicit deployment choice)
 * wins over everything else, including a request's own custom URL; then the
 * request's custom URL; then its chosen endpoint; then the interface
 * default; then the interface's first endpoint.
 */

import type { Environment, Interface, Project, PropertyMap, RequestDef } from './model.js';
import type { PropertyScopes } from './properties.js';

/** Finds the environment with `envId` in `project`, or `undefined` when there is none or it isn't found. */
export function findEnvironment(project: Project, envId: string | undefined): Environment | undefined {
  if (envId === undefined) {
    return undefined;
  }
  return project.environments.find((environment) => environment.id === envId);
}

/** Where {@link resolveEndpoint}'s URL came from. */
export type EndpointSource = 'environment' | 'request-custom' | 'request-endpoint' | 'interface-default' | 'none';

/**
 * Resolves the URL a request should actually be sent to, given an optional
 * active environment. See the module doc for the precedence order.
 */
export function resolveEndpoint(
  project: Project,
  envId: string | undefined,
  iface: Interface,
  request: Pick<RequestDef, 'endpointId' | 'endpointUrl'>,
): { url: string | undefined; source: EndpointSource } {
  const environment = findEnvironment(project, envId);
  if (environment !== undefined) {
    const override = environment.endpoints[iface.slug];
    if (override !== undefined) {
      return { url: override, source: 'environment' };
    }
  }

  if (request.endpointUrl !== undefined) {
    return { url: request.endpointUrl, source: 'request-custom' };
  }

  if (request.endpointId !== undefined) {
    const endpoint = iface.endpoints.find((candidate) => candidate.id === request.endpointId);
    if (endpoint !== undefined) {
      return { url: endpoint.url, source: 'request-endpoint' };
    }
  }

  if (iface.defaultEndpointId !== undefined) {
    const endpoint = iface.endpoints.find((candidate) => candidate.id === iface.defaultEndpointId);
    if (endpoint !== undefined) {
      return { url: endpoint.url, source: 'interface-default' };
    }
  }

  const first = iface.endpoints[0];
  if (first !== undefined) {
    return { url: first.url, source: 'interface-default' };
  }

  return { url: undefined, source: 'none' };
}

/**
 * Builds the {@link PropertyScopes} for expanding properties against `project`
 * under the (optional) active environment `envId`. `env` is omitted entirely
 * when there is no active environment, so shorthand lookups correctly skip it.
 */
export function resolveScopes(
  project: Project,
  envId: string | undefined,
  globals: PropertyMap,
  system?: PropertyScopes['system'],
): PropertyScopes {
  const environment = findEnvironment(project, envId);
  return {
    project: project.properties,
    global: globals,
    ...(environment !== undefined ? { env: environment.properties } : {}),
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
