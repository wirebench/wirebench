import { useUiStore } from '../../state/ui.js';

/** Opens the Secret Sources dialog, with the add form filled in for `name` when one is given. */
export function openSecretSourcesDialog(name?: string): void {
  useUiStore.getState().setSecretSourcesDialog(name === undefined ? {} : { name });
}

/** Opens the dialog that approves the workspace's shared secret sources on this machine. */
export function openSecretSourcesApproval(): void {
  useUiStore.getState().setSecretSourcesApproval(true);
}
