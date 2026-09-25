import { catalogEntry } from '@shared/command-catalog.js';
import { registerCommand } from '../lib/commands.js';
import { signedInServers, useAccountStore } from '../state/account.js';
import { useUiStore } from '../state/ui.js';

/** True when at least one known server has a live session — the gate for `account.signOut`. */
export function hasSignedInServer(): boolean {
  return signedInServers(useAccountStore.getState().servers).length > 0;
}

/**
 * Registers the `account.*` commands and `team.manage`. Sign-in is always available (it is how a
 * server first becomes known); sign-out acts directly with one signed-in server and defers to
 * Preferences → Accounts, where each server has its own button, with more.
 */
export function registerAccountCommands(): void {
  registerCommand({
    ...catalogEntry('account.signIn'),
    run: () => {
      useUiStore.getState().openSignInDialog();
    },
  });

  registerCommand({
    ...catalogEntry('account.signOut'),
    when: hasSignedInServer,
    whenScope: 'account.signedIn',
    run: () => {
      const signedIn = signedInServers(useAccountStore.getState().servers);
      const only = signedIn.length === 1 ? signedIn[0] : undefined;
      if (only !== undefined) {
        void useAccountStore.getState().signOut(only.url);
      } else {
        useUiStore.getState().openPreferences('accounts');
      }
    },
  });

  registerCommand({
    ...catalogEntry('team.manage'),
    when: hasSignedInServer,
    whenScope: 'account.signedIn',
    run: () => {
      useUiStore.getState().openTeamDialog();
    },
  });
}
