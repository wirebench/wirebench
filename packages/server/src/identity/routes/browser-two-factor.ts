/**
 * The browser's second step (two-step sign-in spec §4.1) and the browser half of the desktop's passkey hand-off
 * (§4.2): the code page a correct password leads to, its forms, the page script and the two calls it makes, and the
 * flow page the desktop opens. A browser sign-in's challenge rides in the `wb_2fa` cookie, never in the page; the
 * desktop's flow page names its flow, never its challenge. Registered inside the sign-in forms' scope
 * (`browser-sign-in.ts`), so the forms share its parser and body limit; every post checks Origin against login CSRF.
 */
import type { TwoFactorMethod } from '@wirebench/engine';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditSource } from '../../context.js';
import { toProblem } from '../../problem.js';
import { primaryUrl, tenantUrl } from '../../tenancy/urls.js';
import {
  ACCOUNTS_FULL_MESSAGE,
  type BrowserSignInMode,
  onPrimaryHost,
  placeBrowserSession,
  roomForSignIn,
  safeRedirectPath,
  sendAccountsFull,
} from '../browser-flows.js';
import { challengeCookie, clearChallengeCookie, setChallengeCookie } from '../cookies.js';
import type { IdentityEnv } from '../env.js';
import { methodDisabled, originRefused, twoFactorExpired } from '../errors.js';
import { sendSignInPage } from '../sign-in-page.js';
import { hashSecret } from '../tokens.js';
import {
  flowChallenge,
  MAX_ATTEMPTS,
  methodList,
  presentedChallenge,
  verifyCode,
  type TwoFactorChallenge,
} from '../two-factor/gate.js';
import { sendTwoFactorPage, type TwoFactorPageInput } from '../two-factor/page.js';
import { TWO_FACTOR_SCRIPT, TWO_FACTOR_SCRIPT_PATH } from '../two-factor/page-script.js';
import { grantWithPasskey, signInOptions, signInWithPasskey } from '../two-factor/passkeys.js';
import * as twoFactorRepo from '../two-factor/repo.js';

