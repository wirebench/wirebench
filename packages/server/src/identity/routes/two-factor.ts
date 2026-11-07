/**
 * The desktop's second step (two-step sign-in spec §3.1, §7): `POST /auth/two-factor/verify` takes the challenge a
 * correct password answered, and an authenticator or recovery code, for the session. Its limits are the second
 * step's own (§3.3), charged in `presentedChallenge`, not the password step's.
 */
import {
  passkeyChallengeRequestSchema,
  passkeyVerifyRequestSchema,
  signInResponseSchema,
  twoFactorVerifyRequestSchema,
  webauthnJsonSchema,
  type PasskeyChallengeRequest,
  type PasskeyVerifyRequest,
  type TwoFactorVerifyRequest,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { auditSource } from '../../context.js';
import { jsonSchema } from '../../schema.js';
import type { IdentityEnv } from '../env.js';
import { methodDisabled } from '../errors.js';
import { presentedChallenge, verifyCode } from '../two-factor/gate.js';
import { signInOptions, signInWithPasskey } from '../two-factor/passkeys.js';

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

    // A passkey as the second step (spec §3.5), for a client that runs WebAuthn itself; the browser's page and the
    // desktop's hand-off reach the same ceremony through their own routes.
    app.post(
      '/auth/two-factor/passkey/options',
      {
        schema: {
          body: jsonSchema(passkeyChallengeRequestSchema, { io: 'input' }),
          response: { 200: jsonSchema(webauthnJsonSchema) },
        },
      },
      async (request) => {
        if (!env.settings.local) throw methodDisabled();
        const body = request.body as PasskeyChallengeRequest;
        const row = await presentedChallenge(env, request, body.challenge, { purpose: 'sign-in', kind: 'device' });
        return signInOptions(env, request.tenant, request, row);
      },
    );

    app.post(
      '/auth/two-factor/passkey/verify',
      {
        schema: {
          body: jsonSchema(passkeyVerifyRequestSchema, { io: 'input' }),
          response: { 201: jsonSchema(signInResponseSchema) },
        },
      },
      async (request, reply) => {
        if (!env.settings.local) throw methodDisabled();
        const body = request.body as PasskeyVerifyRequest;
        const row = await presentedChallenge(env, request, body.challenge, { purpose: 'sign-in', kind: 'device' });
        const signed = await signInWithPasskey(env, request.tenant, request, auditSource(request), row, body.response);
        return reply.code(201).send(signed);
      },
    );
  };
