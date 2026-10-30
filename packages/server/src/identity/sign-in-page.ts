/**
 * The browser's sign-in page (hosted spec §17.2), in the invitation page's style: static HTML, no
 * script, no external asset. It lists the methods this server offers: a plain form for local
 * accounts, and a link for OIDC and SAML that starts the redirect flow. Every interpolated value
 * (display names an operator typed, the server's URL, `redirect_to`) is escaped.
 */
import type { FastifyReply } from 'fastify';
import type { ServerContext } from '../context.js';
import { tenantUrl } from '../tenancy/urls.js';
import { escapeHtml } from './invite-page.js';

/** The invitation page's policy, plus `form-action 'self'` for the form and no framing (clickjacking). */
export const SIGN_IN_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

export interface SignInPageInput {
  /** The tenant's URL, which the page names. */
  readonly serverUrl: string;
  readonly local: boolean;
  readonly oidc?: { readonly displayName: string };
  readonly saml?: { readonly displayName: string };
  /** Already checked by `safeRedirectPath`. */
  readonly redirectTo: string;
  /** Why the person is seeing the page again: a refused password, an expired flow. */
  readonly message?: string;
}

const STYLE =
  'body{font:15px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:24rem;padding:0 1rem;color:#222}' +
  'label{display:block;margin:.75rem 0 .25rem}input{box-sizing:border-box;width:100%;padding:.4rem;font:inherit}' +
  'button,a.method{display:block;box-sizing:border-box;width:100%;margin-top:1rem;padding:.5rem;font:inherit;text-align:center}' +
  '.message{color:#a00}code{word-break:break-all}';

export function renderSignInPage(input: SignInPageInput): string {
  const onward = input.redirectTo === '/' ? '' : `?redirect_to=${encodeURIComponent(input.redirectTo)}`;
  const parts: string[] = [];
  if (input.message !== undefined) parts.push(`<p class="message" role="alert">${escapeHtml(input.message)}</p>`);
  if (input.local) {
    parts.push(`<form method="post" action="/sign-in/local">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
${input.redirectTo === '/' ? '' : `<input type="hidden" name="redirect_to" value="${escapeHtml(input.redirectTo)}">`}
<button type="submit">Sign in</button>
</form>`);
  }
  if (input.oidc !== undefined)
    parts.push(
      `<a class="method" href="/sign-in/oidc${escapeHtml(onward)}">Continue with ${escapeHtml(input.oidc.displayName)}</a>`,
    );
  if (input.saml !== undefined)
    parts.push(
      `<a class="method" href="/sign-in/saml${escapeHtml(onward)}">Continue with ${escapeHtml(input.saml.displayName)}</a>`,
    );
  if (!input.local && input.oidc === undefined && input.saml === undefined)
    parts.push('<p>This server offers no way to sign in from a browser. Ask a server admin.</p>');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · Wirebench Server</title>
<style>${STYLE}</style>
</head><body><h1>Sign in</h1><p>Wirebench Server at <code>${escapeHtml(input.serverUrl)}</code></p>${parts.join('\n')}</body></html>`;
}

/**
 * Sends the page with the methods offered right now. SAML is listed only while the license carries
 * `sso-provisioning`, which is checked per request because a license can be installed at any time.
 */
export async function sendSignInPage(
  reply: FastifyReply,
  ctx: Pick<ServerContext, 'config' | 'meta' | 'license'>,
  options: { readonly status?: number; readonly message?: string; readonly redirectTo?: string } = {},
): Promise<FastifyReply> {
  const methods = ctx.meta.signInMethods();
  const samlLicensed = methods.saml === true && (await ctx.license.state()).features.includes('sso-provisioning');
  const html = renderSignInPage({
    serverUrl: tenantUrl(ctx.config, reply.request),
    local: methods.local,
    ...(methods.oidc ? { oidc: { displayName: methods.oidcDisplayName ?? 'OIDC' } } : {}),
    ...(samlLicensed ? { saml: { displayName: methods.samlDisplayName ?? 'SSO' } } : {}),
    redirectTo: options.redirectTo ?? '/',
    ...(options.message !== undefined ? { message: options.message } : {}),
  });
  // Not `no-referrer`: under it a browser sends `Origin: null` on the form's own POST, which the
  // login-CSRF check must refuse. `same-origin` still keeps the URL from every other site.
  return reply
    .code(options.status ?? 200)
    .header('content-security-policy', SIGN_IN_PAGE_CSP)
    .header('referrer-policy', 'same-origin')
    .header('cache-control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(html);
}
