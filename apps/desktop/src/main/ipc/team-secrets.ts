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

export function registerTeamSecretsChannels(service: TeamSecretsChannelService): void {
  registerHandler(channels.teamSecrets.status, () => service.status());
  registerHandler(channels.teamSecrets.turnOn, () => service.turnOn({ commit: true }));
  registerHandler(channels.teamSecrets.requestAccess, () => service.requestAccess());
  registerHandler(channels.teamSecrets.approve, ({ keyId }) => service.approve(keyId));
  registerHandler(channels.teamSecrets.decline, ({ keyId }) => service.decline(keyId));
  registerHandler(channels.teamSecrets.remove, ({ keyId }) => service.remove(keyId));
  registerHandler(channels.teamSecrets.grantAdmin, ({ keyId }) => service.grantAdmin(keyId));
  registerHandler(channels.teamSecrets.revokeAdmin, ({ keyId }) => service.revokeAdmin(keyId));
  registerHandler(channels.teamSecrets.restoreMine, ({ entryId }) => service.restoreMine(entryId));
  registerHandler(channels.teamSecrets.dismissReplaced, ({ entryId }) => service.dismissReplaced(entryId));
}
