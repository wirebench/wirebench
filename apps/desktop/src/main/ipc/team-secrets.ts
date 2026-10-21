/**
 * The `teamSecrets.*` IPC channels: the Sync panel's Team secrets section drives the open shared
 * workspace's {@link TeamSecretsService} through these. Every answer is the status wire — ids,
 * names, fingerprints and labels — and no request carries a value.
 */
import { channels } from '../../shared/ipc.js';
import type { TeamSecretsService } from '../team-secrets-service.js';
import { registerHandler } from './register.js';

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
  service: TeamSecretsChannelService,
  /** Refuses every call but `status` when `team-secrets` is off (phase 4 spec §7). */
  requireFeature: (feature: string) => void = () => undefined,
): void {
  const guarded = <T>(run: () => Promise<T>): Promise<T> => {
    requireFeature('team-secrets');
    return run();
  };
  registerHandler(channels.teamSecrets.status, () => service.status());
  registerHandler(channels.teamSecrets.turnOn, () => guarded(() => service.turnOn({ commit: true })));
  registerHandler(channels.teamSecrets.requestAccess, () => guarded(() => service.requestAccess()));
  registerHandler(channels.teamSecrets.approve, ({ keyId }) => guarded(() => service.approve(keyId)));
  registerHandler(channels.teamSecrets.decline, ({ keyId }) => guarded(() => service.decline(keyId)));
  registerHandler(channels.teamSecrets.remove, ({ keyId }) => guarded(() => service.remove(keyId)));
  registerHandler(channels.teamSecrets.grantAdmin, ({ keyId }) => guarded(() => service.grantAdmin(keyId)));
  registerHandler(channels.teamSecrets.revokeAdmin, ({ keyId }) => guarded(() => service.revokeAdmin(keyId)));
  registerHandler(channels.teamSecrets.restoreMine, ({ entryId }) => guarded(() => service.restoreMine(entryId)));
  registerHandler(channels.teamSecrets.dismissReplaced, ({ entryId }) =>
    guarded(() => service.dismissReplaced(entryId)),
  );
}
