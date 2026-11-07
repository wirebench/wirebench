/** Every `identity-*` problem (spec §3.1, §10), one function each so a code is spelled once. */
import {
  IMAGE_LIMITS,
  MAX_ABOUT_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  MIN_USERNAME_LENGTH,
  RESERVED_USERNAMES,
  type ImageKind,
} from '@wirebench/engine';
import type { WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';

export const unauthenticated = (): WirebenchError => problem('identity-unauthenticated', 'Sign in to continue.', 401);
export const forbidden = (): WirebenchError => problem('identity-forbidden', 'Only a server admin can do this.', 403);
/** A cookie-authenticated write from another origin, or with no Origin at all (hosted spec §17.2). */
export const originRefused = (): WirebenchError =>
  problem('identity-origin-refused', 'This request did not come from this server’s own pages.', 403);
/** `GET /me/accounts` from anything but the browser's session cookie (switch accounts spec §5.5). */
export const browserOnly = (): WirebenchError =>
  problem('identity-browser-only', 'Only a browser session holds other accounts to list.', 403);
export const userDisabled = (): WirebenchError => problem('identity-user-disabled', 'This account is disabled.', 403);
export const methodDisabled = (): WirebenchError =>
  problem('identity-method-disabled', 'This sign-in method is not offered by this server.', 404);
/** One message for an unknown email, an unknown username and a wrong password (§6, user profile spec §5). */
export const invalidCredentials = (): WirebenchError =>
  problem('identity-invalid-credentials', 'The email, username or password is not right.', 401);
/** User profile spec §5: a sign-in names its account by `identifier` or, from an older desktop, `email`; not both. */
export const identifierInvalid = (): WirebenchError =>
  problem('identity-identifier-invalid', 'Send either an identifier or an email, not both.', 400);
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
export const displayNameInvalid = (): WirebenchError => problem('identity-name-invalid', 'Enter a name.', 400);
/** `PATCH /me` with none of its fields. */
export const updateEmpty = (): WirebenchError =>
  problem('identity-update-empty', 'Send a name, a username or an about text to change.', 400);
/** User profile spec §2: the pattern, or a reserved name. */
export const usernameInvalid = (username: string): WirebenchError =>
  RESERVED_USERNAMES.includes(username.toLowerCase())
    ? problem('identity-username-invalid', 'This username is reserved.', 400)
    : problem(
        'identity-username-invalid',
        `A username is ${String(MIN_USERNAME_LENGTH)} to ${String(MAX_USERNAME_LENGTH)} letters, digits, dots, dashes or underscores, starting with a letter or digit.`,
        400,
      );
export const usernameTaken = (): WirebenchError =>
  problem('identity-username-taken', 'Someone on this server already has this username.', 409);
export const aboutInvalid = (): WirebenchError =>
  problem('identity-about-invalid', `Keep it to ${String(MAX_ABOUT_LENGTH)} characters.`, 400);
/** Spec §9: anything the server cannot vouch for as a plain WebP of the right size. */
export const imageInvalid = (message: string): WirebenchError => problem('identity-image-invalid', message, 400);
export const imageTooLarge = (kind: ImageKind): WirebenchError =>
  problem(
    'identity-image-too-large',
    `A ${kind} may be at most ${String(IMAGE_LIMITS[kind].maxBytes / 1024)} KB.`,
    413,
  );
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
