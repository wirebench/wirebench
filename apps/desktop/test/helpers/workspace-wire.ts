import type {
  WorkspaceEnvironmentWire,
  WorkspaceProjectWire,
  WorkspaceShareWire,
  WorkspaceWire,
} from '../../src/shared/wire-types.js';

/**
 * The smallest open workspace a renderer test needs: an id, a name, and whichever environments
 * or projects the test is actually about. Keeps every test from restating seven fields it does
 * not care about, and keeps them all honest when the wire shape grows a field.
 */
export function workspaceWire(
  patch: {
    readonly environments?: readonly WorkspaceEnvironmentWire[];
    readonly activeEnvironmentId?: string;
    readonly projects?: readonly WorkspaceProjectWire[];
    readonly properties?: Readonly<Record<string, string>>;
    readonly disabled?: readonly string[];
    readonly name?: string;
    readonly id?: string;
    readonly share?: WorkspaceShareWire;
  } = {},
): WorkspaceWire {
  return {
    id: patch.id ?? 'w1',
    name: patch.name ?? 'Workspace 1',
    dir: `/tmp/workspaces/${patch.id ?? 'w1'}`,
    properties: { ...patch.properties },
    disabled: [...(patch.disabled ?? [])],
    environments: [...(patch.environments ?? [])],
    ...(patch.activeEnvironmentId !== undefined ? { activeEnvironmentId: patch.activeEnvironmentId } : {}),
    projects: [...(patch.projects ?? [])],
    ...(patch.share !== undefined ? { share: patch.share } : {}),
  };
}
