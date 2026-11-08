import {
  localSignInRequestSchema,
  signInResponseSchema,
  twoFactorChallengeResponseSchema,
  type LocalSignInRequest,
  type WirebenchError,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import type { TenantScope } from '../../tenancy/scope.js';
import { ANONYMOUS_SOURCE, announce, auditSource, recordAudit, type AuditSource } from '../../context.js';
import { jsonSchema } from '../../schema.js';
import { tenantUrl } from '../../tenancy/urls.js';
import { clearSessionCookie, sessionToken } from '../cookies.js';
import type { IdentityEnv } from '../env.js';
import { identifierInvalid, invalidCredentials, methodDisabled, unauthenticated, userDisabled } from '../errors.js';
import { hashPassword, verifyPassword } from '../passwords.js';
import { identifierKey, ipKey, rateLimit } from '../rate-limit.js';
import * as repo from '../repo.js';
import { emailLower, signIn } from '../sessions.js';
import { twoFactorGate } from '../two-factor/gate.js';

/**
 * Verified instead of a credential when no account matches, so an unknown email or username costs the same scrypt as
 * a wrong password and the three are indistinguishable by timing as well as by message (§6, user profile spec §9).
 * Computed once, lazily, with the same parameters as every real hash.
 */
let decoy: Promise<string> | undefined;
const decoyHash = (): Promise<string> => (decoy ??= hashPassword('wirebench-decoy-never-matches'));

export type LocalCheck =
  { readonly ok: true; readonly user: repo.UserRow } | { readonly ok: false; readonly error: WirebenchError };

/**
 * The sign-in's account, as typed (user profile spec §5): anything with `@` is an email, anything else a username.
 * A username never holds `@`, so the two cannot be mistaken for each other.
 */
export const isEmailIdentifier = (identifier: string): boolean => identifier.includes('@');

/**
 * The identifier and password check both local sign-ins share, the desktop's JSON route and the browser's
 * form: the decoy for an unknown account, one refusal for an unknown email or username and a wrong password, the
 * `auth.sign_in_failed` event, and the rehash of an outdated hash. The callers charge the rate limits.
 */
export async function checkLocalCredentials(
  env: IdentityEnv,
  scope: TenantScope,
  source: AuditSource,
  identifier: string,
  password: string,
): Promise<LocalCheck> {
  const db = env.ctx.tenancy.db(scope);
  const byEmail = isEmailIdentifier(identifier);
  const lower = byEmail ? emailLower(identifier) : identifier.trim().toLowerCase();
  // One unit and the same two statements whether or not the identifier has an account, so the round trips, like the
  // decoy hash below, do not tell the two apart (Task 8 review I1). No user has the empty id.
  const { user, credential } = await db.transaction(async (tx) => {
    const found = byEmail ? await repo.findUserByEmail(tx, lower) : await repo.findUserByUsername(tx, lower);
    return { user: found, credential: await repo.credentialOf(tx, found?.id ?? '') };
  });
  const verdict = await verifyPassword(password, credential?.passwordHash ?? (await decoyHash()));
  const failed = (reason: string) =>
    db.transaction((tx) =>
      recordAudit(env.ctx.hooks, tx, {
        ...source,
        ...ANONYMOUS_SOURCE,
        action: 'auth.sign_in_failed',
        target: { kind: 'server' },
        details: { method: 'local', reason, ...(byEmail ? { emailLower: lower } : { usernameLower: lower }) },
      }),
    );
  if (user === undefined || credential === undefined || !verdict.ok) {
    await failed('identity-invalid-credentials');
    return { ok: false, error: invalidCredentials() };
  }
  if (user.disabledAt !== null) {
    await failed('identity-user-disabled');
    return { ok: false, error: userDisabled() };
  }
  if (verdict.rehash) await repo.upsertCredential(db, user.id, await hashPassword(password), env.now());
  return { ok: true, user };
}

export const authLocalRoutes =
  (env: IdentityEnv) =>
  (app: FastifyInstance): void => {
    app.post(
      '/auth/local/sign-in',
      {
        preHandler: [rateLimit(env, (request) => [ipKey(request), identifierKey(request)])],
        schema: {
          body: jsonSchema(localSignInRequestSchema, { io: 'input' }),
          response: { 200: jsonSchema(twoFactorChallengeResponseSchema), 201: jsonSchema(signInResponseSchema) },
        },
      },
      async (request, reply) => {
        if (!env.settings.local) throw methodDisabled();
        const body = request.body as LocalSignInRequest;
        const source = auditSource(request);
        // Exactly one of the two (ruling 8): `email` is what desktops older than usernames send.
        if ((body.identifier === undefined) === (body.email === undefined)) throw identifierInvalid();
        const identifier = (body.identifier ?? body.email)!;
        const checked = await checkLocalCredentials(env, request.tenant, source, identifier, body.password);
        if (!checked.ok) throw checked.error;
        // Two-step sign-in (spec §3.1): a person with a second factor gets its challenge, and no session yet.
        const challenge = await twoFactorGate(env, request.tenant, checked.user, {
          deviceName: body.device.name,
          kind: 'device',
        });
        if (challenge !== undefined)
          return reply.code(200).send({
            twoFactor: { challenge: challenge.secret, methods: challenge.methods, setup: challenge.setup },
          });
        return reply.code(201).send(await signIn(env, request.tenant, checked.user, 'local', body.device.name, source));
      },
    );

    app.post('/auth/sign-out', async (request, reply) => {
      const url = tenantUrl(env.ctx.config, request);
      if (request.caller === undefined) {
        // A cookie the guard found stale (revoked, expired, unknown) is still dropped, so the browser
        // stops presenting it; the answer stays 401 since no session was ended.
        if (sessionToken(request, url) !== undefined) clearSessionCookie(reply, url);
        throw unauthenticated();
      }
      const caller = request.caller;
      await env.ctx.tenancy.db(request.tenant).transaction(async (tx) => {
        await repo.revokeToken(tx, caller.tokenId, env.now());
        await recordAudit(env.ctx.hooks, tx, {
          ...auditSource(request),
          action: 'auth.signed_out',
          target: { kind: 'user', id: caller.id },
          details: { tokenId: caller.tokenId },
        });
      });
      announce(env.ctx.hooks.sessionEnded, { tenantId: request.tenant.tenantId, tokenId: caller.tokenId }, request.log);
      // A browser session also loses its cookie (hosted spec §17.2); a desktop's reply carries none.
      if (caller.via === 'cookie') clearSessionCookie(reply, url);
      return reply.code(204).send();
    });
  };
