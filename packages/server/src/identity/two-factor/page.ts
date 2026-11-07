/**
 * The browser's second-step page (two-step sign-in spec §4.1), in the sign-in page's frame and under its headers:
 * static HTML, no script, every interpolated value escaped. A form for the authenticator code and, when the person
 * has codes left, one for a recovery code. The challenge itself is in the `wb_2fa` cookie, never in the page.
 */
import type { TwoFactorMethod } from '@wirebench/engine';
import type { FastifyReply } from 'fastify';
import { escapeHtml } from '../invite-page.js';
import { signInFrame, signInHeaders } from '../sign-in-page.js';

export interface TwoFactorPageInput {
  readonly serverUrl: string;
  readonly methods: readonly TwoFactorMethod[];
  /** No method yet, and the server requires one (spec §4.3). */
  readonly setup: boolean;
  /** Already checked by `safeRedirectPath`. */
  readonly redirectTo: string;
  readonly message?: string;
}

export const SETUP_IN_APP_MESSAGE =
  'This server requires two-step sign-in. Set it up in the Wirebench app first, then sign in here.';

export function renderTwoFactorPage(input: TwoFactorPageInput): string {
  const parts: string[] = [];
  if (input.message !== undefined) parts.push(`<p class="message" role="alert">${escapeHtml(input.message)}</p>`);
  if (input.setup) {
    parts.push(`<p>${escapeHtml(SETUP_IN_APP_MESSAGE)}</p><a class="method" href="/sign-in">Back to sign in</a>`);
    return signInFrame(input.serverUrl, parts.join('\n'));
  }
  const onward =
    input.redirectTo === '/' ? '' : `<input type="hidden" name="redirect_to" value="${escapeHtml(input.redirectTo)}">`;
  if (input.methods.includes('totp'))
    parts.push(`<form method="post" action="/sign-in/two-factor">
<input type="hidden" name="method" value="totp">${onward}
<label for="code">Enter the 6-digit code from your authenticator app.</label>
<input id="code" name="code" inputmode="numeric" pattern="[0-9 ]*" autocomplete="one-time-code" maxlength="8" required autofocus>
<button type="submit">Verify</button>
</form>`);
  if (input.methods.includes('recovery'))
    parts.push(`<form method="post" action="/sign-in/two-factor">
<input type="hidden" name="method" value="recovery">${onward}
<label for="recovery">Or use a recovery code</label>
<input id="recovery" name="code" autocomplete="off" spellcheck="false" maxlength="16" required>
<button type="submit">Use recovery code</button>
</form>`);
  parts.push('<a class="method" href="/sign-in">Cancel</a>');
  return signInFrame(input.serverUrl, parts.join('\n'));
}

export function sendTwoFactorPage(reply: FastifyReply, input: TwoFactorPageInput): FastifyReply {
  return signInHeaders(reply).send(renderTwoFactorPage(input));
}
