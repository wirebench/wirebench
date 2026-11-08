/**
 * The browser's sign-in routes at the root (hosted spec §17.2), registered through `registerPublic`
 * on every server: the page, the local form, the start of the
 * OIDC flow, whose callback lives with the desktop's in `auth-oidc.ts`, the sign-out form and the
 * invitation form (`browser-invite.ts`). SAML's
 * start is the sso module's. These routes sit outside `/api/v1`, so the guard's Origin check does not
 * reach them; the forms check Origin themselves, against login CSRF and forced sign-out.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { auditSource, recordAudit } from '../../context.js';
import { toProblem } from '../../problem.js';
import { tenantUrl } from '../../tenancy/urls.js';
import {
  ACCOUNTS_FULL_MESSAGE,
  ADDED_PATH,
  adoptAddedSession,
  endPresentedSession,
  finishBrowserSignIn,
  onPrimaryHost,
  safeRedirectPath,
  startBrowserFlow,
} from '../browser-flows.js';
import { clearAccountsCookie, clearSessionCookie, MAX_REMEMBERED_SESSIONS, setSessionCookie } from '../cookies.js';
import { requireProvider, type IdentityEnv } from '../env.js';
import { methodDisabled, originRefused } from '../errors.js';
import { chargeKeys, identifierKey, ipKey, rateLimit } from '../rate-limit.js';
import { presentedSessions, remainingSeconds, revokeSession, writeRemembered } from '../remembered.js';
import { sendSignInPage } from '../sign-in-page.js';
import { mintSecret, pkceChallenge } from '../tokens.js';
import { checkLocalCredentials } from './auth-local.js';
import { browserInviteRoutes } from './browser-invite.js';
import { browserTwoFactorRoutes, sendTwoFactorStep } from './browser-two-factor.js';
import { BROWSER_DEVICE_NAME } from '../browser-flows.js';
import { twoFactorGate } from '../two-factor/gate.js';

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

    // `?add=1` is *Add an account* (switch accounts spec §5.3), when the browser holds a live session to keep. At five
    // accounts it answers the refusal before any form.
    app.get('/sign-in', async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const redirectTo = safeRedirectPath(query['redirect_to'], urlOf(request));
      if (query['add'] !== '1') return sendSignInPage(reply, env.ctx, { redirectTo });
      const presented = await presentedSessions(env, request);
      if (presented.active === undefined) return sendSignInPage(reply, env.ctx, { redirectTo });
      const full = presented.remembered.length >= MAX_REMEMBERED_SESSIONS;
      return sendSignInPage(reply, env.ctx, {
        redirectTo,
        add: true,
        ...(full ? { status: 409, message: ACCOUNTS_FULL_MESSAGE, full: true } : {}),
      });
    });

    // Where a SAML *Add an account* lands from its ACS (switch accounts spec §5.3; `handOffAddedSignIn`).
    app.get(ADDED_PATH, async (request, reply) =>
      adoptAddedSession(
        env,
        request,
        reply,
        auditSource(request),
        safeRedirectPath((request.query as Record<string, unknown>)['redirect_to'], urlOf(request)),
      ),
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
        const add = field(request.body, 'add') === '1';
        // The same buckets as the desktop's route, so the two together get no more attempts.
        const retryAfter = await chargeKeys(env.limiter, request.tenant, [ipKey(request), identifierKey(request)]);
        if (retryAfter > 0) {
          reply.header('retry-after', String(retryAfter));
          return sendSignInPage(reply, env.ctx, {
            status: 429,
            message: 'Too many attempts. Try again shortly.',
            redirectTo,
            add,
          });
        }
        // `email` is what a page cached before usernames posts (ruling 8).
        const identifier = field(request.body, 'identifier') ?? field(request.body, 'email');
        const password = field(request.body, 'password');
        if (identifier === undefined || password === undefined)
          return sendSignInPage(reply, env.ctx, {
            status: 400,
            message: 'Enter your email or username and your password.',
            redirectTo,
            add,
          });
        const source = auditSource(request);
        const checked = await checkLocalCredentials(env, request.tenant, source, identifier, password);
        if (!checked.ok)
          return sendSignInPage(reply, env.ctx, {
            status: toProblem(checked.error).status,
            message: checked.error.message,
            redirectTo,
            add,
          });
        // Two-step sign-in (spec §4.1): the code page instead of a session, its challenge in the `wb_2fa` cookie.
        const challenge = await twoFactorGate(env, request.tenant, checked.user, {
          deviceName: BROWSER_DEVICE_NAME,
          kind: 'browser',
        });
        const mode = add ? 'add' : 'replace';
        if (challenge !== undefined) return sendTwoFactorStep(env, reply, challenge, redirectTo, mode);
        return finishBrowserSignIn(env, request, reply, checked.user, 'local', source, redirectTo, mode);
      });
      // Sign-out (spec §17.2, switch accounts spec §5.4): revokes the presented browser token, which announces
      // `sessionEnded` and so closes that session's host sockets with 4401. The most recent remembered session then
      // becomes active and the tab goes back to `redirect_to`; with none, the cookies are cleared and the tab lands on
      // the sign-in page. A stale or missing cookie is still cleared, so the browser stops presenting it.
      // `?all=1` revokes every session the browser holds.
      form.post('/sign-out', { bodyLimit: FORM_BODY_LIMIT }, async (request, reply) => {
        // Another site must not sign this browser out (a nuisance, and a step towards login CSRF).
        const url = urlOf(request);
        if (request.headers.origin !== url) throw originRefused();
        const all = (request.query as Record<string, unknown>)['all'] === '1';
        const redirectTo = safeRedirectPath(field(request.body, 'redirect_to'), url);
        const source = auditSource(request);
        await endPresentedSession(env, request, source);
        const presented = await presentedSessions(env, request);
        if (all) for (const session of presented.remembered) await revokeSession(env, request, session, source);
        const [next, ...rest] = all ? [] : presented.remembered;
        if (next !== undefined) {
          setSessionCookie(reply, url, next.token, remainingSeconds(env, next));
          writeRemembered(env, request, reply, rest);
          return reply.code(303).header('location', redirectTo).header('cache-control', 'no-store').send();
        }
        clearSessionCookie(reply, url);
        if (presented.presented) clearAccountsCookie(reply, url);
        return reply.code(303).header('location', '/sign-in').header('cache-control', 'no-store').send();
      });
      // Switching (switch accounts spec §5.2): `user` names a person whose live session the remembered cookie holds;
      // that session and the active one change places. A person the browser holds no live session for (unknown, or
      // one whose session ended) switches nothing: dead tokens are dropped and the tab goes to sign in as them.
      form.post('/sign-in/switch', { bodyLimit: FORM_BODY_LIMIT }, async (request, reply) => {
        // Another site must not switch this browser to another of its accounts.
        const url = urlOf(request);
        if (request.headers.origin !== url) throw originRefused();
        const userId = field(request.body, 'user');
        const redirectTo = safeRedirectPath(field(request.body, 'redirect_to'), url);
        const presented = await presentedSessions(env, request);
        const target = presented.remembered.find((session) => session.user.id === userId);
        if (target === undefined) {
          if (presented.stale) writeRemembered(env, request, reply, presented.remembered);
          const query = [
            ...(presented.active === undefined ? [] : ['add=1']),
            ...(redirectTo === '/' ? [] : [`redirect_to=${encodeURIComponent(redirectTo)}`]),
          ];
          const location = `/sign-in${query.length === 0 ? '' : `?${query.join('&')}`}`;
          return reply.code(303).header('location', location).header('cache-control', 'no-store').send();
        }
        const previous = presented.active;
        const holder = previous ?? target;
        await env.ctx.tenancy.db(request.tenant).transaction((tx) =>
          recordAudit(env.ctx.hooks, tx, {
            ...auditSource(request),
            // The person at the browser: the one switched from, else the one switched to.
            actor: { kind: 'user', userId: holder.user.id, email: holder.user.email, tokenId: holder.tokenId },
            action: 'user.session_switched',
            target: { kind: 'user', id: target.user.id },
            details: { from: previous?.user.id ?? null },
          }),
        );
        setSessionCookie(reply, url, target.token, remainingSeconds(env, target));
        writeRemembered(env, request, reply, [
          ...(previous === undefined ? [] : [previous]),
          ...presented.remembered.filter((session) => session !== target),
        ]);
        return reply.code(303).header('location', redirectTo).header('cache-control', 'no-store').send();
      });
      // The invitation page's form (team management in the browser §2.3), under the same parser and limit.
      browserInviteRoutes(env, FORM_BODY_LIMIT)(form);
      // The second step's code form (two-step sign-in spec §4.1), under the same parser, limit and Origin check.
      browserTwoFactorRoutes(env, FORM_BODY_LIMIT)(form);
      registered();
    });

    // A top-level navigation that only starts a flow, so it needs no Origin check.
    // Rate-limited per address, since each start writes a row.
    app.get(
      '/sign-in/oidc',
      { preHandler: [rateLimit(env, (request) => [ipKey(request)])] },
      async (request, reply) => {
        const provider = await requireProvider(env, request);
        // A tenant without the method answers 404 on either of its names; one with it starts on the primary.
        const moved = onPrimaryHost(env.ctx.config, request, reply);
        if (moved !== undefined) return moved;
        const nonce = mintSecret().secret;
        // 43 base64url characters: a valid RFC 7636 verifier.
        const codeVerifier = mintSecret().secret;
        const state = await startBrowserFlow(env, request, reply, {
          provider: 'oidc',
          redirectTo: safeRedirectPath((request.query as Record<string, unknown>)['redirect_to'], urlOf(request)),
          nonce,
          codeVerifier,
          addAccount: (request.query as Record<string, unknown>)['add'] === '1',
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
