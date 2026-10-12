/**
 * Which workspace environments apply to which project (#468), on the renderer's wire model.
 *
 * The same rule as the engine's `appliesToProject` / `environmentsForProject` /
 * `activeEnvironmentFor`, kept here because the renderer may not import engine subpaths and must
 * not pull values from `wire-types` at start-up. Type-only imports, so it stays pure.
 */

import type { WorkspaceEnvironmentWire, WorkspaceWire } from '../../shared/wire-base.js';

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
