/**
 * The browser's second-step page (two-step sign-in spec §4.1), in the sign-in page's frame: every interpolated value
 * escaped, the challenge itself in the `wb_2fa` cookie, never in the page. *Use a passkey* runs through the page's one
 * script; the code forms are plain posts and work without it. The desktop's passkey hand-off (§4.2) gets the same page
 * with the passkey alone.
 */
import type { TwoFactorMethod } from '@wirebench/engine';
import type { FastifyReply } from 'fastify';
import { escapeHtml } from '../invite-page.js';
import { SIGN_IN_PAGE_CSP, signInFrame, signInHeaders } from '../sign-in-page.js';
import { TWO_FACTOR_SCRIPT_PATH } from './page-script.js';

/** The sign-in page's policy, plus the one script and the calls it makes to this server. */
export const TWO_FACTOR_PAGE_CSP = `${SIGN_IN_PAGE_CSP}; script-src 'self'; connect-src 'self'`;

export interface TwoFactorPageInput {
  readonly serverUrl: string;
  readonly methods: readonly TwoFactorMethod[];
  /** No method yet, and the server requires one (spec §4.3). */
  readonly setup: boolean;
  /** Already checked by `safeRedirectPath`. */
  readonly redirectTo: string;
  readonly message?: string;
  /** Shown once fewer than three remain (spec §4.1). */
  readonly attemptsLeft?: number;
  /**
   * Where a passkey works (plan ruling 3): `undefined` on the primary host, else the primary URL the page links to,
   * since a passkey belongs to the primary host's relying party.
   */
  readonly passkeyAt?: string;
  /** The desktop's hand-off (spec §4.2): the passkey alone, for this flow. */
  readonly flow?: string;
}

export const SETUP_IN_APP_MESSAGE =
  'This server requires two-step sign-in. Set it up in the Wirebench app first, then sign in here.';

function passkeyPart(input: TwoFactorPageInput): string {
  if (input.passkeyAt !== undefined) {
    const url = escapeHtml(input.passkeyAt);
    return `<p>To use a passkey, sign in at <a href="${url}/sign-in">${url}</a>.</p>`;
  }
  const flow = input.flow !== undefined ? ` data-flow="${escapeHtml(input.flow)}"` : '';
  return `<button type="button" id="passkey"${flow} data-redirect="${escapeHtml(input.redirectTo)}">Use a passkey</button>
<p id="passkey-status" class="message" role="status"></p>`;
}

export function renderTwoFactorPage(input: TwoFactorPageInput): string {
  const parts: string[] = ['<h2>Two-step sign-in</h2>'];
  if (input.message !== undefined) {
    const left =
      input.attemptsLeft !== undefined && input.attemptsLeft < 3
        ? ` ${String(input.attemptsLeft)} ${input.attemptsLeft === 1 ? 'attempt' : 'attempts'} left.`
        : '';
    parts.push(`<p class="message" role="alert">${escapeHtml(input.message + left)}</p>`);
  }
  if (input.setup) {
    parts.push(`<p>${escapeHtml(SETUP_IN_APP_MESSAGE)}</p><a class="method" href="/sign-in">Back to sign in</a>`);
    return signInFrame(input.serverUrl, parts.join('\n'));
  }
  if (input.flow !== undefined) {
    parts.push('<p>Use your passkey to finish signing in to Wirebench.</p>', passkeyPart(input));
    return withScript(signInFrame(input.serverUrl, parts.join('\n')));
  }
  const onward =
    input.redirectTo === '/' ? '' : `<input type="hidden" name="redirect_to" value="${escapeHtml(input.redirectTo)}">`;
  if (input.methods.includes('passkey')) parts.push(passkeyPart(input));
  if (input.methods.includes('totp'))
    parts.push(`<form method="post" action="/sign-in/two-factor">
<input type="hidden" name="method" value="totp">${onward}
<label for="code">Enter the 6-digit code from your authenticator app.</label>
<input id="code" name="code" inputmode="numeric" pattern="[0-9 ]*" autocomplete="one-time-code" maxlength="8" required autofocus>
<button type="submit">Verify</button>
</form>`);
  if (input.methods.includes('recovery'))
    parts.push(`<details${input.methods.includes('totp') ? '' : ' open'}><summary>Use a recovery code instead</summary>
<form method="post" action="/sign-in/two-factor">
<input type="hidden" name="method" value="recovery">${onward}
<label for="recovery">Recovery code</label>
<input id="recovery" name="code" autocomplete="off" spellcheck="false" maxlength="16" required>
<button type="submit">Use recovery code</button>
</form></details>`);
  parts.push('<form method="post" action="/sign-in/two-factor/cancel"><button type="submit">Cancel</button></form>');
  const page = signInFrame(input.serverUrl, parts.join('\n'));
  return input.methods.includes('passkey') && input.passkeyAt === undefined ? withScript(page) : page;
}

const withScript = (page: string): string =>
  page.replace('</body>', `<script src="${TWO_FACTOR_SCRIPT_PATH}"></script></body>`);

/** Sends the page under the sign-in page's headers, its policy widened to the one script. */
export function sendTwoFactorPage(reply: FastifyReply, input: TwoFactorPageInput): FastifyReply {
  return signInHeaders(reply).header('content-security-policy', TWO_FACTOR_PAGE_CSP).send(renderTwoFactorPage(input));
}