const MAX_FIELD_LENGTH = 1024;
const field = (body: unknown, name: string): string | undefined => {
  const value = (body as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' && value !== '' && value.length <= MAX_FIELD_LENGTH ? value : undefined;
};
const FLOW_PATTERN = /^[0-9A-Za-z]{1,64}$/;

/** What the sign-in page says when the second step can no longer be finished. */
export const TWO_FACTOR_EXPIRED_MESSAGE = 'This sign-in has expired. Sign in again.';
const FLOW_EXPIRED_MESSAGE = 'This sign-in has expired. Start again from Wirebench.';

/** Where a passkey works for `request` (plan ruling 3): `undefined` on the primary host, else the primary URL. */
function passkeyAt(env: Pick<IdentityEnv, 'ctx'>, request: FastifyRequest): string | undefined {
  const primary = primaryUrl(env.ctx.config, request);
  return tenantUrl(env.ctx.config, request) === primary ? undefined : primary;
}

/**
 * After a correct password in the browser: keeps the challenge in its cookie and answers the second step's page.
 * A setup challenge (no method yet, and the server requires one, spec §4.3) gets the page's setup notice.
 */
export function sendTwoFactorStep(
  env: Pick<IdentityEnv, 'ctx'>,
  reply: FastifyReply,
  challenge: TwoFactorChallenge,
  redirectTo: string,
  mode: BrowserSignInMode = 'replace',
): FastifyReply {
  const url = tenantUrl(env.ctx.config, reply.request);
  setChallengeCookie(reply, url, challenge.secret);
  const at = passkeyAt(env, reply.request);
  return sendTwoFactorPage(reply, {
    serverUrl: url,
    methods: challenge.methods,
    setup: challenge.setup,
    redirectTo,
    ...(at !== undefined ? { passkeyAt: at } : {}),
    ...(mode === 'add' ? { add: true } : {}),
  });
}

export const browserTwoFactorRoutes =
  (env: IdentityEnv, bodyLimit: number) =>
  (form: FastifyInstance): void => {
    const urlOf = (request: FastifyRequest) => tenantUrl(env.ctx.config, request);
    /** Every post: local sign-in on, and from this server's own pages. */
    const guardPost = (request: FastifyRequest): string => {
      if (!env.settings.local) throw methodDisabled();
      const url = urlOf(request);
      if (request.headers.origin !== url) throw originRefused();
      return url;
    };
    /** Back to the sign-in page, the challenge cookie dropped: it can no longer be finished. */
    const startAgain = (reply: FastifyReply, url: string, redirectTo: string, status: number, message: string) => {
      clearChallengeCookie(reply, url);
      return sendSignInPage(reply, env.ctx, { status, message, redirectTo });
    };
    const flowOf = (request: FastifyRequest): string | undefined => {
      const flow = (request.query as Record<string, unknown>)['flow'];
      return typeof flow === 'string' && FLOW_PATTERN.test(flow) ? flow : undefined;
    };
    /** The challenge a script call is for: the desktop's flow it names, or the browser's own in its cookie. */
    const scriptChallenge = async (request: FastifyRequest): Promise<twoFactorRepo.ChallengeRow> => {
      const flow = flowOf(request);
      if (flow !== undefined) return flowChallenge(env, request, flow);
      const secret = challengeCookie(request, urlOf(request));
      if (secret === undefined) throw twoFactorExpired();
      return presentedChallenge(env, request, secret, { purpose: 'sign-in', kind: 'browser' });
    };

    form.get(TWO_FACTOR_SCRIPT_PATH, async (_request, reply) =>
      reply
        .type('text/javascript; charset=utf-8')
        .header('cache-control', 'no-cache')
        .header('x-content-type-options', 'nosniff')
        .send(TWO_FACTOR_SCRIPT),
    );

    form.post('/sign-in/two-factor', { bodyLimit }, async (request, reply) => {
      const url = guardPost(request);
      const redirectTo = safeRedirectPath(field(request.body, 'redirect_to'), url);
      const mode: BrowserSignInMode = field(request.body, 'add') === '1' ? 'add' : 'replace';
      const secret = challengeCookie(request, url);
      if (secret === undefined) return startAgain(reply, url, redirectTo, 401, TWO_FACTOR_EXPIRED_MESSAGE);
      const method = field(request.body, 'method') === 'recovery' ? 'recovery' : 'totp';
      const source = auditSource(request);
      // Until the challenge is found, the page offers what any person with two-step sign-in may have.
      let methods: readonly TwoFactorMethod[] = ['totp', 'recovery'];
      try {
        const row = await presentedChallenge(env, request, secret, { purpose: 'sign-in', kind: 'browser' });
        methods = methodList(await twoFactorRepo.methodsOf(env.ctx.tenancy.db(request.tenant), row.userId));
        // *Add an account* past five (switch accounts spec §5.3) is refused before the code is spent.
        if (!(await roomForSignIn(env, request, row.userId, mode)))
          return await sendAccountsFull(env, reply, redirectTo);
        const signed = await verifyCode(env, request.tenant, source, row, method, field(request.body, 'code') ?? '');
        clearChallengeCookie(reply, url);
        await placeBrowserSession(env, request, reply, row.userId, signed.token, mode, source);
        return await reply.code(303).header('location', redirectTo).header('cache-control', 'no-store').send();
      } catch (error) {
        const refused = toProblem(error);
        if (refused.body.code === 'identity-two-factor-expired')
          return startAgain(reply, url, redirectTo, refused.status, TWO_FACTOR_EXPIRED_MESSAGE);
        if (refused.body.code === 'identity-user-disabled')
          return startAgain(reply, url, redirectTo, refused.status, refused.body.message);
        if (refused.status >= 500) throw error;
        if (refused.retryAfter !== undefined) reply.header('retry-after', String(refused.retryAfter));
        // The fifth wrong answer ended the challenge: nothing is left to try on this page.
        const left = await twoFactorRepo.challengeBySecretHash(
          env.ctx.tenancy.db(request.tenant),
          hashSecret(secret),
          env.now(),
        );
        if (left === undefined) return startAgain(reply, url, redirectTo, refused.status, TWO_FACTOR_EXPIRED_MESSAGE);
        const at = passkeyAt(env, request);
        const page: TwoFactorPageInput = {
          serverUrl: url,
          methods,
          setup: false,
          redirectTo,
          message: refused.body.message,
          attemptsLeft: MAX_ATTEMPTS - left.attempts,
          ...(at !== undefined ? { passkeyAt: at } : {}),
          ...(mode === 'add' ? { add: true } : {}),
        };
        return sendTwoFactorPage(reply.code(refused.status), page);
      }
    });

    // Cancel (spec §4.1): the challenge is dropped with its cookie, and the person is back at the sign-in page.
    form.post('/sign-in/two-factor/cancel', { bodyLimit }, async (request, reply) => {
      const url = guardPost(request);
      const secret = challengeCookie(request, url);
      if (secret !== undefined) {
        const db = env.ctx.tenancy.db(request.tenant);
        const row = await twoFactorRepo.challengeBySecretHash(db, hashSecret(secret), env.now());
        if (row !== undefined) await twoFactorRepo.takeChallenge(db, row.id);
      }
      clearChallengeCookie(reply, url);
      return reply.code(303).header('location', '/sign-in').header('cache-control', 'no-store').send();
    });

    // The page script's two calls: JSON and Origin-checked, for the cookie's challenge or, on the desktop's page,
    // its flow's.
    form.post('/sign-in/two-factor/passkey/options', async (request) => {
      guardPost(request);
      const row = await scriptChallenge(request);
      return signInOptions(env, request.tenant, request, row);
    });

    form.post('/sign-in/two-factor/passkey/verify', async (request, reply) => {
      const url = guardPost(request);
      const response = (request.body as { response?: unknown } | undefined)?.response;
      const answer = typeof response === 'object' && response !== null ? (response as Record<string, unknown>) : {};
      const row = await scriptChallenge(request);
      const source = auditSource(request);
      if (row.flowId !== null && row.loopbackPort !== null) {
        // The desktop's hand-off: a one-time grant for its loopback, which it trades with its PKCE verifier.
        const grant = await grantWithPasskey(env, request.tenant, request, source, row, answer);
        const loopback = new URL(`http://127.0.0.1:${String(row.loopbackPort)}/callback`);
        loopback.searchParams.set('flow', row.flowId);
        loopback.searchParams.set('grant', grant);
        return reply.header('cache-control', 'no-store').send({ location: loopback.href });
      }
      const mode: BrowserSignInMode = (request.body as { add?: unknown } | undefined)?.add === true ? 'add' : 'replace';
      // As the code form: *Add an account* past five is refused before the passkey is spent.
      if (!(await roomForSignIn(env, request, row.userId, mode)))
        return reply
          .code(409)
          .header('cache-control', 'no-store')
          .send({ code: 'identity-accounts-full', message: ACCOUNTS_FULL_MESSAGE });
      const signed = await signInWithPasskey(env, request.tenant, request, source, row, answer);
      clearChallengeCookie(reply, url);
      await placeBrowserSession(env, request, reply, row.userId, signed.token, mode, source);
      const location = safeRedirectPath(field(request.body, 'redirectTo'), url);
      return reply.header('cache-control', 'no-store').send({ location });
    });

    // The desktop's passkey page (spec §4.2), on the primary host where passkeys belong.
    form.get('/sign-in/two-factor/passkey', async (request, reply) => {
      const moved = onPrimaryHost(env.ctx.config, request, reply);
      if (moved !== undefined) return moved;
      const flow = flowOf(request);
      if (flow === undefined) return sendSignInPage(reply, env.ctx, { status: 400, message: FLOW_EXPIRED_MESSAGE });
      try {
        await flowChallenge(env, request, flow);
      } catch (error) {
        const refused = toProblem(error);
        if (refused.status >= 500) throw error;
        if (refused.retryAfter !== undefined) reply.header('retry-after', String(refused.retryAfter));
        return sendSignInPage(reply, env.ctx, { status: refused.status, message: FLOW_EXPIRED_MESSAGE });
      }
      return sendTwoFactorPage(reply, {
        serverUrl: urlOf(request),
        methods: ['passkey'],
        setup: false,
        redirectTo: '/',
        flow,
      });
    });
  };
