import { SECRET_PATTERN } from '@wirebench/engine';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IdentityEnv } from '../env.js';
import { openInvitationBySecret } from '../invitations.js';
import { INVITE_FORM_CSP, INVITE_PAGE_CSP, renderInvitePage, type BrowserAccept } from '../invite-page.js';
import { ipKey, rateLimit } from '../rate-limit.js';
import type { InvitationRow } from '../repo.js';
import { tenantUrl } from '../../tenancy/urls.js';

/**
 * What the browser's accept offers for `row` right now (team management in the browser §2.3): the form
 * while local sign-in is on, and the federated methods the tenant offers, SAML only while licensed, as the
 * sign-in page lists them.
 */
export async function browserAcceptFor(
  env: IdentityEnv,
  request: FastifyRequest,
  row: InvitationRow,
  extra: Pick<BrowserAccept, 'message' | 'displayName'> = {},
): Promise<BrowserAccept> {
  const methods = await env.ctx.meta.signInMethodsFor(request);
  const samlLicensed =
    methods.saml === true && (await env.ctx.license.state(request.tenant)).features.includes('sso-provisioning');
  return {
    kind: row.kind,
    local: env.settings.local,
    ...(methods.oidc ? { oidc: { displayName: methods.oidcDisplayName ?? 'OIDC' } } : {}),
    ...(samlLicensed ? { saml: { displayName: methods.samlDisplayName ?? 'SSO' } } : {}),
    ...extra,
  };
}

/**
 * Sends the invitation page. The browser's variant goes out under the sign-in page's headers: its policy allows
 * the form, and its referrer policy is `same-origin`, because under `no-referrer` a browser posts the form with
 * `Origin: null`, which the form's Origin check refuses. `same-origin` still keeps the secret in the URL from
 * every other site. The desktop-only variant keeps `no-referrer`, as it always had.
 */
export function sendInvitePage(
  reply: FastifyReply,
  status: number,
  input: Parameters<typeof renderInvitePage>[0],
): FastifyReply {
  const browser = input.state === 'open' && input.browser !== undefined;
  return reply
    .code(status)
    .header('content-security-policy', browser ? INVITE_FORM_CSP : INVITE_PAGE_CSP)
    .header('referrer-policy', browser ? 'same-origin' : 'no-referrer')
    .header('cache-control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(renderInvitePage(input));
}

/** `GET /invite/:secret` at the root (via `registerPublic`): a browser's landing from the link. */
export const invitePageRoutes =
  (env: IdentityEnv) =>
  (app: FastifyInstance): void => {
    app.get(
      '/invite/:secret',
      { preHandler: [rateLimit(env, (request) => [ipKey(request)])] },
      async (request, reply) => {
        const { secret } = request.params as { secret: string };
        if (!SECRET_PATTERN.test(secret)) return reply.code(404).send({ code: 'not-found', message: 'No such page.' });
        const serverUrl = tenantUrl(env.ctx.config, request);
        const row = await openInvitationBySecret(env, request.tenant, secret);
        if (row === undefined) return sendInvitePage(reply, 200, { serverUrl, state: 'closed' });
        return sendInvitePage(reply, 200, {
          serverUrl,
          state: 'open',
          email: row.email,
          secret,
          browser: await browserAcceptFor(env, request, row),
        });
      },
    );
  };
