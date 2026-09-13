import { useSyncStore } from '../../state/sync.js';
import { useWorkspaceStore } from '../../state/workspace.js';

/**
 * The status bar's sync indicator. Placeholder: shows the raw state word only — the Sync panel
 * (Task 10) turns this into something clickable with real presentation (icons, ahead/behind
 * counts, a spinner while `syncing`). Renders nothing when the open workspace is not shared.
 */
export function SyncBadge() {
  const share = useWorkspaceStore((state) => state.workspace?.share);
  const state = useSyncStore((store) => store.status.state);

  if (share === undefined) {
    return null;
  }

  return (
    <span data-testid="status-bar-sync" data-state={state}>
      {state}
    </span>
  );
}
