import { catalogEntry } from '@shared/command-catalog.js';
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
    ...catalogEntry('sync.pull'),
    when: workspaceIsShared,
    whenScope: 'workspace.shared',
    run: () => void useSyncStore.getState().pull(),
  });

  registerCommand({
    ...catalogEntry('sync.push'),
    when: workspaceIsShared,
    whenScope: 'workspace.shared',
    run: () => void useSyncStore.getState().push(),
  });

  registerCommand({
    ...catalogEntry('sync.fetch'),
    when: workspaceIsShared,
    whenScope: 'workspace.shared',
    run: () => void useSyncStore.getState().fetch(),
  });

  registerCommand({
    ...catalogEntry('sync.commit'),
    when: workspaceIsShared,
    whenScope: 'workspace.shared',
    run: () => void useSyncStore.getState().commit(),
  });

  registerCommand({
    ...catalogEntry('sync.resolveConflicts'),
    when: workspaceIsShared,
    whenScope: 'workspace.shared',
    // The resolver component itself is mounted against this flag in Task 11.
    run: () => {
      useUiStore.getState().setConflictResolverOpen(true);
    },
  });

  registerCommand({
    ...catalogEntry('sync.openPanel'),
    when: workspaceIsShared,
    whenScope: 'workspace.shared',
    run: () => {
      useUiStore.getState().setSyncPanelOpen(true);
    },
  });

  registerCommand({
    ...catalogEntry('sync.revealTree'),
    when: workspaceIsShared,
    whenScope: 'workspace.shared',
    run: () => void useSyncStore.getState().revealTree(),
  });
}
