/**
 * The desktop's second step (two-step sign-in spec §3.1, §7): `POST /auth/two-factor/verify` takes the challenge a
 * correct password answered, and an authenticator or recovery code, for the session. Its limits are the second
 * step's own (§3.3), charged in `presentedChallenge`, not the password step's.
 */
import { timingSafeEqual } from 'node:crypto';
import {
  passkeyBrowserStartRequestSchema,
  passkeyBrowserStartResponseSchema,
  passkeyChallengeRequestSchema,
  passkeyCompleteRequestSchema,
  passkeyVerifyRequestSchema,
  signInResponseSchema,
  twoFactorVerifyRequestSchema,
  webauthnJsonSchema,
  type PasskeyBrowserStartRequest,
  type PasskeyChallengeRequest,
  type PasskeyCompleteRequest,
  type PasskeyVerifyRequest,
  type TwoFactorVerifyRequest,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { auditSource } from '../../context.js';
import { jsonSchema } from '../../schema.js';
import { primaryUrl } from '../../tenancy/urls.js';
import type { IdentityEnv } from '../env.js';
import { flowInvalid, methodDisabled, passkeyFailed } from '../errors.js';
import { ipKey } from '../rate-limit.js';
import { hashSecret, newId, pkceChallenge } from '../tokens.js';
import { charge, finishChallenge, presentedChallenge, verifyCode } from '../two-factor/gate.js';
import { signInOptions, signInWithPasskey } from '../two-factor/passkeys.js';
import * as twoFactorRepo from '../two-factor/repo.js';

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

    // The desktop's passkey hand-off (spec §4.2, plan ruling 4): the desktop starts a flow on its challenge with its
    // PKCE challenge and loopback, the browser's flow page runs the passkey and sends a grant to the loopback, and
    // the desktop trades the grant and its verifier here. Only the flow id and the grant pass through the browser.
    app.post(
      '/auth/two-factor/passkey/browser-start',
      {
        schema: {
          body: jsonSchema(passkeyBrowserStartRequestSchema, { io: 'input' }),
          response: { 200: jsonSchema(passkeyBrowserStartResponseSchema) },
        },
      },
      async (request) => {
        if (!env.settings.local) throw methodDisabled();
        const body = request.body as PasskeyBrowserStartRequest;
        const row = await presentedChallenge(env, request, body.challenge, { purpose: 'sign-in', kind: 'device' });
        const db = env.ctx.tenancy.db(request.tenant);
        if ((await twoFactorRepo.passkeysOf(db, row.userId)).length === 0) throw passkeyFailed();
        const flowId = newId();
        const started = await twoFactorRepo.startChallengeFlow(db, row.id, {
          flowId,
          codeChallenge: body.codeChallenge,
          loopbackPort: body.loopbackPort,
        });
        // One hand-off per challenge: a second start would let another loopback race the first.
        if (!started) throw flowInvalid();
        const url = new URL('/sign-in/two-factor/passkey', primaryUrl(env.ctx.config, request));
        url.searchParams.set('flow', flowId);
        return { url: url.href };
      },
    );

    app.post(
      '/auth/two-factor/passkey/complete',
      {
        schema: {
          body: jsonSchema(passkeyCompleteRequestSchema, { io: 'input' }),
          response: { 201: jsonSchema(signInResponseSchema) },
        },
      },
      async (request, reply) => {
        if (!env.settings.local) throw methodDisabled();
        const body = request.body as PasskeyCompleteRequest;
        await charge(env, request.tenant, ipKey(request));
        const row = await twoFactorRepo.challengeByFlow(env.ctx.tenancy.db(request.tenant), body.flowId, env.now());
        if (
          row?.grantHash == null ||
          row.codeChallenge === null ||
          !sameSecret(row.grantHash, hashSecret(body.grant)) ||
          pkceChallenge(body.codeVerifier) !== row.codeChallenge
        )
          throw flowInvalid();
        // The passkey was checked on the flow page; taking the challenge here makes the grant one-use.
        const signed = await finishChallenge(env, request.tenant, auditSource(request), row, 'passkey', () =>
          Promise.resolve(true),
        );
        return reply.code(201).send(signed);
      },
    );
  };

/** Constant-time equality of two hex hashes. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
