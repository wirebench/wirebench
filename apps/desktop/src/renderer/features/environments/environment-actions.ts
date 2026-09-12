import { useEditorsStore } from '../../state/editors.js';
import { selectEnvironment, useProjectStore } from '../../state/project.js';
import { useWorkspaceStore } from '../../state/workspace.js';

/**
 * What the environment editor page shows: one of the workspace's own environments or a linked
 * project's own (both named by id, unique across the open workspace), or one of the two fixed
 * scopes that are not "an environment" at all — Globals and the workspace's own root properties.
 */
export type EnvironmentTarget =
  { readonly kind: 'environment'; readonly id: string } | { readonly kind: 'globals' } | { readonly kind: 'workspace' };

/**
 * The id `EditorTab.environmentId`/`PersistedTab.id` encode a target as: a real environment's
 * id for `'environment'`, or the scope's own name as a sentinel for the two fixed scopes — the
 * environment id space is UUIDs, so `'globals'`/`'workspace'` never collide with a real one.
 */
function targetId(target: EnvironmentTarget): string {
  return target.kind === 'environment' ? target.id : target.kind;
}

/** The inverse of {@link targetId}: recovers the target an encoded id names. */
export function targetFromId(id: string): EnvironmentTarget {
  if (id === 'globals' || id === 'workspace') {
    return { kind: id };
  }
  return { kind: 'environment', id };
}

/**
 * One environment by id, from whichever scope owns it: the workspace's own environments, or a
 * project's. Both appear in the same places (the sidebar list, an editor tab), and the id is
 * unique across the open workspace, so the caller never has to say which kind it meant.
 *
 * For a linked project's own environment, `owningProjectName` names the project that owns it —
 * two projects can have an environment of the same name, so the tab title needs both to stay
 * distinguishable. `undefined` for a workspace environment, which has no single owning project.
 */
function environmentById(
  environmentId: string,
): { readonly name: string; readonly owningProjectName?: string } | undefined {
  const workspace = useWorkspaceStore.getState().workspace;
  const workspaceEnvironment = workspace?.environments.find((candidate) => candidate.id === environmentId);
  if (workspaceEnvironment !== undefined) {
    return workspaceEnvironment;
  }
  const projectStore = useProjectStore.getState();
  const projectEnvironment = selectEnvironment(projectStore, environmentId);
  if (projectEnvironment === undefined) {
    return undefined;
  }
  const projectId = projectStore.projectOf[environmentId];
  const owningProjectName = workspace?.projects.find((candidate) => candidate.id === projectId)?.name ?? 'this project';
  return { name: projectEnvironment.name, owningProjectName };
}

/**
 * The default name the Environments view's "Add environment" toolbar button assigns: the first
 * `Environment N` not already taken by one of the workspace's environments.
 */
export function nextEnvironmentName(existing: readonly { readonly name: string }[]): string {
  const taken = new Set(existing.map((environment) => environment.name));
  let n = 1;
  while (taken.has(`Environment ${n}`)) {
    n += 1;
  }
  return `Environment ${n}`;
}

/** The editor-tab id a target opens under; stable so re-opening focuses the same tab. */
export function environmentTabId(target: EnvironmentTarget): string {
  return `env:${targetId(target)}`;
}

/** Opens (or focuses) the editor tab for one environment target. No-op for an unknown id. */
export function openEnvironmentTab(target: EnvironmentTarget): void {
  const environment = target.kind === 'environment' ? environmentById(target.id) : undefined;
  const title =
    target.kind === 'globals'
      ? 'Globals'
      : target.kind === 'workspace'
        ? 'Workspace'
        : environment !== undefined
          ? environment.owningProjectName !== undefined
            ? `${environment.owningProjectName} › ${environment.name}`
            : environment.name
          : undefined;
  if (title === undefined) {
    return;
  }
  useEditorsStore.getState().open({
    id: environmentTabId(target),
    kind: 'environment',
    title,
    environmentId: targetId(target),
  });
}

/**
 * Copies an environment: a new one named `<name> (copy)`, then a patch carrying the original's
 * endpoints and properties (both maps replace wholesale). Returns the new environment's id.
 */
export async function duplicateEnvironment(environmentId: string): Promise<string | undefined> {
  const workspace = useWorkspaceStore.getState();
  const fromWorkspace = workspace.workspace?.environments.find((candidate) => candidate.id === environmentId);
  if (fromWorkspace !== undefined) {
    const { createdEnvironmentId } = await workspace.mutate({
      kind: 'add-workspace-environment',
      name: `${fromWorkspace.name} (copy)`,
    });
    if (createdEnvironmentId === undefined) {
      return undefined;
    }
    await workspace.mutate({
      kind: 'update-workspace-environment',
      environmentId: createdEnvironmentId,
      patch: { endpoints: { ...fromWorkspace.endpoints }, properties: { ...fromWorkspace.properties } },
    });
    return createdEnvironmentId;
  }
  const store = useProjectStore.getState();
  const source = selectEnvironment(store, environmentId);
  const projectId = store.projectOf[environmentId];
  if (source === undefined || projectId === undefined) {
    return undefined;
  }
  const createdId = await store.addEnvironment(projectId, `${source.name} (copy)`);
  await store.updateEnvironment(projectId, createdId, {
    endpoints: { ...source.endpoints },
    properties: { ...source.properties },
  });
  return createdId;
}
