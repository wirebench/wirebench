/**
 * The SAML flow (saml-scim spec §3.2): the OIDC loopback flow with a different middle. The desktop starts a
 * flow with a PKCE challenge and its loopback port; the browser carries an `AuthnRequest` to the IdP; the
 * IdP posts the response to the ACS here, which validates it, links the claims and hands the browser a
 * one-time grant for the loopback; the desktop proves the verifier and the grant at `/complete` and gets an
 * ordinary device token. The assertion never leaves this process.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  samlCompleteRequestSchema,
  samlInfoResponseSchema,
  samlStartRequestSchema,
  samlStartResponseSchema,
  signInResponseSchema,
  type SamlCompleteRequest,
  type SamlStartRequest,
} from '@wirebench/engine';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ANONYMOUS_SOURCE, auditSource, recordAudit } from '../../context.js';
import {
  FLOW_EXPIRED_MESSAGE,
  finishBrowserSignIn,
  refusalMessage,
  safeRedirectPath,
  startBrowserFlow,
  takeBrowserFlow,
} from '../../identity/browser-flows.js';
import { flowInvalid, methodDisabled } from '../../identity/errors.js';
import { requireServerAdmin } from '../../identity/guard.js';
import { INVITE_PAGE_CSP, renderReturnPage } from '../../identity/invite-page.js';
import { linkClaims, type IdentityLinks } from '../../identity/linking.js';
import { ipKey, rateLimit } from '../../identity/rate-limit.js';
import * as identityRepo from '../../identity/repo.js';
import { tenantUrl } from '../../tenancy/urls.js';
import type { UserRow } from '../../identity/repo.js';
import { signIn } from '../../identity/sessions.js';
import { sendSignInPage } from '../../identity/sign-in-page.js';
import { hashSecret, mintSecret, newId, pkceChallenge } from '../../identity/tokens.js';
import { jsonSchema } from '../../schema.js';
import type { SsoEnv } from '../env.js';
import * as repo from '../repo.js';
import { SamlRejected, claimsOf, type SamlAssertion } from '../saml.js';

/** §3.2: a pending flow lives ten minutes, as OIDC's does. */
const FLOW_TTL_MS = 10 * 60 * 1000;
/** §6.1: refused before the XML is parsed. */
export const ACS_BODY_LIMIT = 256 * 1024;

const SAML_LINKS: IdentityLinks = {
  method: 'saml',
  find: (db, issuer, subject) => repo.samlIdentityOf(db, issuer, subject),
  insert: (db, input) =>
    repo.insertSamlIdentity(db, { entityId: input.issuer, nameId: input.subject, userId: input.userId, at: input.at }),
};

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

