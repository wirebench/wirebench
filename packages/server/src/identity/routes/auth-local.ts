import { localSignInRequestSchema, signInResponseSchema, type LocalSignInRequest } from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { jsonSchema } from '../../schema.js';
import type { IdentityEnv } from '../env.js';
import { invalidCredentials, methodDisabled, userDisabled } from '../errors.js';
import { requireUser } from '../guard.js';
import { hashPassword, verifyPassword } from '../passwords.js';
import { emailKey, ipKey, rateLimit } from '../rate-limit.js';
import * as repo from '../repo.js';
import { emailLower, issueToken } from '../sessions.js';

/**
 * Verified instead of a credential when the email is unknown, so an unknown email costs the
 * same scrypt as a wrong password and the two are indistinguishable by timing as well as by
 * message (§6). Computed once, lazily.
 */
let decoy: Promise<string> | undefined;
const decoyHash = (): Promise<string> => (decoy ??= hashPassword('wirebench-decoy-never-matches'));

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
        const user = await repo.findUserByEmail(env.ctx.db, emailLower(body.email));
        const credential = user === undefined ? undefined : await repo.credentialOf(env.ctx.db, user.id);
        const verdict = await verifyPassword(body.password, credential?.passwordHash ?? (await decoyHash()));
        if (user === undefined || credential === undefined || !verdict.ok) throw invalidCredentials();
        if (user.disabledAt !== null) throw userDisabled();
        if (verdict.rehash)
          await repo.upsertCredential(env.ctx.db, user.id, await hashPassword(body.password), env.now());
        return reply.code(201).send(await issueToken(env, user, body.device.name));
      },
    );

    app.post('/auth/sign-out', { preHandler: requireUser }, async (request, reply) => {
      await repo.revokeToken(env.ctx.db, request.caller!.tokenId, env.now());
      return reply.code(204).send();
    });
  };
