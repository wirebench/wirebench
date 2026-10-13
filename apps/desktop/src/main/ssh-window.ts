import type { WebContents } from 'electron';
import { WirebenchError } from '@wirebench/engine';
import type { GetSecret } from '@wirebench/engine';
import { workspaceSecretGetter } from './secret-resolver.js';
import type { SecretLookup } from './secret-resolver.js';
import { whenWorkspaceSwitches } from './ssh-service.js';
import { teamSecretGetter } from './team-secret-store.js';
import type { TeamSecretsService } from './team-secrets-service.js';
import type { WindowScopes } from './window-scope.js';

/** What the SSH area reads from one window's scope (multi-window: each window holds its own workspace). */
export interface SshWindowScope {
  readonly workspace: { openWorkspaceId(): string | undefined };
  readonly secretSources: { wrap(next: GetSecret): GetSecret };
  readonly teamSecrets: Pick<TeamSecretsService, 'missingValueError'>;
}

/**
 * The window that sent an SSH call, by its `webContents` id; refused rather than guessed when it has
 * already closed (or was never a window of this app).
 *
 * @throws WirebenchError `no-window`
 */
export function sshScopeOf<S>(scopes: Pick<WindowScopes<S>, 'get'>, sender: { readonly id: number }): S {
  const scope = scopes.get(sender.id);
  if (scope === undefined) {
    throw new WirebenchError('no-window', 'There is no window to do this in.');
  }
  return scope;
}

/**
 * The SSH area's secret getter for one window, composed as main's project getter is but reading that
 * window's workspace-scoped entries (`wirebench-secret:workspace:<id>:<name>`), through that window's
 * team secrets and secret sources. The workspace id is read now: the getter stays bound to the workspace
 * open when it was made, so a later switch never changes whose secrets it answers with.
 */
export function sshSecretsFor(store: SecretLookup, scope: SshWindowScope, record: (value: string) => void): GetSecret {
  return scope.secretSources.wrap(
    teamSecretGetter(
      workspaceSecretGetter(store, scope.workspace.openWorkspaceId(), record),
      scope.teamSecrets,
      undefined,
    ),
  );
}

/**
 * One window's workspace-switch hook for the whole SSH area (multi-window: each window holds its own
 * workspace). A switch, or a close, in that window ends its terminals, its Files sessions and its forwards;
 * another window's go on.
 */
export function sshAreaEndsOnSwitch(
  services: readonly { disposeFor(sender: WebContents): void }[],
  sender: WebContents,
): (workspaceId: string | null | undefined) => void {
  return whenWorkspaceSwitches(() => {
    for (const service of services) service.disposeFor(sender);
  });
}
