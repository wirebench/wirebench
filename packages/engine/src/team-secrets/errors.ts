import { WirebenchError } from '../errors.js';

/** The user-facing team-secrets failures (spec §3.8), one message each. */
export const TEAM_SECRETS_MESSAGES = {
  'team-secrets-pending': 'This machine is waiting for an admin to approve it for team secrets.',
  'team-secrets-no-safe-storage': 'Team secrets need the system keychain, which is not available on this machine.',
  'team-secrets-admin-only': 'Only a workspace admin can change who has access to team secrets.',
  'team-secrets-untrusted': 'Ignored a secret signed by a key that is not approved.',
  'team-secrets-last-admin': 'A workspace needs at least one admin for team secrets.',
} as const;

export type TeamSecretsErrorCode = keyof typeof TEAM_SECRETS_MESSAGES;

export function teamSecretsError(
  code: TeamSecretsErrorCode,
  details?: Readonly<Record<string, unknown>>,
): WirebenchError {
  return new WirebenchError(code, TEAM_SECRETS_MESSAGES[code], details !== undefined ? { details } : undefined);
}
