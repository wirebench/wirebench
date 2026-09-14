import { useSyncStore } from '../state/sync.js';
import { useUiStore } from '../state/ui.js';
import { registerCommand } from '../lib/commands.js';
import { workspaceIsShared } from './register-workspace-commands.js';

/**
 * Registers the `sync.*` commands: pull, push, fetch, commit and revealing the shared tree, all
 * gated on the open workspace being shared. `sync.openPanel` opens the Sync panel (Task 10) and
 * `sync.resolveConflicts` opens the conflict resolver flag (Task 11 mounts the component).
 */
export function registerSyncCommands(): void {
  registerCommand({
    id: 'sync.pull',
    label: 'Sync: Pull',
    category: 'Sync',
    shortcut: 'Mod+Alt+L',
    when: workspaceIsShared,
    whenScope: 'workspace.shared',
    run: () => void useSyncStore.getState().pull(),
  });

  registerCommand({
    id: 'sync.push',
    label: 'Sync: Push',
    category: 'Sync',
    shortcut: 'Mod+Alt+U',
    when: workspaceIsShared,
    whenScope: 'workspace.shared',
    run: () => void useSyncStore.getState().push(),
  });

  registerCommand({
    id: 'sync.fetch',
    label: 'Sync: Fetch',
    category: 'Sync',
    when: workspaceIsShared,
    whenScope: 'workspace.shared',
    run: () => void useSyncStore.getState().fetch(),
  });

  registerCommand({
    id: 'sync.commit',
    label: 'Sync: Commit',
    category: 'Sync',
    when: workspaceIsShared,
    whenScope: 'workspace.shared',
    run: () => void useSyncStore.getState().commit(),
  });

  registerCommand({
    id: 'sync.resolveConflicts',
    label: 'Sync: Resolve Conflicts…',
    category: 'Sync',
    when: workspaceIsShared,
    whenScope: 'workspace.shared',
    // The resolver component itself is mounted against this flag in Task 11.
    run: () => {
      useUiStore.getState().setConflictResolverOpen(true);
    },
  });

  registerCommand({
    id: 'sync.openPanel',
    label: 'Sync: Show Sync Panel',
    category: 'Sync',
    when: workspaceIsShared,
    whenScope: 'workspace.shared',
    run: () => {
      useUiStore.getState().setSyncPanelOpen(true);
    },
  });

  registerCommand({
    id: 'sync.revealTree',
    label: 'Sync: Reveal Shared Folder',
    category: 'Sync',
    when: workspaceIsShared,
    whenScope: 'workspace.shared',
    run: () => void useSyncStore.getState().revealTree(),
  });
}
