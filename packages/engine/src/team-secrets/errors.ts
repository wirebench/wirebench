import { WirebenchError } from '../errors.js';

/** The user-facing team-secrets failures (spec §3.8), one message each. */
export const TEAM_SECRETS_MESSAGES = {
  'team-secrets-pending': 'This machine is waiting for an admin to approve it for team secrets.',
  'team-secrets-no-safe-storage': 'Team secrets need the system keychain, which is not available on this machine.',
  'team-secrets-admin-only': 'Only a workspace admin can change who has access to team secrets.',
  'team-secrets-untrusted': 'Ignored a secret signed by a key that is not approved.',
  'team-secrets-last-admin': 'A workspace needs at least one admin for team secrets.',
  'team-secrets-not-canonical': 'A team secrets document contained a value that could not be signed.',
  'team-secrets-bad-key': 'A team secrets key was malformed.',
  'team-secrets-decrypt-failed': 'A team secret could not be decrypted.',
  'team-secrets-not-shared': 'Team secrets need a shared workspace.',
  'team-secrets-no-such-key': 'That machine is not waiting for approval, or not approved, as this change needs.',
  'team-secrets-server-authority': 'On a server workspace, the server roles decide who is an admin.',
  'team-secrets-remove-self': 'Ask another admin to remove this machine.',
  'team-secrets-cannot-reencrypt':
    'Some team secrets are not readable on this machine, so they cannot be re-encrypted. Ask another admin to remove this machine, or wait for this machine to receive them.',
  'team-secrets-already-admin': 'That machine is already a team secrets admin.',
  'team-secrets-not-admin': 'That machine is not a team secrets admin.',
  'team-secrets-last-approved': 'A workspace needs at least one approved machine for team secrets.',
  'team-secrets-not-allowed': 'That change to team secrets access is not allowed.',
  'team-secrets-damaged':
    'The team secrets access log on this machine does not match what it saw before; this machine will not change team secrets until it is repaired.',
} as const;

export type TeamSecretsErrorCode = keyof typeof TEAM_SECRETS_MESSAGES;

export function teamSecretsError(
  code: TeamSecretsErrorCode,
  details?: Readonly<Record<string, unknown>>,
): WirebenchError {
  return new WirebenchError(code, TEAM_SECRETS_MESSAGES[code], details !== undefined ? { details } : undefined);
}
