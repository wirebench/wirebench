import { SECRET_PATTERN } from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import type { IdentityEnv } from '../env.js';
import { openInvitationBySecret } from '../invitations.js';
import { INVITE_PAGE_CSP, renderInvitePage } from '../invite-page.js';

/** `GET /invite/:secret` at the root (via `registerPublic`): a browser's landing from the link. */
export const invitePageRoutes =
  (env: IdentityEnv) =>
  (app: FastifyInstance): void => {
    app.get('/invite/:secret', async (request, reply) => {
      const { secret } = request.params as { secret: string };
      if (!SECRET_PATTERN.test(secret)) return reply.code(404).send({ code: 'not-found', message: 'No such page.' });
      const publicUrl = env.ctx.config.publicUrl;
      const row = await openInvitationBySecret(env, secret);
      const html =
        row === undefined
          ? renderInvitePage({ publicUrl, state: 'closed' })
          : renderInvitePage({ publicUrl, state: 'open', email: row.email, secret });
      return reply
        .header('content-security-policy', INVITE_PAGE_CSP)
        .header('referrer-policy', 'no-referrer')
        .header('cache-control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(html);
    });
  };
