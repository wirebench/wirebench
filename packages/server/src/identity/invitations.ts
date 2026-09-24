/**
 * Invitations and password resets (identity spec §2, §3.1, §3.7): one table, two kinds. The
 * secret is minted here, returned to the caller once inside the URL, and stored only hashed.
 * `createInvitation` is what both `POST /invitations` and `admin invite` run.
 */
import {
  MIN_PASSWORD_LENGTH,
  type InvitationAcceptRequest,
  type InvitationCreated,
  type InvitationLookupResponse,
  type InvitationSummary,
  type PasswordResetCreated,
  type SignInResponse,
} from '@wirebench/engine';
import type { IdentityEnv } from './env.js';
import { invitationExists, invitationInvalid, methodDisabled, passwordTooShort, userExists } from './errors.js';
import { hashPassword } from './passwords.js';
import * as repo from './repo.js';
import { emailLower, issueToken } from './sessions.js';
import { hashSecret, mintSecret, newId } from './tokens.js';

export const inviteUrl = (env: IdentityEnv, secret: string): string => `${env.ctx.config.publicUrl}/invite/${secret}`;

export interface CreateInvitationInput {
  readonly email: string;
  readonly serverAdmin: boolean;
  /** The admin's user id, or `null` from the console. */
  readonly createdBy: string | null;
}

export async function createInvitation(env: IdentityEnv, input: CreateInvitationInput): Promise<InvitationCreated> {
  const lower = emailLower(input.email);
  const now = env.now();
  if ((await repo.findUserByEmail(env.ctx.db, lower)) !== undefined) throw userExists();
  if ((await repo.openInvitationByEmail(env.ctx.db, lower, now)) !== undefined) throw invitationExists();
  const { secret, hash } = mintSecret();
  const row = await repo.insertInvitation(env.ctx.db, {
    id: newId(),
    kind: 'invite',
    email: input.email.trim(),
    userId: null,
    secretHash: hash,
    serverAdmin: input.serverAdmin,
    createdBy: input.createdBy,
    createdAt: now,
    expiresAt: new Date(now.getTime() + env.settings.invitationMs),
  });
  return { id: row.id, email: row.email, url: inviteUrl(env, secret), expiresAt: row.expiresAt };
}

/** A `reset` row for an existing user; any earlier open reset for them is closed first. */
export async function createPasswordReset(
  env: IdentityEnv,
  user: repo.UserRow,
  createdBy: string,
): Promise<PasswordResetCreated> {
  const now = env.now();
  const { secret, hash } = mintSecret();
  const row = await env.ctx.db.transaction(async (tx) => {
    await repo.revokeOpenResetsOf(tx, user.id, now);
    return repo.insertInvitation(tx, {
      id: newId(),
      kind: 'reset',
      email: user.email,
      userId: user.id,
      secretHash: hash,
      serverAdmin: false,
      createdBy,
      createdAt: now,
      expiresAt: new Date(now.getTime() + env.settings.invitationMs),
    });
  });
  return { url: inviteUrl(env, secret), expiresAt: row.expiresAt };
}

export function isOpen(row: repo.InvitationRow, now: Date): boolean {
  return row.acceptedAt === null && row.revokedAt === null && Date.parse(row.expiresAt) > now.getTime();
}

/** The row behind a secret while it is still usable; `undefined` for unknown, used, revoked or expired. */
export async function openInvitationBySecret(
  env: IdentityEnv,
  secret: string,
): Promise<repo.InvitationRow | undefined> {
  const row = await repo.invitationBySecretHash(env.ctx.db, hashSecret(secret));
  return row !== undefined && isOpen(row, env.now()) ? row : undefined;
}

export async function lookupInvitation(env: IdentityEnv, secret: string): Promise<InvitationLookupResponse> {
  const row = await openInvitationBySecret(env, secret);
  if (row === undefined) throw invitationInvalid();
  return { email: row.email, methods: { local: env.settings.local, oidc: env.settings.oidc !== undefined } };
}

/**
 * The local path in (§3.1): an `invite` creates the user and credential; a `reset` replaces the
 * credential of its user and revokes every device. Both mark the row accepted in the same
 * transaction, so a second use finds it closed.
 */
export async function acceptInvitation(env: IdentityEnv, input: InvitationAcceptRequest): Promise<SignInResponse> {
  if (!env.settings.local) throw methodDisabled();
  if (input.password.length < MIN_PASSWORD_LENGTH) throw passwordTooShort();
  const invitation = await openInvitationBySecret(env, input.secret);
  if (invitation === undefined) throw invitationInvalid();
  const hash = await hashPassword(input.password);
  const now = env.now();
  const outcome = await env.ctx.db.transaction(async (tx) => {
    if (invitation.kind === 'reset') {
      const user = invitation.userId === null ? undefined : await repo.findUserById(tx, invitation.userId);
      if (user === undefined || user.disabledAt !== null) throw invitationInvalid();
      await repo.upsertCredential(tx, user.id, hash, now);
      await repo.revokeTokensOfUser(tx, user.id, now);
      await repo.acceptInvitation(tx, invitation.id, now);
      return { user, created: false };
    }
    if ((await repo.findUserByEmail(tx, invitation.emailLower)) !== undefined) throw userExists();
    const displayName = input.displayName.trim() || (invitation.email.split('@')[0] ?? invitation.email);
    const user = await repo.insertUser(tx, {
      id: newId(),
      email: invitation.email,
      displayName,
      serverAdmin: invitation.serverAdmin,
      at: now,
    });
    await repo.upsertCredential(tx, user.id, hash, now);
    await repo.acceptInvitation(tx, invitation.id, now);
    return { user, created: true };
  });
  if (outcome.created)
    env.ctx.events.emit('invitation.accepted', { invitationId: invitation.id, userId: outcome.user.id });
  return issueToken(env, outcome.user, input.device.name);
}

/** Revokes an open `invite`; `false` when there is no such open invitation. */
export async function revokeOpenInvitation(env: IdentityEnv, id: string): Promise<boolean> {
  const row = await repo.invitationById(env.ctx.db, id);
  if (row === undefined || row.kind !== 'invite' || !isOpen(row, env.now())) return false;
  await repo.revokeInvitation(env.ctx.db, id, env.now());
  return true;
}

export function invitationSummary(row: repo.InvitationRow): InvitationSummary {
  return {
    id: row.id,
    email: row.email,
    serverAdmin: row.serverAdmin,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ...(row.acceptedAt !== null ? { acceptedAt: row.acceptedAt } : {}),
  };
}
