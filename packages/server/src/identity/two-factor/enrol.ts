/**
 * What every change to a person's two-step sign-in shares (spec §5, §7): who is changing it (a signed-in person, or a
 * setup challenge on the setup routes only), the password asked first, the recovery codes the first method brings,
 * and turning two-step sign-in off when the last method goes. The authenticator routes (`me-two-factor.ts`) and the
 * passkey routes use these.
 */
import type { FastifyRequest } from 'fastify';
import { recordAudit, type AuditSource } from '../../context.js';
import type { TenantScope } from '../../tenancy/scope.js';
import type { TenantQuerier } from '../../tenancy/tenant-db.js';
import type { IdentityEnv } from '../env.js';
import { invalidCredentials, methodDisabled, twoFactorRequired, unauthenticated } from '../errors.js';
import { verifyPassword } from '../passwords.js';
import * as repo from '../repo.js';
import { charge, personKey, presentedChallenge } from './gate.js';
import { twoFactorKey } from './keys.js';
import { newRecoveryCodes, normaliseRecoveryCode, recoveryCodeHash } from './recovery.js';
import * as twoFactorRepo from './repo.js';
import { twoFactorRequired as requiredOn } from './required.js';

type EnrolEnv = Pick<IdentityEnv, 'ctx' | 'now' | 'settings' | 'twoFactor'>;

/** A signed-in person, or the setup challenge of a person the server requires to set up a method (spec §4.3). */
export type Subject =
  | { readonly kind: 'caller'; readonly userId: string; readonly tokenId: string }
  | { readonly kind: 'setup'; readonly userId: string; readonly challenge: twoFactorRepo.ChallengeRow };

const SETUP_HEADER = /^TwoFactor\s+([A-Za-z0-9_-]{43})$/;

/**
 * Who a change is for. `setup` lets a setup challenge in, through `Authorization: TwoFactor <secret>`, for the setup
 * routes only; it is charged on the second step's buckets as a sign-in challenge is. Anything else needs a session.
 */
export async function subjectOf(env: EnrolEnv, request: FastifyRequest, setup = false): Promise<Subject> {
  if (request.caller !== undefined)
    return { kind: 'caller', userId: request.caller.id, tokenId: request.caller.tokenId };
  const secret = setup ? SETUP_HEADER.exec(request.headers.authorization?.trim() ?? '')?.[1] : undefined;
  if (secret === undefined) throw unauthenticated();
  const challenge = await presentedChallenge(env, request, secret, { purpose: 'setup' });
  return { kind: 'setup', userId: challenge.userId, challenge };
}

/**
 * The person's password credential (plan ruling 6): two-step sign-in guards password sign-in, so it needs local
 * passwords on and a password on the account; otherwise `identity-method-disabled`.
 */
export async function credentialFor(env: EnrolEnv, db: TenantQuerier, userId: string): Promise<repo.CredentialRow> {
  if (!env.settings.local) throw methodDisabled();
  const credential = await repo.credentialOf(db, userId);
  if (credential === undefined) throw methodDisabled();
  return credential;
}

/**
 * The current password a change asks for first (spec §5), on the second step's per-person bucket so a stolen session
 * cannot try passwords quickly. A setup challenge followed a password check moments ago and needs none.
 */
export async function reauthenticate(
  env: EnrolEnv,
  scope: TenantScope,
  subject: Subject,
  credential: repo.CredentialRow,
  password: string | undefined,
): Promise<void> {
  if (subject.kind === 'setup') return;
  await charge(env, scope, personKey(scope, subject.userId));
  const verdict = password === undefined ? undefined : await verifyPassword(password, credential.passwordHash);
  if (verdict?.ok !== true) throw invalidCredentials();
}

/** The audit event of a change by `subject` to its own two-step sign-in. */
export function selfEvent(source: AuditSource, subject: Subject) {
  return { ...source, target: { kind: 'user' as const, id: subject.userId } };
}

/** Ten new recovery codes for `userId`, replacing any older set; answered once and kept only as keyed hashes. */
export async function issueRecoveryCodes(
  env: Pick<IdentityEnv, 'ctx' | 'now'>,
  scope: TenantScope,
  tx: TenantQuerier,
  userId: string,
): Promise<string[]> {
  const codes = newRecoveryCodes();
  const key = twoFactorKey(await env.ctx.tenancy.dataKey(scope), userId, 'recovery');
  await twoFactorRepo.replaceRecoveryCodes(
    tx,
    userId,
    codes.map((code) => recoveryCodeHash(key, normaliseRecoveryCode(code)!)),
    env.now(),
  );
  return codes;
}

/**
 * After a method was added in `tx`: when it is the person's first, two-step sign-in turns on and brings its recovery
 * codes (spec §5.3), which are answered; otherwise none.
 */
export async function methodAdded(
  env: Pick<IdentityEnv, 'ctx' | 'now'>,
  scope: TenantScope,
  tx: TenantQuerier,
  event: ReturnType<typeof selfEvent>,
  method: 'totp' | 'passkey',
  wasOn: boolean,
  passkeyId?: string,
): Promise<string[] | undefined> {
  await recordAudit(env.ctx.hooks, tx, {
    ...event,
    action: 'user.two_factor_method_added',
    details: { method, ...(passkeyId !== undefined ? { passkeyId } : {}) },
  });
  if (wasOn) return undefined;
  const codes = await issueRecoveryCodes(env, scope, tx, event.target.id);
  await recordAudit(env.ctx.hooks, tx, { ...event, action: 'user.two_factor_enabled', details: { method } });
  return codes;
}

/**
 * After a method was removed in `tx`: when none is left, two-step sign-in turns off and its recovery codes go
 * (spec §5), unless the server requires it, which refuses the removal (`identity-two-factor-required`, rolling it
 * back with the unit).
 */
export async function methodRemoved(
  env: Pick<IdentityEnv, 'ctx'>,
  scope: TenantScope,
  tx: TenantQuerier,
  event: ReturnType<typeof selfEvent>,
  method: 'totp' | 'passkey',
  passkeyId?: string,
): Promise<void> {
  const userId = event.target.id;
  await recordAudit(env.ctx.hooks, tx, {
    ...event,
    action: 'user.two_factor_method_removed',
    details: { method, ...(passkeyId !== undefined ? { passkeyId } : {}) },
  });
  if (twoFactorRepo.hasSecondFactor(await twoFactorRepo.methodsOf(tx, userId))) return;
  if (await requiredOn(env.ctx, scope)) throw twoFactorRequired();
  await twoFactorRepo.deleteRecoveryCodes(tx, userId);
  await recordAudit(env.ctx.hooks, tx, { ...event, action: 'user.two_factor_disabled', details: { method } });
}
