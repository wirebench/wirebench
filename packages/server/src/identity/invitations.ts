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
import { announce, recordAudit, runInvitationAccepted, type AuditSource } from '../context.js';
import { isUniqueViolation } from '../db/errors.js';
import type { TenantScope } from '../tenancy/scope.js';
import type { TenantQuerier } from '../tenancy/tenant-db.js';
import type { IdentityEnv, InvitationEnv } from './env.js';
import { invitationExists, invitationInvalid, methodDisabled, passwordTooShort, userExists } from './errors.js';
import { hashPassword } from './passwords.js';
import * as repo from './repo.js';
import { emailLower, signIn } from './sessions.js';
import { hashSecret, mintSecret, newId } from './tokens.js';

/** The link an invitee opens: on the tenant's URL, which the caller passes (spec §19.5). */
export const inviteUrl = (serverUrl: string, secret: string): string => `${serverUrl}/invite/${secret}`;

export interface CreateInvitationInput {
  readonly email: string;
  readonly serverAdmin: boolean;
  /** The admin's user id, or `null` from the console. */
  readonly createdBy: string | null;
  readonly source: AuditSource;
  /** The tenant's URL the link is on: `tenantUrl` of the request, or the admin command line's. */
  readonly serverUrl: string;
}

/**
 * `attach` runs in the insert's transaction with the new invitation's id: teams-access writes its
 * `team_invitations` row through it (teams spec §3.4), so a team invitation never exists without
 * its team. Every function here works in `scope`, the request's tenant or the admin command line's.
 */
export async function createInvitation(
  env: InvitationEnv,
  scope: TenantScope,
  input: CreateInvitationInput,
  attach?: (tx: TenantQuerier, invitationId: string) => Promise<void>,
): Promise<InvitationCreated> {
  const lower = emailLower(input.email);
  const now = env.now();
  const db = env.ctx.tenancy.db(scope);
  if ((await repo.findUserByEmail(db, lower)) !== undefined) throw userExists();
  if ((await repo.openInvitationByEmail(db, lower, now)) !== undefined) throw invitationExists();
  const { secret, hash } = mintSecret();
  let row: repo.InvitationRow;
  try {
    row = await db.transaction(async (tx) => {
      // licensing §3.4: refused here, so the admin learns before the invitee does. Every caller shares
      // this function: POST /invitations, a team invitation, and `admin invite`.
      await env.ctx.license.assertSeatAvailable(tx);
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
      await recordAudit(env.ctx.hooks, tx, {
        ...input.source,
        action: 'user.invited',
        target: { kind: 'invitation', id: inserted.id },
        details: { emailLower: lower, serverAdmin: input.serverAdmin },
      });
      return inserted;
    });
  } catch (error) {
    // Two creates for one email raced past the pre-check: the index decides, the loser hears 409.
    if (isUniqueViolation(error, 'invitations_one_open_per_email')) throw invitationExists();
    throw error;
  }
  return { id: row.id, email: row.email, url: inviteUrl(input.serverUrl, secret), expiresAt: row.expiresAt };
}

