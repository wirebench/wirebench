/**
 * The `teamSecrets.*` IPC channels: the Sync panel's Team secrets section drives the open shared
 * workspace's {@link TeamSecretsService} through these. Every answer is the status wire — ids,
 * names, fingerprints and labels — and no request carries a value.
 */
import { channels } from '@wirebench/wire/ipc';
import type { TeamSecretsService } from '../team-secrets-service.js';
import { registerHandler, type HandlerTable } from './register.js';

export type TeamSecretsChannelService = Pick<
  TeamSecretsService,
  | 'status'
  | 'turnOn'
  | 'requestAccess'
  | 'approve'
  | 'decline'
  | 'remove'
  | 'grantAdmin'
  | 'revokeAdmin'
  | 'restoreMine'
  | 'dismissReplaced'
>;

export function registerTeamSecretsChannels(
  table: HandlerTable,
  service: TeamSecretsChannelService,
  /** Refuses every call but `status` when `team-secrets` is off (phase 4 spec §7). */
  requireFeature: (feature: string) => void = () => undefined,
  /**
   * `false` on a host whose platform lacks the `team-secrets` capability (the server's, hosted edition
   * decision 5): only `status` is registered, so nothing can make, request or use a machine key there.
   */
  machineKeys = true,
): void {
  const guarded = <T>(run: () => Promise<T>): Promise<T> => {
    requireFeature('team-secrets');
    return run();
  };
  registerHandler(table, channels.teamSecrets.status, () => service.status());
  if (!machineKeys) {
    return;
  }
  registerHandler(table, channels.teamSecrets.turnOn, () => guarded(() => service.turnOn({ commit: true })));
  registerHandler(table, channels.teamSecrets.requestAccess, () => guarded(() => service.requestAccess()));
  registerHandler(table, channels.teamSecrets.approve, ({ keyId }) => guarded(() => service.approve(keyId)));
  registerHandler(table, channels.teamSecrets.decline, ({ keyId }) => guarded(() => service.decline(keyId)));
  registerHandler(table, channels.teamSecrets.remove, ({ keyId }) => guarded(() => service.remove(keyId)));
  registerHandler(table, channels.teamSecrets.grantAdmin, ({ keyId }) => guarded(() => service.grantAdmin(keyId)));
  registerHandler(table, channels.teamSecrets.revokeAdmin, ({ keyId }) => guarded(() => service.revokeAdmin(keyId)));
  registerHandler(table, channels.teamSecrets.restoreMine, ({ entryId }) =>
    guarded(() => service.restoreMine(entryId)),
  );
  registerHandler(table, channels.teamSecrets.dismissReplaced, ({ entryId }) =>
    guarded(() => service.dismissReplaced(entryId)),
  );
}
