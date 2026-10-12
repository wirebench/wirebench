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

import type { Environment, Project, PropertyMap } from '../project/model.js';
import type { Endpoint, Interface, SoapRequestDef } from '../soap/model.js';
import type { BaseUrlSource, EndpointSource } from '../project/environments.js';
import { resolveApiBaseUrl, resolveEndpoint } from '../project/environments.js';
import type { PropertyScopes } from '../project/properties.js';
import { enabledProperties } from '../project/properties.js';
import { WorkspaceError } from '../errors.js';
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

/**
 * True when a send under `environment` must be confirmed first: it is marked `protected`, or —
 * inside a workspace — the project environment linked to it is, since that one applies too.
 * Outside a workspace `environment` is the project's own, and the slug lookup finds itself.
 */
export function isProtectedEnvironment(
  project: Project,
  environment: Environment | WorkspaceEnvironment | undefined,
): boolean {
  if (environment === undefined) {
    return false;
  }
  return (
    environment.protected === true ||
    project.environments.some((candidate) => candidate.slug === environment.slug && candidate.protected === true)
  );
}

/**
 * `workspace` with `environmentId` as its active environment, or with none active when it is
 * `undefined`: resolution under a chosen environment without touching the workspace's own.
 */
export function withActiveEnvironment(workspace: Workspace, environmentId: string | undefined): Workspace {
  if (environmentId !== undefined) {
    return { ...workspace, activeEnvironmentId: environmentId };
  }
  const copy: { -readonly [K in keyof Workspace]: Workspace[K] } = { ...workspace };
  delete copy.activeEnvironmentId;
  return copy;
}

/**
 * True when `environment` applies to the project `projectId`: its `projects` scope is absent (every
 * project, including ones added later) or lists the id. `[]` applies to none.
 */
export function appliesToProject(environment: WorkspaceEnvironment, projectId: string): boolean {
  return environment.projects === undefined || environment.projects.includes(projectId);
}

/** The environments of `workspace` that apply to `projectId`, in `order`. */
export function environmentsForProject(workspace: Workspace, projectId: string): readonly WorkspaceEnvironment[] {
  return workspace.environments
    .filter((environment) => appliesToProject(environment, projectId))
    .sort((a, b) => a.order - b.order);
}

/**
 * The environment active for `projectId`, or `undefined` when the project has no entry, the entry's
 * environment is gone, or it no longer applies to the project (its scope was narrowed).
 */
export function activeEnvironmentFor(workspace: Workspace, projectId: string): WorkspaceEnvironment | undefined {
  const environmentId = Object.hasOwn(workspace.activeEnvironments, projectId)
    ? workspace.activeEnvironments[projectId]
    : undefined;
  if (environmentId === undefined) {
    return undefined;
  }
  const environment = workspace.environments.find((candidate) => candidate.id === environmentId);
  return environment !== undefined && appliesToProject(environment, projectId) ? environment : undefined;
}

/**
 * `workspace` set up to resolve for `projectId`: its resolution slot holds that project's active
 * environment, or nothing. Resolvers read the slot, so call this once per project before them.
 */
export function workspaceForProject(workspace: Workspace, projectId: string): Workspace {
  return withActiveEnvironment(workspace, activeEnvironmentFor(workspace, projectId)?.id);
}

/**
 * Refuses an environment that does not apply to the project.
 *
 * @throws WorkspaceError `environment-out-of-scope` (details `environmentName`, `projectId`), or
 * `environment-not-found` for an id that names no environment.
 */
export function assertEnvironmentInScope(workspace: Workspace, environmentId: string, projectId: string): void {
  const environment = workspace.environments.find((candidate) => candidate.id === environmentId);
  if (environment === undefined) {
    throw new WorkspaceError('environment-not-found', `No environment with id "${environmentId}" in this workspace.`, {
      details: { environmentId },
    });
  }
  if (!appliesToProject(environment, projectId)) {
    throw new WorkspaceError(
      'environment-out-of-scope',
      `Environment "${environment.name}" does not apply to project "${projectId}".`,
      { details: { environmentName: environment.name, projectId } },
    );
  }
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
  readonly request: Pick<SoapRequestDef, 'endpointId' | 'endpointUrl'>;
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
  readonly api: { readonly slug: string; readonly baseUrl: string };
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
