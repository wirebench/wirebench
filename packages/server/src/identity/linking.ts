/**
 * The linking rules of identity spec §3.3, as a pure decision over facts the repository looked
 * up, then the writes each decision needs. Rule order is the whole point: a known identity wins
 * before `email_verified` is even consulted, and an unverified email can never link or create.
 */
import { runInvitationAccepted } from '../context.js';
import type { IdentityEnv } from './env.js';
import type { OidcClaims } from './oidc.js';
import * as repo from './repo.js';
import { emailLower } from './sessions.js';
import { newId } from './tokens.js';

export type LinkRefusal = 'identity-user-disabled' | 'identity-email-unverified' | 'identity-not-invited';

export interface LinkFacts {
  readonly identity?: { readonly userId: string; readonly disabled: boolean };
  readonly emailVerified: boolean;
  readonly user?: { readonly id: string; readonly disabled: boolean };
  readonly invitation?: { readonly id: string; readonly serverAdmin: boolean };
}

export type LinkDecision =
  | { readonly kind: 'existing'; readonly userId: string }
  | { readonly kind: 'link'; readonly userId: string }
  | { readonly kind: 'create'; readonly invitationId: string; readonly serverAdmin: boolean }
  | { readonly kind: 'refuse'; readonly code: LinkRefusal };

export function decideLink(facts: LinkFacts): LinkDecision {
  if (facts.identity !== undefined) {
    return facts.identity.disabled
      ? { kind: 'refuse', code: 'identity-user-disabled' }
      : { kind: 'existing', userId: facts.identity.userId };
  }
  if (!facts.emailVerified) return { kind: 'refuse', code: 'identity-email-unverified' };
  if (facts.user !== undefined) {
    return facts.user.disabled
      ? { kind: 'refuse', code: 'identity-user-disabled' }
      : { kind: 'link', userId: facts.user.id };
  }
  if (facts.invitation !== undefined)
    return { kind: 'create', invitationId: facts.invitation.id, serverAdmin: facts.invitation.serverAdmin };
  return { kind: 'refuse', code: 'identity-not-invited' };
}

export type LinkOutcome =
  { readonly ok: true; readonly user: repo.UserRow } | { readonly ok: false; readonly code: LinkRefusal };

/** Looks up the facts for `claims`, decides, and writes what the decision needs. */
export async function linkClaims(env: IdentityEnv, claims: OidcClaims): Promise<LinkOutcome> {
  const db = env.ctx.db;
  const now = env.now();
  const identity = await repo.oidcIdentityOf(db, claims.issuer, claims.subject);
  const identityUser = identity === undefined ? undefined : await repo.findUserById(db, identity.userId);
  const lower = claims.email === undefined || claims.email.trim() === '' ? undefined : emailLower(claims.email);
  const byEmail = identity === undefined && lower !== undefined ? await repo.findUserByEmail(db, lower) : undefined;
  const invitation =
    identity === undefined && byEmail === undefined && lower !== undefined
      ? await repo.openInvitationByEmail(db, lower, now)
      : undefined;

  const decision = decideLink({
    ...(identityUser !== undefined
      ? { identity: { userId: identityUser.id, disabled: identityUser.disabledAt !== null } }
      : {}),
    emailVerified: claims.emailVerified === true && lower !== undefined,
    ...(byEmail !== undefined ? { user: { id: byEmail.id, disabled: byEmail.disabledAt !== null } } : {}),
    ...(invitation !== undefined ? { invitation: { id: invitation.id, serverAdmin: invitation.serverAdmin } } : {}),
  });

  switch (decision.kind) {
    case 'refuse':
      return { ok: false, code: decision.code };
    case 'existing':
      return { ok: true, user: identityUser! };
    case 'link':
      await repo.insertOidcIdentity(db, {
        issuer: claims.issuer,
        subject: claims.subject,
        userId: decision.userId,
        at: now,
      });
      return { ok: true, user: byEmail! };
    case 'create': {
      const email = claims.email!;
      const displayName = claims.name?.trim() || (email.split('@')[0] ?? email);
      // Claim the invitation first, as the local accept does: two concurrent first sign-ins race
      // on that single conditional UPDATE, and the loser creates nothing.
      const user = await db.transaction(async (tx) => {
        if (!(await repo.acceptInvitation(tx, decision.invitationId, now))) return undefined;
        const created = await repo.insertUser(tx, {
          id: newId(),
          email,
          displayName,
          serverAdmin: decision.serverAdmin,
          at: now,
        });
        await repo.insertOidcIdentity(tx, {
          issuer: claims.issuer,
          subject: claims.subject,
          userId: created.id,
          at: now,
        });
        await runInvitationAccepted(env.ctx.hooks, tx, { invitationId: decision.invitationId, userId: created.id });
        return created;
      });
      if (user === undefined) return { ok: false, code: 'identity-not-invited' };
      return { ok: true, user };
    }
  }
}
