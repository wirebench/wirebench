/** Every `identity-*` problem (spec §3.1, §10), one function each so a code is spelled once. */
import { MIN_PASSWORD_LENGTH } from '@wirebench/engine';
import type { WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';

export const unauthenticated = (): WirebenchError => problem('identity-unauthenticated', 'Sign in to continue.', 401);
export const forbidden = (): WirebenchError => problem('identity-forbidden', 'Only a server admin can do this.', 403);
export const userDisabled = (): WirebenchError => problem('identity-user-disabled', 'This account is disabled.', 403);
export const methodDisabled = (): WirebenchError =>
  problem('identity-method-disabled', 'This sign-in method is not offered by this server.', 404);
/** One message for an unknown email and a wrong password (§6). */
export const invalidCredentials = (): WirebenchError =>
  problem('identity-invalid-credentials', 'The email or password is not right.', 401);
export const invitationInvalid = (): WirebenchError =>
  problem('identity-invitation-invalid', 'This invitation has expired or was already used.', 404);
export const invitationExists = (): WirebenchError =>
  problem('identity-invitation-exists', 'An open invitation for this email already exists; revoke it first.', 409);
export const userExists = (): WirebenchError =>
  problem('identity-user-exists', 'A user with this email already exists.', 409);
export const flowInvalid = (): WirebenchError =>
  problem('identity-flow-invalid', 'This sign-in could not be completed. Start again from Wirebench.', 400);
export const passwordTooShort = (): WirebenchError =>
  problem('identity-password-too-short', `Passwords must be at least ${MIN_PASSWORD_LENGTH} characters long.`, 400);
export const selfChange = (): WirebenchError =>
  problem('identity-self-change', 'You cannot remove your own admin flag or disable yourself.', 400);
export const notFound = (what: string): WirebenchError => problem('identity-not-found', `${what} was not found.`, 404);
export const emailUnverified = (): WirebenchError =>
  problem(
    'identity-email-unverified',
    'The identity provider did not assert email_verified for this account, so it cannot be linked.',
    403,
  );
export const notInvited = (): WirebenchError =>
  problem(
    'identity-not-invited',
    'No account or open invitation exists for this email. Ask a server admin to invite you.',
    403,
  );
export const oidcFailed = (): WirebenchError =>
  problem('identity-oidc-failed', 'The identity provider did not complete the sign-in.', 502);