/** A `reset` row for an existing user; any earlier open reset for them is closed first. */
export async function createPasswordReset(
  env: InvitationEnv,
  scope: TenantScope,
  user: repo.UserRow,
  createdBy: string,
  source: AuditSource,
  serverUrl: string,
): Promise<PasswordResetCreated> {
  const now = env.now();
  const { secret, hash } = mintSecret();
  const row = await env.ctx.tenancy.db(scope).transaction(async (tx) => {
    await repo.revokeOpenResetsOf(tx, user.id, now);
    const inserted = await repo.insertInvitation(tx, {
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
    await recordAudit(env.ctx.hooks, tx, {
      ...source,
      action: 'user.password_reset_issued',
      target: { kind: 'user', id: user.id },
      details: { invitationId: inserted.id },
    });
    return inserted;
  });
  return { url: inviteUrl(serverUrl, secret), expiresAt: row.expiresAt };
}

export function isOpen(row: repo.InvitationRow, now: Date): boolean {
  return row.acceptedAt === null && row.revokedAt === null && Date.parse(row.expiresAt) > now.getTime();
}

/** The row behind a secret while it is still usable; `undefined` for unknown, used, revoked or expired. */
export async function openInvitationBySecret(
  env: InvitationEnv,
  scope: TenantScope,
  secret: string,
): Promise<repo.InvitationRow | undefined> {
  const row = await repo.invitationBySecretHash(env.ctx.tenancy.db(scope), hashSecret(secret));
  return row !== undefined && isOpen(row, env.now()) ? row : undefined;
}

export async function lookupInvitation(
  env: InvitationEnv,
  scope: TenantScope,
  secret: string,
): Promise<InvitationLookupResponse> {
  const row = await openInvitationBySecret(env, scope, secret);
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
export async function acceptInvitation(
  env: IdentityEnv,
  scope: TenantScope,
  input: InvitationAcceptRequest,
  source: AuditSource,
): Promise<SignInResponse> {
  if (!env.settings.local) throw methodDisabled();
  if (input.password.length < MIN_PASSWORD_LENGTH) throw passwordTooShort();
  const invitation = await openInvitationBySecret(env, scope, input.secret);
  if (invitation === undefined) throw invitationInvalid();
  const hash = await hashPassword(input.password);
  const now = env.now();
  const user = await env.ctx.tenancy.db(scope).transaction(async (tx) => {
    if (!(await repo.acceptInvitation(tx, invitation.id, now))) throw invitationInvalid();
    if (invitation.kind === 'reset') {
      const existing = invitation.userId === null ? undefined : await repo.findUserById(tx, invitation.userId);
      if (existing === undefined || existing.disabledAt !== null) throw invitationInvalid();
      await repo.upsertCredential(tx, existing.id, hash, now);
      await repo.revokeTokensOfUser(tx, existing.id, now);
      await recordAudit(env.ctx.hooks, tx, {
        ...source,
        actor: { kind: 'user', userId: existing.id, email: existing.email },
        action: 'auth.password_changed',
        target: { kind: 'user', id: existing.id },
        details: { via: 'reset' },
      });
      return existing;
    }
    if ((await repo.findUserByEmail(tx, invitation.emailLower)) !== undefined) throw userExists();
    // licensing §3.4: after the claim, so a refusal rolls the claim back and the invitation stays open.
    // A reset (the branch above) never counts: it changes nothing about who is enabled.
    await env.ctx.license.assertSeatAvailable(tx);
    const displayName = input.displayName.trim() || (invitation.email.split('@')[0] ?? invitation.email);
    const created = await repo.insertUser(tx, {
      id: newId(),
      email: invitation.email,
      displayName,
      serverAdmin: invitation.serverAdmin,
      at: now,
    });
    await repo.upsertCredential(tx, created.id, hash, now);
    await recordAudit(env.ctx.hooks, tx, {
      ...source,
      actor: { kind: 'user', userId: created.id, email: created.email },
      action: 'user.created',
      target: { kind: 'user', id: created.id },
      details: { method: 'local', invitationId: invitation.id, emailLower: invitation.emailLower },
    });
    // Later modules add to the new account here, in this transaction (teams spec §3.4): a
    // failure rolls the accept back and the invitation stays open.
    await runInvitationAccepted(env.ctx.hooks, tx, { invitationId: invitation.id, userId: created.id });
    return created;
  });
  // A reset revoked every device of the user above. There is no request here, and the CLI never
  // accepts (it builds only an InvitationEnv), so the server's own logger is the one at hand.
  if (invitation.kind === 'reset')
    announce(env.ctx.hooks.sessionEnded, { tenantId: scope.tenantId, userId: user.id }, env.ctx.log);
  return signIn(env, scope, user, 'local', input.device.name, source);
}

/** Revokes an open `invite`; `false` when there is no such open invitation. */
export async function revokeOpenInvitation(
  env: InvitationEnv,
  scope: TenantScope,
  id: string,
  source: AuditSource,
): Promise<boolean> {
  const db = env.ctx.tenancy.db(scope);
  const row = await repo.invitationById(db, id);
  if (row === undefined || row.kind !== 'invite' || !isOpen(row, env.now())) return false;
  await db.transaction(async (tx) => {
    await repo.revokeInvitation(tx, id, env.now());
    await recordAudit(env.ctx.hooks, tx, {
      ...source,
      action: 'user.invitation_revoked',
      target: { kind: 'invitation', id },
      details: { emailLower: row.emailLower },
    });
  });
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
