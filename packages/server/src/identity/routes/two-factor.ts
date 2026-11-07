/**
 * The desktop's second step (two-step sign-in spec §3.1, §7): `POST /auth/two-factor/verify` takes the challenge a
 * correct password answered, and an authenticator or recovery code, for the session. Its limits are the second
 * step's own (§3.3), charged in `presentedChallenge`, not the password step's.
 */
import { signInResponseSchema, twoFactorVerifyRequestSchema, type TwoFactorVerifyRequest } from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { auditSource } from '../../context.js';
import { jsonSchema } from '../../schema.js';
import type { IdentityEnv } from '../env.js';
import { methodDisabled } from '../errors.js';
import { presentedChallenge, verifyCode } from '../two-factor/gate.js';

export const twoFactorRoutes =
  (env: IdentityEnv) =>
  (app: FastifyInstance): void => {
    app.post(
      '/auth/two-factor/verify',
      {
        schema: {
          body: jsonSchema(twoFactorVerifyRequestSchema, { io: 'input' }),
          response: { 201: jsonSchema(signInResponseSchema) },
        },
      },
      async (request, reply) => {
        if (!env.settings.local) throw methodDisabled();
        const body = request.body as TwoFactorVerifyRequest;
        const row = await presentedChallenge(env, request, body.challenge, { purpose: 'sign-in', kind: 'device' });
        const signed = await verifyCode(env, request.tenant, auditSource(request), row, body.method, body.code);
        return reply.code(201).send(signed);
      },
    );
  };
