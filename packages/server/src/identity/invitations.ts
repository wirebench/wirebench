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
import { runInvitationAccepted, type Querier } from '../context.js';
import { isUniqueViolation } from '../db/errors.js';
import type { IdentityEnv, InvitationEnv } from './env.js';
import { invitationExists, invitationInvalid, methodDisabled, passwordTooShort, userExists } from './errors.js';
import { hashPassword } from './passwords.js';
import * as repo from './repo.js';
import { emailLower, issueToken } from './sessions.js';
import { hashSecret, mintSecret, newId } from './tokens.js';

export const inviteUrl = (env: InvitationEnv, secret: string): string => `${env.ctx.config.publicUrl}/invite/${secret}`;

export interface CreateInvitationInput {
  readonly email: string;
  readonly serverAdmin: boolean;
  /** The admin's user id, or `null` from the console. */
  readonly createdBy: string | null;
}

/**
 * `attach` runs in the insert's transaction with the new invitation's id: teams-access writes its
 * `team_invitations` row through it (teams spec §3.4), so a team invitation never exists without
 * its team.
 */
export async function createInvitation(
  env: InvitationEnv,
  input: CreateInvitationInput,
  attach?: (tx: Querier, invitationId: string) => Promise<void>,
): Promise<InvitationCreated> {
  const lower = emailLower(input.email);
  const now = env.now();
  if ((await repo.findUserByEmail(env.ctx.db, lower)) !== undefined) throw userExists();
  if ((await repo.openInvitationByEmail(env.ctx.db, lower, now)) !== undefined) throw invitationExists();
  const { secret, hash } = mintSecret();
  let row: repo.InvitationRow;
  try {
    row = await env.ctx.db.transaction(async (tx) => {
      await repo.revokeExpiredInvitesOf(tx, lower, now);
      const inserted = await repo.insertInvitation(tx, {
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
      if (attach !== undefined) await attach(tx, inserted.id);
      return inserted;
    });
  } catch (error) {
    // Two creates for one email raced past the pre-check: the index decides, the loser hears 409.
    if (isUniqueViolation(error, 'invitations_one_open_per_email')) throw invitationExists();
    throw error;
  }
  return { id: row.id, email: row.email, url: inviteUrl(env, secret), expiresAt: row.expiresAt };
}

/** A `reset` row for an existing user; any earlier open reset for them is closed first. */
export async function createPasswordReset(
  env: InvitationEnv,
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
  env: InvitationEnv,
  secret: string,
): Promise<repo.InvitationRow | undefined> {
  const row = await repo.invitationBySecretHash(env.ctx.db, hashSecret(secret));
  return row !== undefined && isOpen(row, env.now()) ? row : undefined;
}

export async function lookupInvitation(env: InvitationEnv, secret: string): Promise<InvitationLookupResponse> {
  const row = await openInvitationBySecret(env, secret);
  if (row === undefined) throw invitationInvalid();
  return { email: row.email, methods: { local: env.settings.local, oidc: env.settings.oidc !== undefined } };
}

/**
 * The local path in (§3.1): an `invite` creates the user and credential; a `reset` replaces the
 * credential of its user and revokes every device. The row is claimed — `repo.acceptInvitation`'s
 * conditional `UPDATE ... WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now` —
 * first inside the transaction, before either branch touches a user or credential: two concurrent
 * accepts of the same secret race on that single `UPDATE`, so at most one can claim it, and the
 * loser throws `invitationInvalid()` and rolls back before it can create a duplicate user or a
 * second token.
 */
export async function acceptInvitation(env: IdentityEnv, input: InvitationAcceptRequest): Promise<SignInResponse> {
  if (!env.settings.local) throw methodDisabled();
  if (input.password.length < MIN_PASSWORD_LENGTH) throw passwordTooShort();
  const invitation = await openInvitationBySecret(env, input.secret);
  if (invitation === undefined) throw invitationInvalid();
  const hash = await hashPassword(input.password);
  const now = env.now();
  const user = await env.ctx.db.transaction(async (tx) => {
    if (!(await repo.acceptInvitation(tx, invitation.id, now))) throw invitationInvalid();
    if (invitation.kind === 'reset') {
      const existing = invitation.userId === null ? undefined : await repo.findUserById(tx, invitation.userId);
      if (existing === undefined || existing.disabledAt !== null) throw invitationInvalid();
      await repo.upsertCredential(tx, existing.id, hash, now);
      await repo.revokeTokensOfUser(tx, existing.id, now);
      return existing;
    }
    if ((await repo.findUserByEmail(tx, invitation.emailLower)) !== undefined) throw userExists();
    const displayName = input.displayName.trim() || (invitation.email.split('@')[0] ?? invitation.email);
    const created = await repo.insertUser(tx, {
      id: newId(),
      email: invitation.email,
      displayName,
      serverAdmin: invitation.serverAdmin,
      at: now,
    });
    await repo.upsertCredential(tx, created.id, hash, now);
    // Later modules add to the new account here, in this transaction (teams spec §3.4): a
    // failure rolls the accept back and the invitation stays open.
    await runInvitationAccepted(env.ctx.hooks, tx, { invitationId: invitation.id, userId: created.id });
    return created;
  });
  return issueToken(env, user, input.device.name);
}

/** Revokes an open `invite`; `false` when there is no such open invitation. */
export async function revokeOpenInvitation(env: InvitationEnv, id: string): Promise<boolean> {
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
