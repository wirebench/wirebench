/**
 * Teaches the workspace layer to `project/properties.ts` and
 * `project/environments.ts`: linking a workspace environment to the project
 * environment of the same slug, building the `PropertyScopes` for a project
 * open inside a workspace, and resolving the endpoint a request should
 * actually be sent to under an active workspace environment.
 *
 * Precedence for the endpoint: a linked project environment's own override
 * for the interface wins (same as `resolveEndpoint`'s environment case);
 * otherwise the active workspace environment's override for
 * `<projectSlug>/<interfaceSlug>`; otherwise whatever `resolveEndpoint`
 * would return with no project environment active (request-custom,
 * request-endpoint, interface-default). Environment layers name no
 * `Endpoint` object of their own, so neither of the first two branches
 * carries one.
 */

import type { Endpoint, Environment, Interface, Project, PropertyMap, RequestDef } from '../project/model.js';
import type { BaseUrlSource, EndpointSource } from '../project/environments.js';
import { resolveApiBaseUrl, resolveEndpoint } from '../project/environments.js';
import type { RestApi } from '../rest/model.js';
import type { PropertyScopes } from '../project/properties.js';
import { enabledProperties } from '../project/properties.js';
import type { Workspace, WorkspaceEnvironment } from './model.js';

/**
 * The project environment whose `slug` matches `workspaceEnv`'s, or
 * `undefined` when there is no such environment (or `workspaceEnv` itself
 * is `undefined`).
 */
export function linkedEnvironment(
  project: Project,
  workspaceEnv: WorkspaceEnvironment | undefined,
): Environment | undefined {
  if (workspaceEnv === undefined) {
    return undefined;
  }
  return project.environments.find((environment) => environment.slug === workspaceEnv.slug);
}

/** Finds `workspace`'s active environment (per `activeEnvironmentId`), or `undefined` when none is active. */
function activeWorkspaceEnvironment(workspace: Workspace): WorkspaceEnvironment | undefined {
  if (workspace.activeEnvironmentId === undefined) {
    return undefined;
  }
  return workspace.environments.find((environment) => environment.id === workspace.activeEnvironmentId);
}

/**
 * Builds the {@link PropertyScopes} for expanding properties against `project` as opened inside
 * `workspace`. `env` merges the active workspace environment's properties with the linked
 * project environment's (project wins on a shared key), and is omitted entirely when neither
 * exists, so shorthand lookups correctly skip it — matching `resolveScopes`'s behaviour for a
 * project with no active environment. A property switched off via `disabledProperties` (on the
 * workspace, the project, the active workspace environment, or the linked project environment)
 * is excluded from its own scope before the merge, so e.g. a value disabled only in the
 * workspace environment still falls through to an enabled value in the linked project
 * environment — see {@link enabledProperties}.
 */
export function resolveWorkspaceScopes(input: {
  readonly workspace: Workspace;
  readonly project: Project;
  readonly globals: PropertyMap;
  readonly system?: PropertyScopes['system'];
}): PropertyScopes {
  const { workspace, project, globals, system } = input;
  const activeWorkspaceEnv = activeWorkspaceEnvironment(workspace);
  const linkedProjectEnv = linkedEnvironment(project, activeWorkspaceEnv);

  const enabledWorkspaceEnvProperties =
    activeWorkspaceEnv !== undefined
      ? enabledProperties(activeWorkspaceEnv.properties, activeWorkspaceEnv.disabledProperties)
      : undefined;
  const enabledLinkedProjectEnvProperties =
    linkedProjectEnv !== undefined
      ? enabledProperties(linkedProjectEnv.properties, linkedProjectEnv.disabledProperties)
      : undefined;

  const env: PropertyMap | undefined =
    activeWorkspaceEnv !== undefined || linkedProjectEnv !== undefined
      ? { ...enabledWorkspaceEnvProperties, ...enabledLinkedProjectEnvProperties }
      : undefined;

  return {
    project: enabledProperties(project.properties, project.disabledProperties),
    workspace: enabledProperties(workspace.properties, workspace.disabledProperties),
    global: globals,
    ...(env !== undefined ? { env } : {}),
    ...(system !== undefined ? { system } : {}),
  };
}

/**
 * Resolves the URL a request should actually be sent to for a project open inside `workspace`.
 * See the module doc for the precedence order. `endpoint` is present only when the URL came
 * from an `Endpoint` object (i.e. the fallback to {@link resolveEndpoint} landed on
 * `request-endpoint` or `interface-default`) — the two environment-override branches name no
 * `Endpoint`, matching `resolveEndpoint`'s own contract.
 */
export function resolveWorkspaceEndpoint(input: {
  readonly workspace: Workspace;
  readonly project: Project;
  readonly projectSlug: string;
  readonly iface: Interface;
  readonly request: Pick<RequestDef, 'endpointId' | 'endpointUrl'>;
}): { url: string | undefined; source: EndpointSource; endpoint?: Endpoint } {
  const { workspace, project, projectSlug, iface, request } = input;
  const activeWorkspaceEnv = activeWorkspaceEnvironment(workspace);
  const linkedProjectEnv = linkedEnvironment(project, activeWorkspaceEnv);

  if (linkedProjectEnv !== undefined) {
    const override = linkedProjectEnv.endpoints[iface.slug];
    if (override !== undefined) {
      return { url: override, source: 'environment' };
    }
  }

  if (activeWorkspaceEnv !== undefined) {
    const override = activeWorkspaceEnv.endpoints[`${projectSlug}/${iface.slug}`];
    if (override !== undefined) {
      return { url: override, source: 'workspace-environment' };
    }
  }

  return resolveEndpoint(project, undefined, iface, request);
}

/**
 * Resolves an API's base URL the way a project open inside a workspace actually resolves it:
 * a linked project's own environment first, then the workspace environment's override keyed
 * `<projectSlug>/<apiSlug>`, then the API's own base URL.
 *
 * The same ladder {@link resolveWorkspaceEndpoint} climbs for a SOAP interface, and keyed the same
 * way — which is why an API and an interface may not share a slug (`project/load.ts` refuses it).
 */
export function resolveWorkspaceApiBaseUrl(input: {
  readonly workspace: Workspace;
  readonly project: Project;
  readonly projectSlug: string;
  readonly api: Pick<RestApi, 'slug' | 'baseUrl'>;
}): { url: string; source: BaseUrlSource } {
  const { workspace, project, projectSlug, api } = input;
  const activeWorkspaceEnv = activeWorkspaceEnvironment(workspace);
  const linkedProjectEnv = linkedEnvironment(project, activeWorkspaceEnv);

  const linkedOverride = linkedProjectEnv?.endpoints[api.slug];
  if (linkedOverride !== undefined) {
    return { url: linkedOverride, source: 'environment' };
  }

  const workspaceOverride = activeWorkspaceEnv?.endpoints[`${projectSlug}/${api.slug}`];
  if (workspaceOverride !== undefined) {
    return { url: workspaceOverride, source: 'workspace-environment' };
  }

  return resolveApiBaseUrl(project, undefined, api);
}
