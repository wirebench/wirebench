/**
 * The browser's second step (two-step sign-in spec §4.1): the code page a correct password leads to, and its form.
 * The challenge's secret rides in the `wb_2fa` cookie, never in the page. Registered inside the sign-in forms' scope
 * (`browser-sign-in.ts`), under the same parser and body limit, and with the same Origin check against login CSRF.
 */
import type { TwoFactorMethod } from '@wirebench/engine';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { auditSource } from '../../context.js';
import { toProblem } from '../../problem.js';
import { tenantUrl } from '../../tenancy/urls.js';
import { endPresentedSession, safeRedirectPath } from '../browser-flows.js';
import { challengeCookie, clearChallengeCookie, setChallengeCookie, setSessionCookie } from '../cookies.js';
import { identitySettings, type IdentityEnv } from '../env.js';
import { methodDisabled, originRefused } from '../errors.js';
import { sendSignInPage } from '../sign-in-page.js';
import { methodList, presentedChallenge, verifyCode, type TwoFactorChallenge } from '../two-factor/gate.js';
import { sendTwoFactorPage } from '../two-factor/page.js';
import * as twoFactorRepo from '../two-factor/repo.js';

const MAX_FIELD_LENGTH = 1024;
const field = (body: unknown, name: string): string | undefined => {
  const value = (body as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' && value !== '' && value.length <= MAX_FIELD_LENGTH ? value : undefined;
};

/** What the sign-in page says when the second step can no longer be finished. */
export const TWO_FACTOR_EXPIRED_MESSAGE = 'This sign-in has expired. Sign in again.';

/**
 * After a correct password in the browser: keeps the challenge in its cookie and answers the second step's page.
 * A setup challenge (no method yet, and the server requires one, spec §4.3) gets the page's setup notice.
 */
export function sendTwoFactorStep(
  env: Pick<IdentityEnv, 'ctx'>,
  reply: FastifyReply,
  challenge: TwoFactorChallenge,
  redirectTo: string,
): FastifyReply {
  const url = tenantUrl(env.ctx.config, reply.request);
  setChallengeCookie(reply, url, challenge.secret);
  return sendTwoFactorPage(reply, { serverUrl: url, methods: challenge.methods, setup: challenge.setup, redirectTo });
}

export const browserTwoFactorRoutes =
  (env: IdentityEnv, bodyLimit: number) =>
  (form: FastifyInstance): void => {
    /** Back to the sign-in page, the challenge cookie dropped: it can no longer be finished. */
    const startAgain = (reply: FastifyReply, url: string, redirectTo: string, status: number, message: string) => {
      clearChallengeCookie(reply, url);
      return sendSignInPage(reply, env.ctx, { status, message, redirectTo });
    };

    form.post('/sign-in/two-factor', { bodyLimit }, async (request, reply) => {
      if (!env.settings.local) throw methodDisabled();
      const url = tenantUrl(env.ctx.config, request);
      if (request.headers.origin !== url) throw originRefused();
      const redirectTo = safeRedirectPath(field(request.body, 'redirect_to'), url);
      const secret = challengeCookie(request, url);
      if (secret === undefined) return startAgain(reply, url, redirectTo, 401, TWO_FACTOR_EXPIRED_MESSAGE);
      const method = field(request.body, 'method') === 'recovery' ? 'recovery' : 'totp';
      const source = auditSource(request);
      // Until the challenge is found, the page offers what any person with two-step sign-in may have.
      let methods: readonly TwoFactorMethod[] = ['totp', 'recovery'];
      try {
        const row = await presentedChallenge(env, request, secret, 'browser');
        methods = methodList(await twoFactorRepo.methodsOf(env.ctx.tenancy.db(request.tenant), row.userId));
        const signed = await verifyCode(env, request.tenant, source, row, method, field(request.body, 'code') ?? '');
        await endPresentedSession(env, request, source);
        clearChallengeCookie(reply, url);
        setSessionCookie(reply, url, signed.token, Math.floor(identitySettings(env.ctx.config).tokenMaxMs / 1000));
        return await reply.code(303).header('location', redirectTo).header('cache-control', 'no-store').send();
      } catch (error) {
        const refused = toProblem(error);
        if (refused.body.code === 'identity-two-factor-expired')
          return startAgain(reply, url, redirectTo, refused.status, TWO_FACTOR_EXPIRED_MESSAGE);
        if (refused.body.code === 'identity-user-disabled')
          return startAgain(reply, url, redirectTo, refused.status, refused.body.message);
        if (refused.status >= 500) throw error;
        if (refused.retryAfter !== undefined) reply.header('retry-after', String(refused.retryAfter));
        return sendTwoFactorPage(reply.code(refused.status), {
          serverUrl: url,
          methods,
          setup: false,
          redirectTo,
          message: refused.body.message,
        });
      }
    });
  };
