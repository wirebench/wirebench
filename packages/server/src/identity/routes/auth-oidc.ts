/**
 * The OIDC flow (identity spec §3.1, §6): the desktop starts a flow with a PKCE challenge and
 * its loopback port, the browser round-trips through the IdP and back to `/callback` on this
 * server, which links the claims and hands the browser a one-time grant for the loopback; the
 * desktop then proves the verifier and the grant at `/complete` and gets a device token. The
 * ID token never leaves this process and the desktop never sees the IdP.
 */
import {
  oidcCallbackQuerySchema,
  oidcCompleteRequestSchema,
  oidcStartRequestSchema,
  oidcStartResponseSchema,
  signInResponseSchema,
  type OidcCallbackQuery,
  type OidcCompleteRequest,
  type OidcStartRequest,
} from '@wirebench/engine';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { jsonSchema } from '../../schema.js';
import type { IdentityEnv } from '../env.js';
import { flowInvalid, methodDisabled } from '../errors.js';
import { INVITE_PAGE_CSP, renderReturnPage } from '../invite-page.js';
import { linkClaims } from '../linking.js';
import type { OidcClaims } from '../oidc.js';
import { ipKey, rateLimit } from '../rate-limit.js';
import * as repo from '../repo.js';
import { issueToken } from '../sessions.js';
import { hashSecret, mintSecret, newId, pkceChallenge } from '../tokens.js';

/** §2: a pending flow lives ten minutes. */
const FLOW_TTL_MS = 10 * 60 * 1000;

function sameSecret(storedHash: string, candidateHash: string): boolean {
  const a = Buffer.from(storedHash, 'hex');
  const b = Buffer.from(candidateHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function htmlPage(reply: FastifyReply, status: number, message: string): FastifyReply {
  return reply
    .code(status)
    .header('content-security-policy', INVITE_PAGE_CSP)
    .header('cache-control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(renderReturnPage(message));
}

/** The browser goes to the loopback; the body is only for a browser that does not follow the redirect. */
function redirectToLoopback(
  reply: FastifyReply,
  flow: repo.FlowRow,
  params: Readonly<Record<string, string>>,
): FastifyReply {
  const url = new URL(`http://127.0.0.1:${String(flow.loopbackPort)}/callback`);
  url.searchParams.set('flow', flow.id);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return reply
    .code(302)
    .header('location', url.href)
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .type('text/html; charset=utf-8')
    .send(renderReturnPage('Return to Wirebench to finish signing in.'));
}

export const authOidcRoutes =
  (env: IdentityEnv) =>
  (app: FastifyInstance): void => {
    app.post(
      '/auth/oidc/start',
      {
        schema: {
          body: jsonSchema(oidcStartRequestSchema, { io: 'input' }),
          response: { 201: jsonSchema(oidcStartResponseSchema) },
        },
      },
      async (request, reply) => {
        const provider = env.provider;
        if (provider === undefined) throw methodDisabled();
        const body = request.body as OidcStartRequest;
        const now = env.now();
        const id = newId();
        const state = mintSecret().secret;
        const nonce = mintSecret().secret;
        const expiresAt = new Date(now.getTime() + FLOW_TTL_MS);
        await repo.insertFlow(env.ctx.db, {
          id,
          codeChallenge: body.codeChallenge,
          loopbackPort: body.loopbackPort,
          deviceName: body.device.name,
          state,
          nonce,
          createdAt: now,
          expiresAt,
        });
        return reply.code(201).send({
          flowId: id,
          authorizationUrl: provider.authorizationUrl({ state, nonce, redirectUri: env.settings.redirectUri }),
          expiresAt: expiresAt.toISOString(),
        });
      },
    );

    app.get(
      '/auth/oidc/callback',
      { schema: { querystring: jsonSchema(oidcCallbackQuerySchema, { io: 'input' }) } },
      async (request, reply) => {
        const provider = env.provider;
        if (provider === undefined) throw methodDisabled();
        const query = request.query as OidcCallbackQuery;
        const flow = await repo.flowByState(env.ctx.db, query.state);
        if (flow === undefined || flow.grantHash !== null || Date.parse(flow.expiresAt) <= env.now().getTime()) {
          return htmlPage(
            reply,
            400,
            'This sign-in has expired or was already completed. Return to Wirebench and start again.',
          );
        }
        if (query.code === undefined || query.error !== undefined) {
          await repo.deleteFlow(env.ctx.db, flow.id);
          return redirectToLoopback(reply, flow, { error: 'identity-oidc-refused' });
        }
        let claims: OidcClaims;
        try {
          claims = await provider.exchange({
            callbackUrl: new URL(request.url, env.ctx.config.publicUrl),
            state: flow.state,
            nonce: flow.nonce,
          });
        } catch (error) {
          request.log.warn({ err: error, flowId: flow.id }, 'oidc code exchange failed');
          await repo.deleteFlow(env.ctx.db, flow.id);
          return redirectToLoopback(reply, flow, { error: 'identity-oidc-failed' });
        }
        if (claims.issuer !== provider.issuer) {
          await repo.deleteFlow(env.ctx.db, flow.id); // §6: the issuer is pinned from configuration
          return redirectToLoopback(reply, flow, { error: 'identity-oidc-failed' });
        }
        const linked = await linkClaims(env, claims);
        if (!linked.ok) {
          await repo.deleteFlow(env.ctx.db, flow.id);
          return redirectToLoopback(reply, flow, { error: linked.code });
        }
        const grant = mintSecret();
        await repo.grantFlow(env.ctx.db, flow.id, grant.hash, linked.user.id);
        return redirectToLoopback(reply, flow, { grant: grant.secret });
      },
    );

    app.post(
      '/auth/oidc/complete',
      {
        preHandler: [rateLimit(env, (request) => [ipKey(request)])],
        schema: {
          body: jsonSchema(oidcCompleteRequestSchema, { io: 'input' }),
          response: { 201: jsonSchema(signInResponseSchema) },
        },
      },
      async (request, reply) => {
        if (env.provider === undefined) throw methodDisabled();
        const body = request.body as OidcCompleteRequest;
        const flow = await repo.flowById(env.ctx.db, body.flowId);
        if (
          flow === undefined ||
          flow.grantHash === null ||
          flow.userId === null ||
          Date.parse(flow.expiresAt) <= env.now().getTime()
        )
          throw flowInvalid();
        if (
          !sameSecret(flow.grantHash, hashSecret(body.grant)) ||
          pkceChallenge(body.codeVerifier) !== flow.codeChallenge
        )
          throw flowInvalid();
        await repo.deleteFlow(env.ctx.db, flow.id); // single use, whatever happens next
        const user = await repo.findUserById(env.ctx.db, flow.userId);
        if (user === undefined || user.disabledAt !== null) throw flowInvalid();
        return reply.code(201).send(await issueToken(env, user, flow.deviceName));
      },
    );
  };
