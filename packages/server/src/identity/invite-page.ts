import { MAX_DISPLAY_NAME_LENGTH, MIN_PASSWORD_LENGTH } from '@wirebench/engine';

/**
 * The invitation page (§3.1): static text, no script, no external asset, and the
 * only interpolated values are the server's own origin, the admin-typed email, the secret that is
 * already in the URL, provider display names and what the person typed. Everything is escaped.
 * It also carries the browser's accept form (team management in the browser §2.3).
 */
const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

/**
 * What the page offers a browser (team management in the browser §2.3):
 * a password form when local sign-in is on, and, for an `invite`, the federated methods whose first
 * sign-in with the invited email creates the account.
 */
export interface BrowserAccept {
  /** `reset` is the same table's password reset: the form sets a new password, nothing else. */
  readonly kind: 'invite' | 'reset';
  readonly local: boolean;
  readonly oidc?: { readonly displayName: string };
  readonly saml?: { readonly displayName: string };
  /** Why the person sees the page again: a refused password, no free seat. */
  readonly message?: string;
  /** What they typed as their name before a refusal, so they need not type it again. */
  readonly displayName?: string;
}

export type InvitePageInput =
  | {
      readonly serverUrl: string;
      readonly state: 'open';
      readonly email: string;
      readonly secret: string;
      readonly browser?: BrowserAccept;
    }
  | { readonly serverUrl: string; readonly state: 'closed' };

/** Sent with every invitation page: the page needs nothing but its own inline style. */
export const INVITE_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'";

/** The page with the browser's form: the sign-in page's policy, which adds `form-action 'self'` and no framing. */
export const INVITE_FORM_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

/** The shortest password the server takes (identity spec §3.1), said on the form before it is refused. */
const PASSWORD_HINT = `At least ${MIN_PASSWORD_LENGTH} characters.`;

const STYLE =
  'body{font:15px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:36rem;padding:0 1rem;color:#222}code{word-break:break-all}' +
  'label{display:block;margin:.75rem 0 .25rem}input{box-sizing:border-box;width:100%;padding:.4rem;font:inherit}' +
  'button,a.method{display:block;box-sizing:border-box;width:100%;margin-top:1rem;padding:.5rem;font:inherit;text-align:center}' +
  '.message{color:#a00}.hint{color:#555;font-size:13px;margin:.25rem 0 0}';

function desktopSteps(serverUrl: string, secret: string): string {
  return `<ol>
<li>Install Wirebench.</li>
<li>Choose <em>Sign in…</em> from the command palette.</li>
<li>Enter the server URL: <code>${escapeHtml(serverUrl)}</code></li>
<li>Enter this invitation code: <code>${escapeHtml(secret)}</code></li>
</ol>`;
}

function browserBody(serverUrl: string, email: string, secret: string, browser: BrowserAccept): string {
  const reset = browser.kind === 'reset';
  const parts: string[] = [
    reset
      ? `<p>Set a new password for <strong>${escapeHtml(email)}</strong> on Wirebench Server at <code>${escapeHtml(serverUrl)}</code>.</p>`
      : `<p>You have been invited to Wirebench Server at <code>${escapeHtml(serverUrl)}</code> as <strong>${escapeHtml(email)}</strong>.</p>`,
  ];
  if (browser.message !== undefined) parts.push(`<p class="message" role="alert">${escapeHtml(browser.message)}</p>`);
  const federated = reset
    ? []
    : [browser.oidc, browser.saml].filter((method): method is { displayName: string } => method !== undefined);
  if (browser.local || federated.length > 0)
    parts.push(`<h2>${reset ? 'Set a new password' : 'Join in your browser'}</h2>`);
  if (browser.local) {
    const name = reset
      ? ''
      : `<label for="display-name">Your name</label><input id="display-name" name="displayName" autocomplete="name" maxlength="${MAX_DISPLAY_NAME_LENGTH}" value="${escapeHtml(browser.displayName ?? '')}">
`;
    parts.push(`<form method="post" action="/invite/${escapeHtml(secret)}">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" value="${escapeHtml(email)}" readonly>
${name}<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required>
<label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required>
<p class="hint">${escapeHtml(PASSWORD_HINT)}</p>
<button type="submit">${reset ? 'Set password and sign in' : 'Create account and sign in'}</button>
</form>`);
  }
  if (browser.oidc !== undefined && !reset)
    parts.push(`<a class="method" href="/sign-in/oidc">Continue with ${escapeHtml(browser.oidc.displayName)}</a>`);
  if (browser.saml !== undefined && !reset)
    parts.push(`<a class="method" href="/sign-in/saml">Continue with ${escapeHtml(browser.saml.displayName)}</a>`);
  if (federated.length > 0)
    parts.push(`<p class="hint">Sign in with the account for <strong>${escapeHtml(email)}</strong>.</p>`);
  parts.push(
    browser.local || federated.length > 0
      ? '<h2>Or use the desktop app</h2>'
      : '<p>To accept, use the desktop app:</p>',
  );
  parts.push(desktopSteps(serverUrl, secret));
  return parts.join('\n');
}

export function renderInvitePage(input: InvitePageInput): string {
  const body =
    input.state === 'open'
      ? input.browser !== undefined
        ? browserBody(input.serverUrl, input.email, input.secret, input.browser)
        : `<p>You have been invited to Wirebench Server at <code>${escapeHtml(input.serverUrl)}</code> as <strong>${escapeHtml(input.email)}</strong>.</p>
${desktopSteps(input.serverUrl, input.secret)}`
      : `<p>You have been invited to Wirebench Server at <code>${escapeHtml(input.serverUrl)}</code>.</p>
<p>This invitation has expired or was already used. Ask a server admin for a new one.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wirebench Server</title>
<style>${STYLE}</style>
</head><body><h1>Wirebench Server</h1>${body}</body></html>`;
}

/** What the browser sees after the IdP redirect: one line, then it is the desktop's turn. */
export function renderReturnPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Wirebench Server</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:36rem;padding:0 1rem;color:#222}</style>
</head><body><h1>Wirebench Server</h1><p>${escapeHtml(message)}</p></body></html>`;
}
