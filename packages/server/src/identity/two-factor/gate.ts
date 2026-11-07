/**
 * The second step of a password sign-in (two-step sign-in spec §3): the challenge a correct password earns, its
 * limits and lockout (§3.3), and the session it is exchanged for. The password check itself (`checkLocalCredentials`)
 * is not touched; this runs after it.
 */
import type { SignInResponse, TwoFactorMethod } from '@wirebench/engine';
import type { FastifyRequest } from 'fastify';
import { recordAudit, type AuditSource } from '../../context.js';
import type { TenantScope } from '../../tenancy/scope.js';
import type { TenantQuerier } from '../../tenancy/tenant-db.js';
import type { IdentityEnv } from '../env.js';
import { rateLimited, twoFactorExpired, twoFactorInvalid, userDisabled } from '../errors.js';
import { ipKey } from '../rate-limit.js';
import * as repo from '../repo.js';
import { issueSession } from '../sessions.js';
import { hashSecret, mintSecret, newId } from '../tokens.js';
import { openTotpSecret, twoFactorKey } from './keys.js';
import { normaliseRecoveryCode, recoveryCodeHash } from './recovery.js';
import * as twoFactorRepo from './repo.js';
import { twoFactorRequired } from './required.js';
import { verifyTotp } from './totp.js';

/** Five minutes to live, five wrong answers (spec §3.2). */
export const CHALLENGE_MS = 5 * 60 * 1000;
export const MAX_ATTEMPTS = 5;

type GateEnv = Pick<IdentityEnv, 'ctx' | 'now' | 'twoFactor'>;

export interface TwoFactorChallenge {
  /** Returned once; the row keeps only its hash. */
  readonly secret: string;
  readonly methods: readonly TwoFactorMethod[];
  /** No method yet, and the server requires one (spec §4.3). */
  readonly setup: boolean;
}

/** The methods a person has, in the order the clients offer them. */
export function methodList(methods: twoFactorRepo.MethodsRow): TwoFactorMethod[] {
  const list: TwoFactorMethod[] = [];
  if (methods.totp?.confirmedAt != null) list.push('totp');
  if (methods.passkeys.length > 0) list.push('passkey');
  if (methods.recoveryCodesLeft > 0) list.push('recovery');
  return list;
}

/**
 * After a correct password: `undefined` when a session may be issued now, or the challenge to answer instead
 * (spec §3.1). `kind` is the token the finished sign-in will issue, so a challenge the browser's form started cannot
 * be finished by the desktop's route, nor the other way round.
 */
export async function twoFactorGate(
  env: Pick<IdentityEnv, 'ctx' | 'now'>,
  scope: TenantScope,
  user: repo.UserRow,
  sign: { readonly deviceName: string; readonly kind: repo.TokenKind },
): Promise<TwoFactorChallenge | undefined> {
  const db = env.ctx.tenancy.db(scope);
  const methods = await twoFactorRepo.methodsOf(db, user.id);
  const on = twoFactorRepo.hasSecondFactor(methods);
  if (!on && !(await twoFactorRequired(env.ctx, scope))) return undefined;
  const { secret, hash } = mintSecret();
  const at = env.now();
  await twoFactorRepo.insertChallenge(db, {
    id: newId(),
    userId: user.id,
    secretHash: hash,
    purpose: on ? 'sign-in' : 'setup',
    deviceName: sign.deviceName,
    tokenKind: sign.kind,
    at,
    expiresAt: new Date(at.getTime() + CHALLENGE_MS),
  });
  return { secret, methods: on ? methodList(methods) : [], setup: !on };
}

/** The per-person key of the second step's buckets (plan ruling 9): the challenge's user, keyed as `callerKey` is. */
export const personKey = (scope: TenantScope, userId: string): string => `${scope.tenantId}:user:${userId}`;

/**
 * The live challenge `secret` names, for a sign-in finished as `kind`, after the second step's limits (spec §3.3):
 * the address's bucket first, so a scan for secrets is held back too, then the person's, then the lockout. Anything
 * else answers `identity-two-factor-expired`, the one thing the person must act on (start again).
 */
export async function presentedChallenge(
  env: GateEnv,
  request: Pick<FastifyRequest, 'tenant' | 'ip' | 'body' | 'caller'>,
  secret: string,
  kind: repo.TokenKind,
): Promise<twoFactorRepo.ChallengeRow> {
  const scope = request.tenant;
  await charge(env, scope, ipKey(request));
  const row = await twoFactorRepo.challengeBySecretHash(env.ctx.tenancy.db(scope), hashSecret(secret), env.now());
  if (row?.purpose !== 'sign-in' || row.tokenKind !== kind) throw twoFactorExpired();
  const person = personKey(scope, row.userId);
  await charge(env, scope, person);
  const lock = await env.twoFactor.failures.peek(scope, person);
  if (!lock.allowed) throw rateLimited(lock.retryAfterSeconds);
  return row;
}

async function charge(env: Pick<IdentityEnv, 'twoFactor'>, scope: TenantScope, key: string): Promise<void> {
  const decision = await env.twoFactor.limiter.take(scope, key);
  if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds);
}

