/**
 * Which workspace environments apply to which project (#468), on the renderer's wire model.
 *
 * The same rule as the engine's `appliesToProject` / `environmentsForProject` /
 * `activeEnvironmentFor`, kept here because the renderer may not import engine subpaths and must
 * not pull values from `wire-types` at start-up. Type-only imports, so it stays pure.
 */

import type { WorkspaceEnvironmentWire, WorkspaceProjectWire, WorkspaceWire } from '@shared/wire-base.js';

/**
 * True when `environment` applies to `projectId`: its `projects` scope is absent (every project,
 * including ones added later) or lists the id. `[]` applies to none.
 */
export function appliesToProject(environment: WorkspaceEnvironmentWire, projectId: string): boolean {
  return environment.projects === undefined || environment.projects.includes(projectId);
}

/** The environments of `workspace` that apply to `projectId`, in `order` (ties by name). */
export function environmentsForProject(
  workspace: WorkspaceWire,
  projectId: string,
): readonly WorkspaceEnvironmentWire[] {
  return workspace.environments
    .filter((environment) => appliesToProject(environment, projectId))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/**
 * The environment active for `projectId`, or `undefined` when there is no workspace or project, the
 * project has no entry, the entry's environment is gone, or it no longer applies to the project.
 * Main already drops such entries; the renderer does not rely on it.
 */
export function activeEnvironmentFor(
  workspace: WorkspaceWire | null | undefined,
  projectId: string | undefined,
): WorkspaceEnvironmentWire | undefined {
  if (
    workspace === null ||
    workspace === undefined ||
    projectId === undefined ||
    !Object.hasOwn(workspace.activeEnvironments, projectId)
  ) {
    return undefined;
  }
  const environmentId = workspace.activeEnvironments[projectId];
  const environment = workspace.environments.find((candidate) => candidate.id === environmentId);
  return environment !== undefined && appliesToProject(environment, projectId) ? environment : undefined;
}

/** The switcher's two groups for one project (#468); either may be empty. */
export interface SwitcherGroups {
  /** Environments with no `projects` scope: they apply to every project. */
  readonly allProjects: readonly WorkspaceEnvironmentWire[];
  /** Environments scoped to a list that includes the project. */
  readonly project: readonly WorkspaceEnvironmentWire[];
}

/**
 * What the title-bar switcher offers `projectId`: the every-project environments, then the ones
 * scoped to it, each group in `order` (ties by name).
 */
export function switcherGroups(workspace: WorkspaceWire, projectId: string): SwitcherGroups {
  const applicable = environmentsForProject(workspace, projectId);
  return {
    allProjects: applicable.filter((environment) => environment.projects === undefined),
    project: applicable.filter((environment) => environment.projects !== undefined),
  };
}

/** {@link switcherGroups} as one list in the menu's order: what `env.next` walks. */
export function switcherEnvironments(workspace: WorkspaceWire, projectId: string): readonly WorkspaceEnvironmentWire[] {
  const groups = switcherGroups(workspace, projectId);
  return [...groups.allProjects, ...groups.project];
}

/**
 * The environments that removing `projectId` leaves with no project of this workspace: scoped to
 * it, and to nothing else this machine knows. Main keeps them with whatever ids remain, and the
 * Environments view shows them as *No project*, so the remove dialog names them first.
 */
export function environmentsLeftWithoutProject(
  workspace: WorkspaceWire,
  projectId: string,
): readonly WorkspaceEnvironmentWire[] {
  const others = new Set(workspace.projects.map((project) => project.id).filter((id) => id !== projectId));
  return workspace.environments
    .filter(
      (environment) =>
        environment.projects?.includes(projectId) === true && !environment.projects.some((id) => others.has(id)),
    )
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/**
 * What a scoped environment's chips read (#468): the projects it applies to, in the workspace's
 * order, or *No project* when none of this workspace's projects is in its scope. `undefined` for an
 * environment that applies to every project, which carries no chip at all.
 */
export function scopeChips(
  environment: WorkspaceEnvironmentWire,
  projects: readonly WorkspaceProjectWire[],
): readonly string[] | undefined {
  if (environment.projects === undefined) {
    return undefined;
  }
  const names = projects.filter((project) => appliesToProject(environment, project.id)).map((project) => project.name);
  return names.length > 0 ? names : ['No project'];
}

/**
 * Why `environment` cannot be made active for the current project, or `undefined` when it can:
 * there is no current project yet, or the environment does not apply to it (#468).
 */
export function activeBlocker(
  environment: WorkspaceEnvironmentWire,
  projectId: string | undefined,
  projects: readonly WorkspaceProjectWire[],
): string | undefined {
  if (projectId === undefined) {
    return 'Open a request first: setting an environment active acts for its project';
  }
  if (appliesToProject(environment, projectId)) {
    return undefined;
  }
  const name = projects.find((project) => project.id === projectId)?.name ?? 'this project';
  return `${environment.name} does not apply to ${name}`;
}
