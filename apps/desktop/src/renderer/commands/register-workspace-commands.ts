import { registerCommand } from '../lib/commands.js';
import { projectRowActions } from '../features/explorer/project-actions.js';
import { workspaceActions } from '../features/workspace/workspace-actions.js';
import { useUiStore } from '../state/ui.js';
import { useWorkspaceStore } from '../state/workspace.js';

/** The project the explorer has selected, if any — what the four project commands act on. */
function selectedProjectId(): string | undefined {
  const selection = useUiStore.getState().selection;
  return selection?.kind === 'project' ? selection.id : undefined;
}

export function workspaceIsOpen(): boolean {
  return useWorkspaceStore.getState().workspace !== null;
}

/** Whether the open workspace is shared — the `when` gate for every `sync.*` command. */
export function workspaceIsShared(): boolean {
  const workspace = useWorkspaceStore.getState().workspace;
  return workspace !== null && workspace.share !== undefined;
}

/**
 * The Workspace commands: the workspace itself (create, switch, manage) and the four ways a
 * project joins or leaves one. Everything below is also reachable from the title bar's
 * switcher or the explorer; the palette and the application menu pick these up from the
 * registry, so a command registered here needs no wiring in either.
 */
export function registerWorkspaceCommands(): void {
  registerCommand({
    id: 'workspace.create',
    label: 'Create Workspace…',
    category: 'Workspace',
    run: () => {
      useUiStore.getState().setWorkspaceCreateOpen(true);
    },
  });

  registerCommand({
    id: 'workspace.switch',
    label: 'Switch Workspace…',
    category: 'Workspace',
    when: workspaceIsOpen,
    whenScope: 'workspace',
    // With no argument this opens the title bar's dropdown, which is where the choice lives.
    // The palette can also pass a workspace name or id to switch straight to it — which is
    // what makes switching reachable from the keyboard alone.
    run: (_context, arg) => {
      if (typeof arg === 'string') {
        const { workspaces, workspace } = useWorkspaceStore.getState();
        const match = workspaces.find((candidate) => candidate.id === arg || candidate.name === arg);
        if (match !== undefined && match.id !== workspace?.id && match.unreadable !== true) {
          void workspaceActions.open(match.id);
          return;
        }
      }
      // Deferred by a tick: this usually runs from the palette, which restores focus to
      // whatever had it as it closes — opening the menu first would hand that focus straight
      // back, leaving a menu on screen the keyboard cannot reach.
      setTimeout(() => {
        useUiStore.getState().setWorkspaceSwitcherOpen(true);
      }, 0);
    },
  });

  registerCommand({
    id: 'workspace.manage',
    label: 'Manage Workspaces…',
    category: 'Workspace',
    run: () => {
      useUiStore.getState().setWorkspaceManageOpen(true);
    },
  });

  // Moved here from `register-project-commands.ts` with the rest of the workspace vocabulary;
  // `project.new` / `project.open` / `project.close` are gone, because a project belongs to a
  // workspace and creating one asks for a name only.
  registerCommand({
    id: 'workspace.newProject',
    label: 'New Project…',
    category: 'Workspace',
    shortcut: 'Mod+Shift+N',
    when: workspaceIsOpen,
    whenScope: 'workspace',
    run: () => {
      workspaceActions.newProject();
    },
  });

  registerCommand({
    id: 'workspace.linkProject',
    label: 'Link Project Folder…',
    category: 'Workspace',
    // A shared workspace holds its projects inside the workspace's own tree — linking an
    // external folder into it is refused before this ever reaches main. See `Move to workspace…`.
    when: () => workspaceIsOpen() && !workspaceIsShared(),
    whenScope: 'workspace',
    run: () => {
      void workspaceActions.linkProject();
    },
  });

  registerCommand({
    id: 'workspace.importProjectFolder',
    label: 'Import Project Folder…',
    category: 'Workspace',
    when: workspaceIsOpen,
    whenScope: 'workspace',
    run: () => {
      void workspaceActions.importProjectFolder();
    },
  });

  registerCommand({
    id: 'workspace.exportProject',
    label: 'Export Project…',
    category: 'Workspace',
    when: () => selectedProjectId() !== undefined,
    whenScope: 'selection.project',
    run: () => {
      const projectId = selectedProjectId();
      if (projectId !== undefined) {
        projectRowActions.export(projectId);
      }
    },
  });

  registerCommand({
    id: 'workspace.removeProject',
    label: 'Remove Project from Workspace…',
    category: 'Workspace',
    when: () => selectedProjectId() !== undefined,
    whenScope: 'selection.project',
    // Nothing is removed until the confirmation is answered; the dialog lives in the shell.
    run: () => {
      const projectId = selectedProjectId();
      if (projectId !== undefined) {
        projectRowActions.remove(projectId);
      }
    },
  });

  registerCommand({
    id: 'workspace.share',
    label: 'Share Workspace…',
    category: 'Workspace',
    when: () => workspaceIsOpen() && !workspaceIsShared(),
    whenScope: 'workspace',
    run: () => {
      useUiStore.getState().setShareDialogOpen(true);
    },
  });

  registerCommand({
    id: 'workspace.join',
    label: 'Join Shared Workspace…',
    category: 'Workspace',
    run: () => {
      useUiStore.getState().setJoinDialogOpen(true);
    },
  });

  registerCommand({
    id: 'workspace.stopSharing',
    label: 'Stop Sharing',
    category: 'Workspace',
    when: workspaceIsShared,
    whenScope: 'workspace.shared',
    run: () => {
      void workspaceActions.stopSharing();
    },
  });

  registerCommand({
    id: 'project.moveToWorkspace',
    label: 'Move to Workspace…',
    category: 'Project',
    when: workspaceIsOpen,
    whenScope: 'workspace',
    // The palette has no project to act on; this is reached with the id as an argument from the
    // explorer's context menu, the only place it is offered today.
    run: (_context, arg) => {
      if (typeof arg === 'string') {
        projectRowActions.moveToWorkspace(arg);
      }
    },
  });
}
