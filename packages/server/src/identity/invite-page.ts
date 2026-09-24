/**
 * The one page the server renders (§3.1): static text, no script, no external asset, and the
 * only interpolated values are the server's own origin, the admin-typed email and the secret
 * that is already in the URL. Everything is escaped anyway.
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

export type InvitePageInput =
  | { readonly publicUrl: string; readonly state: 'open'; readonly email: string; readonly secret: string }
  | { readonly publicUrl: string; readonly state: 'closed' };

/** Sent with every invitation page: the page needs nothing but its own inline style. */
export const INVITE_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'";

export function renderInvitePage(input: InvitePageInput): string {
  const body =
    input.state === 'open'
      ? `<p>You have been invited to Wirebench Server at <code>${escapeHtml(input.publicUrl)}</code> as <strong>${escapeHtml(input.email)}</strong>.</p>
<ol>
<li>Install Wirebench.</li>
<li>Choose <em>Sign in…</em> from the command palette.</li>
<li>Enter the server URL: <code>${escapeHtml(input.publicUrl)}</code></li>
<li>Enter this invitation code: <code>${escapeHtml(input.secret)}</code></li>
</ol>`
      : `<p>You have been invited to Wirebench Server at <code>${escapeHtml(input.publicUrl)}</code>.</p>
<p>This invitation has expired or was already used. Ask a server admin for a new one.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Wirebench Server</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:36rem;padding:0 1rem;color:#222}code{word-break:break-all}</style>
</head><body><h1>Wirebench Server</h1>${body}</body></html>`;
}

/** What the browser sees after the IdP redirect: one line, then it is the desktop's turn. */
export function renderReturnPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Wirebench Server</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:36rem;padding:0 1rem;color:#222}</style>
</head><body><h1>Wirebench Server</h1><p>${escapeHtml(message)}</p></body></html>`;
}
