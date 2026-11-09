import { useEffect } from 'react';
import { activeAccount, useAccountStore } from '../../state/account.js';
import { useActiveTeamStore } from '../../state/active-team.js';
import { useWorkspaceStore } from '../../state/workspace.js';

/**
 * Keeps the title bar's active team in step with the window: the active account's teams load when it changes,
 * and they reload (so a workspace made since is known) and follow the open workspace whenever a team workspace
 * opens, which makes its team the active one.
 */
export function useActiveTeam(): void {
  const account = useAccountStore((state) => activeAccount(state.servers, state.active));
  const url = account?.url;
  const userId = account?.userId;
  const share = useWorkspaceStore((state) => state.workspace?.share);
  const server = share?.kind === 'server' ? share.server : undefined;
  const openUrl = server?.url;
  const openWorkspaceId = server?.workspaceId;

  useEffect(() => {
    let current = true;
    const store = useActiveTeamStore.getState();
    void store.load(url !== undefined && userId !== undefined ? { url, userId } : undefined).then(() => {
      if (current && openUrl !== undefined && openWorkspaceId !== undefined) {
        useActiveTeamStore.getState().follow(openUrl, openWorkspaceId);
      }
    });
    return () => {
      current = false;
    };
  }, [url, userId, openUrl, openWorkspaceId]);
}
