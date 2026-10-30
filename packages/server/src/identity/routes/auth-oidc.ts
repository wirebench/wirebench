/**
 * The OIDC flow (identity spec §3.1, §6): the desktop starts a flow with a PKCE challenge and
 * its loopback port, the browser round-trips through the IdP and back to `/callback` on this
 * server, which links the claims and hands the browser a one-time grant for the loopback; the
 * desktop then proves the verifier and the grant at `/complete` and gets a device token. The
 * ID token never leaves this process and the desktop never sees the IdP.
 */
import { ANONYMOUS_SOURCE, auditSource, recordAudit } from '../../context.js';
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
import { tenantUrl } from '../../tenancy/urls.js';
import { FLOW_EXPIRED_MESSAGE, finishBrowserSignIn, refusalMessage, takeBrowserFlow } from '../browser-flows.js';
import type { IdentityEnv } from '../env.js';
import { flowInvalid, methodDisabled } from '../errors.js';
import { INVITE_PAGE_CSP, renderReturnPage } from '../invite-page.js';
import { linkClaims } from '../linking.js';
import type { OidcClaims } from '../oidc.js';
import { ipKey, rateLimit } from '../rate-limit.js';
import * as repo from '../repo.js';
import { signIn } from '../sessions.js';
import { sendSignInPage } from '../sign-in-page.js';
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
        await repo.insertFlow(env.ctx.tenancy.db(request.tenant), {
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
          authorizationUrl: provider.authorizationUrl({ state, nonce, redirectUri: env.settings.redirectUri(request) }),
          expiresAt: expiresAt.toISOString(),
        });
      },
    );

    app.get(
      '/auth/oidc/callback',
      {
        // The state is a secret an unauthenticated caller presents (§12).
        config: { cookieAuth: false },
        preHandler: [rateLimit(env, (request) => [ipKey(request)])],
        schema: { querystring: jsonSchema(oidcCallbackQuerySchema, { io: 'input' }) },
      },
      async (request, reply) => {
        const provider = env.provider;
        if (provider === undefined) throw methodDisabled();
        const query = request.query as OidcCallbackQuery;
        const db = env.ctx.tenancy.db(request.tenant);
        const refused = (reason: string, email?: string) =>
          db.transaction((tx) =>
            recordAudit(env.ctx.hooks, tx, {
              ...auditSource(request),
              ...ANONYMOUS_SOURCE,
              action: 'auth.sign_in_failed',
              target: { kind: 'server' },
              details: { method: 'oidc', reason, emailLower: email?.toLowerCase() ?? null },
            }),
          );
        const flow = await repo.flowByState(db, query.state);
        if (flow === undefined || flow.grantHash !== null || Date.parse(flow.expiresAt) <= env.now().getTime()) {
          return htmlPage(
            reply,
            400,
            'This sign-in has expired or was already completed. Return to Wirebench and start again.',
          );
        }
        if (query.code === undefined || query.error !== undefined) {
          await repo.deleteFlow(db, flow.id);
          await refused('identity-oidc-refused');
          return redirectToLoopback(reply, flow, { error: 'identity-oidc-refused' });
        }
        let claims: OidcClaims;
        try {
          claims = await provider.exchange({
            callbackUrl: new URL(request.url, tenantUrl(env.ctx.config, request)),
            state: flow.state,
            nonce: flow.nonce,
          });
        } catch (error) {
          request.log.warn({ err: error, flowId: flow.id }, 'oidc code exchange failed');
          await repo.deleteFlow(db, flow.id);
          await refused('identity-oidc-failed');
          return redirectToLoopback(reply, flow, { error: 'identity-oidc-failed' });
        }
        if (claims.issuer !== provider.issuer) {
          await repo.deleteFlow(db, flow.id); // §6: the issuer is pinned from configuration
          await refused('identity-oidc-failed', claims.email);
          return redirectToLoopback(reply, flow, { error: 'identity-oidc-failed' });
        }
        const linked = await linkClaims(env, request.tenant, claims, auditSource(request));
        if (!linked.ok) {
          await repo.deleteFlow(db, flow.id);
          await refused(linked.code, claims.email);
          return redirectToLoopback(reply, flow, { error: linked.code });
        }
        const grant = mintSecret();
        await repo.grantFlow(db, flow.id, grant.hash, linked.user.id);
        return redirectToLoopback(reply, flow, { grant: grant.secret });
      },
    );

    // The browser client's callback (hosted spec §17.2): the same checks as above, then the session
    // cookie instead of a grant for the loopback. Registered only when the browser client is on.
    if (env.ctx.config.browserClient)
      app.get(
        '/auth/oidc/browser-callback',
        {
          config: { cookieAuth: false },
          preHandler: [rateLimit(env, (request) => [ipKey(request)])],
          schema: { querystring: jsonSchema(oidcCallbackQuerySchema, { io: 'input' }) },
        },
        async (request, reply) => {
          const provider = env.provider;
          if (provider === undefined) throw methodDisabled();
          const query = request.query as OidcCallbackQuery;
          const flow = await takeBrowserFlow(env, request, reply, 'oidc', query.state);
          if (flow === undefined) return sendSignInPage(reply, env.ctx, { status: 400, message: FLOW_EXPIRED_MESSAGE });
          const refuse = async (status: number, reason: string, email?: string) => {
            await env.ctx.tenancy.db(request.tenant).transaction((tx) =>
              recordAudit(env.ctx.hooks, tx, {
                ...auditSource(request),
                ...ANONYMOUS_SOURCE,
                action: 'auth.sign_in_failed',
                target: { kind: 'server' },
                details: { method: 'oidc', reason, emailLower: email?.toLowerCase() ?? null },
              }),
            );
            return sendSignInPage(reply, env.ctx, {
              status,
              message: refusalMessage(reason),
              redirectTo: flow.redirectTo,
            });
          };
          if (query.code === undefined || query.error !== undefined) return refuse(400, 'identity-oidc-refused');
          let claims: OidcClaims;
          try {
            claims = await provider.exchange({
              callbackUrl: new URL(request.url, tenantUrl(env.ctx.config, request)),
              state: query.state,
              nonce: flow.nonce ?? '',
              codeVerifier: flow.codeVerifier ?? '',
            });
          } catch (error) {
            request.log.warn({ err: error, flowId: flow.id }, 'oidc code exchange failed');
            return refuse(502, 'identity-oidc-failed');
          }
          // §6: the issuer is pinned from configuration.
          if (claims.issuer !== provider.issuer) return refuse(502, 'identity-oidc-failed', claims.email);
          const linked = await linkClaims(env, request.tenant, claims, auditSource(request));
          if (!linked.ok) return refuse(403, linked.code, claims.email);
          return finishBrowserSignIn(env, request, reply, linked.user, 'oidc', auditSource(request), flow.redirectTo);
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
        const db = env.ctx.tenancy.db(request.tenant);
        const flow = await repo.flowById(db, body.flowId);
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
        // Single use, whatever happens next: only the request that removed the row goes on.
        if (!(await repo.claimGrantedFlow(db, flow.id, flow.grantHash))) throw flowInvalid();
        const user = await repo.findUserById(db, flow.userId);
        if (user === undefined || user.disabledAt !== null) throw flowInvalid();
        return reply
          .code(201)
          .send(await signIn(env, request.tenant, user, 'oidc', flow.deviceName, auditSource(request)));
      },
    );
  };
