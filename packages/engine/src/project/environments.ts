/**
 * Environment resolution: named sets of endpoints and property overrides, which let a
 * saved project be pointed at different deployments (endpoints + property
 * overrides) without editing the project itself.
 *
 * Precedence for the endpoint a request is actually sent to: an active
 * environment's override for the interface (an explicit deployment choice)
 * wins over everything else, including a request's own custom URL; then the
 * request's custom URL; then its chosen endpoint; then the interface
 * default; then the interface's first endpoint.
 */

import type { Endpoint, Environment, Interface, Project, PropertyMap, RequestDef } from './model.js';
import type { RestApi } from '../rest/model.js';
import type { PropertyScopes } from './properties.js';
import { enabledProperties } from './properties.js';

/** Finds the environment with `envId` in `project`, or `undefined` when there is none or it isn't found. */
export function findEnvironment(project: Project, envId: string | undefined): Environment | undefined {
  if (envId === undefined) {
    return undefined;
  }
  return project.environments.find((environment) => environment.id === envId);
}

/** Where {@link resolveEndpoint}'s URL came from. */
export type EndpointSource =
  'environment' | 'workspace-environment' | 'request-custom' | 'request-endpoint' | 'interface-default' | 'none';

/**
 * Resolves the URL a request should actually be sent to, given an optional
 * active environment. See the module doc for the precedence order.
 *
 * `endpoint` is the `Endpoint` object the URL came from, when one exists — the environment
 * override and a request's custom URL name no endpoint, so they carry none. Callers that need
 * the endpoint's own settings (its `trustInvalid` flag, say) read it from here rather than
 * re-deriving the precedence.
 */
export function resolveEndpoint(
  project: Project,
  envId: string | undefined,
  iface: Interface,
  request: Pick<RequestDef, 'endpointId' | 'endpointUrl'>,
): { url: string | undefined; source: EndpointSource; endpoint?: Endpoint } {
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
      return { url: endpoint.url, source: 'request-endpoint', endpoint };
    }
  }

  if (iface.defaultEndpointId !== undefined) {
    const endpoint = iface.endpoints.find((candidate) => candidate.id === iface.defaultEndpointId);
    if (endpoint !== undefined) {
      return { url: endpoint.url, source: 'interface-default', endpoint };
    }
  }

  const first = iface.endpoints[0];
  if (first !== undefined) {
    return { url: first.url, source: 'interface-default', endpoint: first };
  }

  return { url: undefined, source: 'none' };
}

/** Where an API's effective base URL came from. */
export type BaseUrlSource = 'environment' | 'workspace-environment' | 'api';

/**
 * Resolves the base URL a REST API's requests are sent against.
 *
 * The same shape as {@link resolveEndpoint} and the same precedence as far as it goes: an active
 * environment's override for the API wins over the API's own base URL, because choosing an
 * environment is how a user says "point everything at test". An API has no per-request URL
 * override to consider — a request that needs another host writes an absolute URL instead.
 */
export function resolveApiBaseUrl(
  project: Project,
  envId: string | undefined,
  api: Pick<RestApi, 'slug' | 'baseUrl'>,
): { url: string; source: BaseUrlSource } {
  const environment = findEnvironment(project, envId);
  const override = environment?.endpoints[api.slug];
  return override !== undefined ? { url: override, source: 'environment' } : { url: api.baseUrl, source: 'api' };
}

/**
 * Resolves the `Endpoint` object a request's *credentials* should come from: the request's own
 * chosen endpoint, else the interface's default, else its first endpoint — the same precedence
 * {@link resolveEndpoint} uses for the URL (minus the environment-override and custom-URL cases,
 * which name no `Endpoint` object of their own, so have no auth to contribute). Callers that need
 * a request's effective auth (not just its URL) should resolve the endpoint through this function
 * rather than re-deriving the precedence, so the two cannot drift apart.
 */
export function resolveAuthEndpoint(iface: Interface, request: Pick<RequestDef, 'endpointId'>): Endpoint | undefined {
  if (request.endpointId !== undefined) {
    const endpoint = iface.endpoints.find((candidate) => candidate.id === request.endpointId);
    if (endpoint !== undefined) {
      return endpoint;
    }
  }
  if (iface.defaultEndpointId !== undefined) {
    const endpoint = iface.endpoints.find((candidate) => candidate.id === iface.defaultEndpointId);
    if (endpoint !== undefined) {
      return endpoint;
    }
  }
  return iface.endpoints[0];
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