function redirectToLoopback(
  reply: FastifyReply,
  flow: repo.SamlFlowRow,
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

const EXPIRED = 'This sign-in has expired or was already completed. Return to Wirebench and start again.';

type Answer =
  | { readonly ok: true; readonly user: UserRow }
  | { readonly ok: false; readonly code: string; readonly email?: string };

/**
 * What both ACS routes do with a posted response once its flow is known: the license, the library's
 * validation and ours, the claims mapping and the linking rules. Only the flow and the reply differ.
 */
async function answerResponse(
  env: SsoEnv & { readonly saml: NonNullable<SsoEnv['saml']> },
  request: FastifyRequest,
  input: {
    readonly samlResponse: string;
    readonly requestId: string;
    readonly acsUrl: string;
    readonly flowId: string;
  },
): Promise<Answer> {
  if (!(await env.ctx.license.state()).features.includes('sso-provisioning'))
    return { ok: false, code: 'licensing-feature-required' };
  let assertion: SamlAssertion;
  try {
    assertion = await env.saml.provider.validate({
      samlResponse: input.samlResponse,
      requestId: input.requestId,
      acsUrl: input.acsUrl,
    });
  } catch (error) {
    if (!(error instanceof SamlRejected)) throw error;
    // The flow ID and the library's message only: never the XML or what it asserts (§6.1).
    request.log.warn({ flowId: input.flowId, reason: error.reason, detail: error.message }, 'saml response refused');
    return { ok: false, code: error.reason };
  }
  const mapped = claimsOf(assertion, env.saml.claims);
  if (!mapped.ok) return { ok: false, code: mapped.code };
  const { claims } = mapped;
  const linked = await linkClaims(
    env,
    { ...claims, emailVerified: claims.email !== undefined },
    auditSource(request),
    SAML_LINKS,
  );
  if (!linked.ok)
    return {
      ok: false,
      code: linked.code === 'identity-email-unverified' ? 'identity-saml-no-email' : linked.code,
      ...(claims.email !== undefined ? { email: claims.email } : {}),
    };
  return { ok: true, user: linked.user };
}

/** The `auth.sign_in_failed` event of a refused SAML response. */
const recordRefusal = (env: SsoEnv, request: FastifyRequest, reason: string, email?: string) =>
  recordAudit(env.ctx.hooks, env.ctx.db, {
    ...auditSource(request),
    ...ANONYMOUS_SOURCE,
    action: 'auth.sign_in_failed',
    target: { kind: 'server' },
    details: { method: 'saml', reason, emailLower: email?.toLowerCase() ?? null },
  });

const parseForm = (body: string): Record<string, string> => Object.fromEntries(new URLSearchParams(body));
const formField = (body: unknown, name: string): string => {
  const value = (body as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' ? value : '';
};

export const authSamlRoutes =
  (env: SsoEnv) =>
  (app: FastifyInstance): void => {
    const feature = env.ctx.license.requireFeature('sso-provisioning');

    app.post(
      '/auth/saml/start',
      {
        preHandler: [
          (_request, _reply, done) => {
            done(env.saml === undefined ? methodDisabled() : undefined);
          },
          feature,
        ],
        schema: {
          body: jsonSchema(samlStartRequestSchema, { io: 'input' }),
          response: { 201: jsonSchema(samlStartResponseSchema) },
        },
      },
      async (request, reply) => {
        const saml = env.saml!;
        const body = request.body as SamlStartRequest;
        const now = env.now();
        const id = newId();
        // §3.2: `_` + 20 random bytes in hex. An XML ID must not start with a digit.
        const requestId = `_${randomBytes(20).toString('hex')}`;
        const relayState = mintSecret().secret;
        const expiresAt = new Date(now.getTime() + FLOW_TTL_MS);
        await repo.insertSamlFlow(env.ctx.db, {
          id,
          requestId,
          codeChallenge: body.codeChallenge,
          loopbackPort: body.loopbackPort,
          deviceName: body.device.name,
          relayState,
          createdAt: now,
          expiresAt,
        });
        return reply.code(201).send({
          flowId: id,
          authorizationUrl: await saml.provider.authorizationUrl({ requestId, relayState }),
          expiresAt: expiresAt.toISOString(),
        });
      },
    );

    // The IdP's form post. Its own scope, so the form parser and the body limit reach nothing else.
    void app.register((acs, _options, registered) => {
      acs.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string', bodyLimit: ACS_BODY_LIMIT },
        (_request, body, done) => {
          done(null, parseForm(body as string));
        },
      );
      acs.post(
        '/auth/saml/acs',
        {
          bodyLimit: ACS_BODY_LIMIT,
          // The IdP's page posts this, with the IdP's Origin; a session cookie must not get in the way.
          config: { cookieAuth: false },
          preHandler: [rateLimit(env, (request) => [ipKey(request)])],
        },
        async (request, reply) => {
          const saml = env.saml;
          if (saml === undefined) throw methodDisabled();
          const relayState = formField(request.body, 'RelayState');
          const samlResponse = formField(request.body, 'SAMLResponse');
          const flow = relayState === '' ? undefined : await repo.samlFlowByRelayState(env.ctx.db, relayState);
          if (flow === undefined || flow.grantHash !== null || Date.parse(flow.expiresAt) <= env.now().getTime())
            return htmlPage(reply, 400, EXPIRED);
          const answer = await answerResponse({ ...env, saml }, request, {
            samlResponse,
            requestId: flow.requestId,
            acsUrl: env.urlsFor(request).acsUrl,
            flowId: flow.id,
          });
          if (!answer.ok) {
            await repo.deleteSamlFlow(env.ctx.db, flow.id);
            await recordRefusal(env, request, answer.code, answer.email);
            return redirectToLoopback(reply, flow, { error: answer.code });
          }
          const grant = mintSecret();
          // Single grant, whatever happens next: the same response posted twice finds the flow granted.
          if (!(await repo.grantSamlFlow(env.ctx.db, flow.id, grant.hash, answer.user.id)))
            return htmlPage(reply, 400, EXPIRED);
          return redirectToLoopback(reply, flow, { grant: grant.secret });
        },
      );

      // The browser client's ACS (hosted spec §17.2): the same checks, then the session cookie instead
      // of a grant for the loopback. The IdP's page posts here, so there is no Origin to check; the
      // flow cookie is what ties the response to the browser that started the flow.
      if (env.ctx.config.browserClient)
        acs.post(
          '/auth/saml/browser-acs',
          {
            bodyLimit: ACS_BODY_LIMIT,
            // The IdP's page posts this, with the IdP's Origin; a session cookie must not get in the way.
            config: { cookieAuth: false },
            preHandler: [rateLimit(env, (request) => [ipKey(request)])],
          },
          async (request, reply) => {
            const saml = env.saml;
            if (saml === undefined) throw methodDisabled();
            const flow = await takeBrowserFlow(env, request, reply, 'saml', formField(request.body, 'RelayState'));
            if (flow === undefined || flow.nonce === null)
              return sendSignInPage(reply, env.ctx, { status: 400, message: FLOW_EXPIRED_MESSAGE });
            const answer = await answerResponse({ ...env, saml }, request, {
              samlResponse: formField(request.body, 'SAMLResponse'),
              requestId: flow.nonce,
              acsUrl: env.urlsFor(request).browserAcsUrl,
              flowId: flow.id,
            });
            if (!answer.ok) {
              await recordRefusal(env, request, answer.code, answer.email);
              return sendSignInPage(reply, env.ctx, {
                status: 403,
                message: refusalMessage(answer.code),
                redirectTo: flow.redirectTo,
              });
            }
            return finishBrowserSignIn(env, request, reply, answer.user, 'saml', auditSource(request), flow.redirectTo);
          },
        );
      registered();
    });

    app.post(
      '/auth/saml/complete',
      {
        preHandler: [rateLimit(env, (request) => [ipKey(request)])],
        schema: {
          body: jsonSchema(samlCompleteRequestSchema, { io: 'input' }),
          response: { 201: jsonSchema(signInResponseSchema) },
        },
      },
      async (request, reply) => {
        if (env.saml === undefined) throw methodDisabled();
        const body = request.body as SamlCompleteRequest;
        const flow = await repo.samlFlowById(env.ctx.db, body.flowId);
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
        if (!(await repo.claimGrantedSamlFlow(env.ctx.db, flow.id, flow.grantHash))) throw flowInvalid();
        const user = await identityRepo.findUserById(env.ctx.db, flow.userId);
        if (user === undefined || user.disabledAt !== null) throw flowInvalid();
        return reply.code(201).send(await signIn(env, user, 'saml', flow.deviceName, auditSource(request)));
      },
    );

    app.get('/auth/saml/metadata', async (_request, reply) => {
      if (env.saml === undefined) throw methodDisabled();
      return reply
        .header('cache-control', 'no-store')
        .type('application/samlmetadata+xml; charset=utf-8')
        .send(env.saml.provider.metadata());
    });

    app.get(
      '/auth/saml/info',
      {
        preHandler: [requireServerAdmin, feature],
        schema: { response: { 200: jsonSchema(samlInfoResponseSchema) } },
      },
      (request) => ({
        configured: env.saml !== undefined,
        ...(env.saml !== undefined ? { idpEntityId: env.saml.provider.idpEntityId } : {}),
        entityId: env.urlsFor(request).entityId,
        acsUrl: env.urlsFor(request).acsUrl,
        scimBaseUrl: env.urlsFor(request).scimBaseUrl,
      }),
    );
  };

/**
 * `GET /sign-in/saml` at the root, for the browser client (hosted spec §17.2): a top-level navigation
 * that starts a flow, so it needs no Origin check. The `AuthnRequest` names the browser ACS; its ID
 * is kept as the flow's nonce, since the response must answer it.
 */
export const browserSamlStartRoutes =
  (env: SsoEnv) =>
  (app: FastifyInstance): void => {
    app.get(
      '/sign-in/saml',
      {
        preHandler: [
          (_request, _reply, done) => {
            done(env.saml === undefined ? methodDisabled() : undefined);
          },
          env.ctx.license.requireFeature('sso-provisioning'),
          // Per address, since each start writes a row.
          rateLimit(env, (request) => [ipKey(request)]),
        ],
      },
      async (request, reply) => {
        const saml = env.saml!;
        const requestId = `_${randomBytes(20).toString('hex')}`;
        const relayState = await startBrowserFlow(env, request, reply, {
          provider: 'saml',
          redirectTo: safeRedirectPath(
            (request.query as Record<string, unknown>)['redirect_to'],
            tenantUrl(env.ctx.config, request),
          ),
          nonce: requestId,
        });
        return reply
          .code(302)
          .header(
            'location',
            await saml.provider.authorizationUrl({ requestId, relayState, acsUrl: env.urlsFor(request).browserAcsUrl }),
          )
          .header('cache-control', 'no-store')
          .header('referrer-policy', 'no-referrer')
          .send();
      },
    );
  };
