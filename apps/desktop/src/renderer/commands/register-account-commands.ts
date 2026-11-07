import { catalogEntry } from '@shared/command-catalog.js';
import { hasCapability, tabSignOut } from '../lib/capabilities.js';
import { registerCommand } from '../lib/commands.js';
import { activeAccount, signedInServers, useAccountStore } from '../state/account.js';
import { manageTeam } from '../features/team/team-link.js';
import { useUiStore } from '../state/ui.js';

/** True when at least one known server has a live session — the gate for `account.signOut`. */
export function hasSignedInServer(): boolean {
  return signedInServers(useAccountStore.getState().servers).length > 0;
}

/**
 * Registers the `account.*` commands and `team.manage`. Sign-in is always available (it is how a
 * server first becomes known); sign-out signs the active account out (switch accounts spec §3), as the account
 * menu's *Sign out* does; User settings → Servers you're signed in to signs out any other.
 */
export function registerAccountCommands(): void {
  registerCommand({
    ...catalogEntry('account.signIn'),
    run: () => {
      useUiStore.getState().openSignInDialog();
    },
  });

  registerCommand({
    ...catalogEntry('account.pairThisMachine'),
    run: () => {
      useUiStore.getState().setPairMachineDialogOpen(true);
    },
  });

  registerCommand({
    ...catalogEntry('account.signOut'),
    when: hasSignedInServer,
    whenScope: 'account.signedIn',
    run: () => {
      // A browser tab ends its own session; `account.signOut` is refused there.
      const endTab = tabSignOut();
      if (!hasCapability('accounts') && endTab !== undefined) {
        endTab();
        return;
      }
      const { servers, active } = useAccountStore.getState();
      const current = activeAccount(servers, active);
      if (current !== undefined) {
        void useAccountStore.getState().signOut({ url: current.url, userId: current.userId });
      } else {
        useUiStore.getState().openUserSettings('servers');
      }
    },
  });

  registerCommand({
    ...catalogEntry('account.settings'),
    run: () => {
      useUiStore.getState().openUserSettings();
    },
  });

  registerCommand({
    ...catalogEntry('team.manage'),
    when: hasSignedInServer,
    whenScope: 'account.signedIn',
    run: () => {
      void manageTeam();
    },
  });
}
