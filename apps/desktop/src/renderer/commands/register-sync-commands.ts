import { useSyncStore } from '../state/sync.js';
import { registerCommand } from '../lib/commands.js';
import { workspaceIsShared } from './register-workspace-commands.js';

/**
 * Registers the `sync.*` commands: pull, push, fetch, commit and revealing the shared tree, all
 * gated on the open workspace being shared. `sync.openPanel` and `sync.resolveConflicts` are
 * registered here (so the registry audit sees a handler for every declared id) but are no-ops
 * until the Sync panel (Task 10) and the conflict resolver (Task 11) exist to open.
 */
export function registerSyncCommands(): void {
  registerCommand({
    id: 'sync.pull',
    label: 'Sync: Pull',
    category: 'Sync',
    when: workspaceIsShared,
    whenScope: 'workspace.shared',
    run: () => void useSyncStore.getState().pull(),
  });

  registerCommand({
    id: 'sync.push',
    label: 'Sync: Push',
    category: 'Sync',
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
    // Opens the conflict resolver — wired up once it exists (Task 11).
    run: () => {},
  });

  registerCommand({
    id: 'sync.openPanel',
    label: 'Sync: Show Sync Panel',
    category: 'Sync',
    when: workspaceIsShared,
    whenScope: 'workspace.shared',
    // Opens the Sync panel — wired up once it exists (Task 10).
    run: () => {},
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