/**
 * A wrong answer (spec §3.2, §3.3): one more attempt on the challenge, which a fifth ends; one more failure on the
 * person's lockout, which records `auth.second_factor_locked` on the failure that empties it; and
 * `auth.second_factor_failed` with the method and reason, never what was typed. Always answers the one
 * `identity-two-factor-invalid`, whatever went wrong, so the answer says nothing the audit log alone keeps.
 */
export async function failedAttempt(
  env: GateEnv,
  scope: TenantScope,
  source: AuditSource,
  row: twoFactorRepo.ChallengeRow,
  method: TwoFactorMethod,
  reason: string,
): Promise<never> {
  const person = personKey(scope, row.userId);
  await env.twoFactor.failures.take(scope, person);
  const locked = !(await env.twoFactor.failures.peek(scope, person)).allowed;
  await env.ctx.tenancy.db(scope).transaction(async (tx) => {
    const attempts = await twoFactorRepo.bumpChallengeAttempts(tx, row.id);
    if (attempts >= MAX_ATTEMPTS) await twoFactorRepo.takeChallenge(tx, row.id);
    const event = {
      ...source,
      actor: { kind: 'anonymous' as const },
      target: { kind: 'user' as const, id: row.userId },
    };
    await recordAudit(env.ctx.hooks, tx, {
      ...event,
      action: 'auth.second_factor_failed',
      details: { method, reason, attempts: Math.min(attempts, MAX_ATTEMPTS) },
    });
    if (locked)
      await recordAudit(env.ctx.hooks, tx, { ...event, action: 'auth.second_factor_locked', details: { method } });
  });
  throw twoFactorInvalid();
}

/** Thrown inside {@link finishChallenge}'s unit to roll back its take when the factor lost a race. */
class LostRace extends Error {}

/**
 * Takes the challenge and issues its session with `auth.signed_in` and `secondFactor`, in one unit with `prove`: the
 * write that makes the factor count (an authenticator's step, a recovery code's use), which answers `false` when the
 * factor lost a race. A taken challenge answers `identity-two-factor-expired`; a factor that lost its race rolls the
 * take back and counts as a wrong answer.
 */
export async function finishChallenge(
  env: GateEnv,
  scope: TenantScope,
  source: AuditSource,
  row: twoFactorRepo.ChallengeRow,
  method: TwoFactorMethod,
  prove: (tx: TenantQuerier) => Promise<boolean>,
): Promise<SignInResponse> {
  let outcome: SignInResponse | 'expired' | 'lost';
  try {
    outcome = await env.ctx.tenancy.db(scope).transaction(async (tx) => {
      if (!(await twoFactorRepo.takeChallenge(tx, row.id))) return 'expired' as const;
      const user = await repo.findUserById(tx, row.userId);
      // Disabled while the challenge waited: the password step's own refusal, now the password was right.
      if (user === undefined || user.disabledAt !== null) throw userDisabled();
      if (!(await prove(tx))) throw new LostRace();
      return issueSession(env, tx, user, {
        method: 'local',
        deviceName: row.deviceName ?? 'device',
        source,
        kind: row.tokenKind ?? 'device',
        secondFactor: method,
      });
    });
  } catch (error) {
    if (!(error instanceof LostRace)) throw error;
    outcome = 'lost';
  }
  if (outcome === 'expired') throw twoFactorExpired();
  if (outcome === 'lost') return failedAttempt(env, scope, source, row, method, 'replay');
  return outcome;
}

/**
 * An authenticator code or a recovery code for `row` (`POST /auth/two-factor/verify`, the browser's code form): the
 * check, then {@link finishChallenge} or {@link failedAttempt}. Codes are compared in constant time (`verifyTotp`) or
 * looked up by keyed hash (recovery), never byte by byte.
 */
export async function verifyCode(
  env: GateEnv,
  scope: TenantScope,
  source: AuditSource,
  row: twoFactorRepo.ChallengeRow,
  method: 'totp' | 'recovery',
  code: string,
): Promise<SignInResponse> {
  const db = env.ctx.tenancy.db(scope);
  const dataKey = await env.ctx.tenancy.dataKey(scope);
  const at = env.now();
  if (method === 'totp') {
    const totp = await twoFactorRepo.totpOf(db, row.userId);
    if (totp?.confirmedAt == null) return failedAttempt(env, scope, source, row, method, 'no-method');
    const secret = openTotpSecret(dataKey, row.userId, totp.sealedSecret);
    const verdict = verifyTotp(secret, code, at.getTime(), totp.lastStep);
    if (!verdict.ok) {
      // A right code at or before the last step used is a replay (spec §3.4), audited as one.
      const reason = verifyTotp(secret, code, at.getTime(), -1).ok ? 'replay' : 'wrong-code';
      return failedAttempt(env, scope, source, row, method, reason);
    }
    return finishChallenge(env, scope, source, row, method, (tx) =>
      twoFactorRepo.setTotpLastStep(tx, row.userId, verdict.step),
    );
  }
  const normalised = normaliseRecoveryCode(code);
  if (normalised === undefined) return failedAttempt(env, scope, source, row, method, 'wrong-code');
  const hash = recoveryCodeHash(twoFactorKey(dataKey, row.userId, 'recovery'), normalised);
  return finishChallenge(env, scope, source, row, method, (tx) =>
    twoFactorRepo.useRecoveryCode(tx, row.userId, hash, at),
  );
}
