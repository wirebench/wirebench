/**
 * `POST /invite/:secret`: the invitation page's own form, which accepts an invitation in the browser
 * (team management in the browser §2.3). Registered in the browser sign-in routes' form scope, so only
 * when `WIREBENCH_SERVER_BROWSER_CLIENT` is on. It runs the desktop accept's claim (`claimInvitation`:
 * the one conditional `UPDATE`, the seat check, the hooks), then signs the browser in as the sign-in
 * form does and sends it to `/`. The password is whatever the person typed; nothing here chooses one.
 */
import { MAX_DISPLAY_NAME_LENGTH, MAX_PASSWORD_LENGTH, SECRET_PATTERN, isWirebenchError } from '@wirebench/engine';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditSource } from '../../context.js';
import { toProblem } from '../../problem.js';
import { tenantUrl } from '../../tenancy/urls.js';
import { finishBrowserSignIn } from '../browser-flows.js';
import type { IdentityEnv } from '../env.js';
import { originRefused } from '../errors.js';
import { claimInvitation, openInvitationBySecret } from '../invitations.js';
import { ipKey, rateLimit } from '../rate-limit.js';
import { browserAcceptFor, sendInvitePage } from './invite-page.js';

const text = (body: unknown, name: string, max: number): string | undefined => {
  const value = (body as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' && value.length <= max ? value : undefined;
};

/** Mounted on the form scope of `browserSignInRoutes`, which parses `application/x-www-form-urlencoded`. */
export const browserInviteRoutes =
  (env: IdentityEnv, bodyLimit: number) =>
  (form: FastifyInstance): void => {
    form.post(
      '/invite/:secret',
      // The same per-address bucket as the desktop's `POST /invitations/accept`.
      { bodyLimit, preHandler: [rateLimit(env, (request) => [ipKey(request)])] },
      async (request, reply) => {
        // Another site's form must not create an account, or set a password, in this browser's name.
        const url = tenantUrl(env.ctx.config, request);
        if (request.headers.origin !== url) throw originRefused();
        const { secret } = request.params as { secret: string };
        if (!SECRET_PATTERN.test(secret)) return reply.code(404).send({ code: 'not-found', message: 'No such page.' });
        const password = text(request.body, 'password', MAX_PASSWORD_LENGTH) ?? '';
        const confirm = text(request.body, 'confirm', MAX_PASSWORD_LENGTH) ?? '';
        const displayName = (text(request.body, 'displayName', MAX_DISPLAY_NAME_LENGTH) ?? '').trim();

        const again = async (status: number, message: string): Promise<FastifyReply> =>
          sendAgain(env, request, reply, secret, status, message, displayName);

        if (password === '') return again(400, 'Enter a password.');
        if (password !== confirm) return again(400, 'The two passwords do not match.');
        const source = auditSource(request);
        let user;
        try {
          user = await claimInvitation(env, request.tenant, { secret, password, displayName }, source);
        } catch (error) {
          if (!isWirebenchError(error)) throw error;
          if (error.code === 'identity-invitation-invalid')
            return sendInvitePage(reply, 404, { serverUrl: url, state: 'closed' });
          return again(toProblem(error).status, error.message);
        }
        return finishBrowserSignIn(env, request, reply, user, 'local', source, '/');
      },
    );
  };

/** The open page again with `message`, or the closed one when the invitation is no longer open. */
async function sendAgain(
  env: IdentityEnv,
  request: FastifyRequest,
  reply: FastifyReply,
  secret: string,
  status: number,
  message: string,
  displayName: string,
): Promise<FastifyReply> {
  const serverUrl = tenantUrl(env.ctx.config, request);
  const row = await openInvitationBySecret(env, request.tenant, secret);
  if (row === undefined) return sendInvitePage(reply, 404, { serverUrl, state: 'closed' });
  return sendInvitePage(reply, status, {
    serverUrl,
    state: 'open',
    email: row.email,
    secret,
    browser: await browserAcceptFor(env, request, row, {
      message,
      ...(displayName !== '' ? { displayName } : {}),
    }),
  });
}
