/**
 * The browser's sign-in routes at the root (hosted spec §17.2), registered through `registerPublic`
 * only when `WIREBENCH_SERVER_BROWSER_CLIENT` is on: the page, the local form, the start of the
 * OIDC flow, whose callback lives with the desktop's in `auth-oidc.ts`, and the sign-out form. SAML's
 * start is the sso module's. These routes sit outside `/api/v1`, so the guard's Origin check does not
 * reach them; the two forms check Origin themselves, against login CSRF and forced sign-out.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { auditSource } from '../../context.js';
import { toProblem } from '../../problem.js';
import { tenantUrl } from '../../tenancy/urls.js';
import { endPresentedSession, finishBrowserSignIn, safeRedirectPath, startBrowserFlow } from '../browser-flows.js';
import { clearSessionCookie } from '../cookies.js';
import type { IdentityEnv } from '../env.js';
import { methodDisabled, originRefused } from '../errors.js';
import { chargeKeys, emailKey, ipKey, rateLimit } from '../rate-limit.js';
import { sendSignInPage } from '../sign-in-page.js';
import { mintSecret, pkceChallenge } from '../tokens.js';
import { checkLocalCredentials } from './auth-local.js';

/** An email and a password with room to spare; anything bigger is not a sign-in. */
const FORM_BODY_LIMIT = 16 * 1024;
const MAX_FIELD_LENGTH = 1024;

const field = (body: unknown, name: string): string | undefined => {
  const value = (body as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' && value !== '' && value.length <= MAX_FIELD_LENGTH ? value : undefined;
};

export const browserSignInRoutes =
  (env: IdentityEnv) =>
  (app: FastifyInstance): void => {
    const urlOf = (request: FastifyRequest): string => tenantUrl(env.ctx.config, request);

    app.get('/sign-in', async (request, reply) =>
      sendSignInPage(reply, env.ctx, {
        redirectTo: safeRedirectPath((request.query as Record<string, unknown>)['redirect_to'], urlOf(request)),
      }),
    );

    // The form post. Its own scope, so the form parser and its body limit reach nothing else.
    void app.register((form, _options, registered) => {
      form.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string', bodyLimit: FORM_BODY_LIMIT },
        (_request, body, done) => {
          done(null, Object.fromEntries(new URLSearchParams(body as string)));
        },
      );
      form.post('/sign-in/local', { bodyLimit: FORM_BODY_LIMIT }, async (request, reply) => {
        if (!env.settings.local) throw methodDisabled();
        // Login CSRF: another site's form must not sign this browser in to an account of its choosing.
        const url = urlOf(request);
        if (request.headers.origin !== url) throw originRefused();
        const redirectTo = safeRedirectPath(field(request.body, 'redirect_to'), url);
        // The same buckets as the desktop's route, so the two together get no more attempts.
        const retryAfter = chargeKeys(env.limiter, [ipKey(request), emailKey(request)]);
        if (retryAfter > 0) {
          reply.header('retry-after', String(retryAfter));
          return sendSignInPage(reply, env.ctx, {
            status: 429,
            message: 'Too many attempts. Try again shortly.',
            redirectTo,
          });
        }
        const email = field(request.body, 'email');
        const password = field(request.body, 'password');
        if (email === undefined || password === undefined)
          return sendSignInPage(reply, env.ctx, { status: 400, message: 'Enter your email and password.', redirectTo });
        const source = auditSource(request);
        const checked = await checkLocalCredentials(env, source, email, password);
        if (!checked.ok)
          return sendSignInPage(reply, env.ctx, {
            status: toProblem(checked.error).status,
            message: checked.error.message,
            redirectTo,
          });
        return finishBrowserSignIn(env, request, reply, checked.user, 'local', source, redirectTo);
      });
      // Sign-out (spec §17.2): revokes the presented browser token, which announces `sessionEnded` and so
      // closes that session's host sockets with 4401. A stale or missing cookie is still cleared, so the
      // browser stops presenting it, and lands on the sign-in page all the same.
      form.post('/sign-out', { bodyLimit: FORM_BODY_LIMIT }, async (request, reply) => {
        // Another site must not sign this browser out (a nuisance, and a step towards login CSRF).
        const url = urlOf(request);
        if (request.headers.origin !== url) throw originRefused();
        await endPresentedSession(env, request, auditSource(request));
        clearSessionCookie(reply, url);
        return reply.code(303).header('location', '/sign-in').header('cache-control', 'no-store').send();
      });
      registered();
    });

    // A top-level navigation that only starts a flow, so it needs no Origin check.
    // Rate-limited per address, since each start writes a row.
    app.get(
      '/sign-in/oidc',
      { preHandler: [rateLimit(env, (request) => [ipKey(request)])] },
      async (request, reply) => {
        const provider = env.provider;
        if (provider === undefined) throw methodDisabled();
        const nonce = mintSecret().secret;
        // 43 base64url characters: a valid RFC 7636 verifier.
        const codeVerifier = mintSecret().secret;
        const state = await startBrowserFlow(env, request, reply, {
          provider: 'oidc',
          redirectTo: safeRedirectPath((request.query as Record<string, unknown>)['redirect_to'], urlOf(request)),
          nonce,
          codeVerifier,
        });
        return reply
          .code(302)
          .header(
            'location',
            provider.authorizationUrl({
              state,
              nonce,
              redirectUri: env.settings.browserRedirectUri(request),
              codeChallenge: pkceChallenge(codeVerifier),
            }),
          )
          .header('cache-control', 'no-store')
          .header('referrer-policy', 'no-referrer')
          .send();
      },
    );
  };
