import {
  localSignInRequestSchema,
  signInResponseSchema,
  type LocalSignInRequest,
  type WirebenchError,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { ANONYMOUS_SOURCE, announce, auditSource, recordAudit, type AuditSource } from '../../context.js';
import { jsonSchema } from '../../schema.js';
import { clearSessionCookie } from '../cookies.js';
import type { IdentityEnv } from '../env.js';
import { invalidCredentials, methodDisabled, userDisabled } from '../errors.js';
import { requireUser } from '../guard.js';
import { hashPassword, verifyPassword } from '../passwords.js';
import { emailKey, ipKey, rateLimit } from '../rate-limit.js';
import * as repo from '../repo.js';
import { emailLower, signIn } from '../sessions.js';

/**
 * Verified instead of a credential when the email is unknown, so an unknown email costs the
 * same scrypt as a wrong password and the two are indistinguishable by timing as well as by
 * message (§6). Computed once, lazily.
 */
let decoy: Promise<string> | undefined;
const decoyHash = (): Promise<string> => (decoy ??= hashPassword('wirebench-decoy-never-matches'));

export type LocalCheck =
  { readonly ok: true; readonly user: repo.UserRow } | { readonly ok: false; readonly error: WirebenchError };

/**
 * The email and password check both local sign-ins share, the desktop's JSON route and the browser's
 * form: the decoy for an unknown email, one refusal for an unknown email and a wrong password, the
 * `auth.sign_in_failed` event, and the rehash of an outdated hash. The callers charge the rate limits.
 */
export async function checkLocalCredentials(
  env: IdentityEnv,
  source: AuditSource,
  email: string,
  password: string,
): Promise<LocalCheck> {
  const user = await repo.findUserByEmail(env.ctx.db, emailLower(email));
  const credential = user === undefined ? undefined : await repo.credentialOf(env.ctx.db, user.id);
  const verdict = await verifyPassword(password, credential?.passwordHash ?? (await decoyHash()));
  const failed = (reason: string) =>
    recordAudit(env.ctx.hooks, env.ctx.db, {
      ...source,
      ...ANONYMOUS_SOURCE,
      action: 'auth.sign_in_failed',
      target: { kind: 'server' },
      details: { method: 'local', reason, emailLower: emailLower(email) },
    });
  if (user === undefined || credential === undefined || !verdict.ok) {
    await failed('identity-invalid-credentials');
    return { ok: false, error: invalidCredentials() };
  }
  if (user.disabledAt !== null) {
    await failed('identity-user-disabled');
    return { ok: false, error: userDisabled() };
  }
  if (verdict.rehash) await repo.upsertCredential(env.ctx.db, user.id, await hashPassword(password), env.now());
  return { ok: true, user };
}

export const authLocalRoutes =
  (env: IdentityEnv) =>
  (app: FastifyInstance): void => {
    app.post(
      '/auth/local/sign-in',
      {
        preHandler: [rateLimit(env, (request) => [ipKey(request), emailKey(request)])],
        schema: {
          body: jsonSchema(localSignInRequestSchema, { io: 'input' }),
          response: { 201: jsonSchema(signInResponseSchema) },
        },
      },
      async (request, reply) => {
        if (!env.settings.local) throw methodDisabled();
        const body = request.body as LocalSignInRequest;
        const source = auditSource(request);
        const checked = await checkLocalCredentials(env, source, body.email, body.password);
        if (!checked.ok) throw checked.error;
        return reply.code(201).send(await signIn(env, checked.user, 'local', body.device.name, source));
      },
    );

    app.post('/auth/sign-out', { preHandler: requireUser }, async (request, reply) => {
      await env.ctx.db.transaction(async (tx) => {
        await repo.revokeToken(tx, request.caller!.tokenId, env.now());
        await recordAudit(env.ctx.hooks, tx, {
          ...auditSource(request),
          action: 'auth.signed_out',
          target: { kind: 'user', id: request.caller!.id },
          details: { tokenId: request.caller!.tokenId },
        });
      });
      announce(env.ctx.hooks.sessionEnded, { tokenId: request.caller!.tokenId }, request.log);
      // A browser session also loses its cookie (hosted spec §17.2); a desktop's reply carries none.
      if (request.caller!.via === 'cookie') clearSessionCookie(reply, env.ctx.config.publicUrl);
      return reply.code(204).send();
    });
  };
