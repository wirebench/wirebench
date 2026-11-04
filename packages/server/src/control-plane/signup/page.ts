/**
 * The signup's pages (hosted edition spec §22.6), in the entry page's style (§21.4): server-rendered, every value
 * escaped, so a team's name is never markup; no cookie at any step. The form and its answer use the sign-in page's
 * policy: no script, the form posts to this origin, and nothing frames it.
 */
import { ENTRY_PAGE_STYLE } from '../../entry/page.js';
import { escapeHtml } from '../../identity/invite-page.js';
import { SIGN_IN_PAGE_CSP } from '../../identity/sign-in-page.js';
import { SIGNUP_MAX_SEATS } from './repo.js';

/** The form's and the answer's policy: the sign-in page's. */
export const SIGNUP_PAGE_CSP = SIGN_IN_PAGE_CSP;

/** What every successful post, and every post over a rate limit, answers. */
export const SIGNUP_SENT = 'Check your inbox: we sent you a link to finish signing up.';

const STYLE = `${ENTRY_PAGE_STYLE}.error{color:#a00;font-weight:600}.hint{color:#555;font-size:.9em}`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Wirebench</title>
<style>${STYLE}</style>
</head><body>${body}</body></html>`;
}

/** What the form was sent, put back when it is shown again. */
export interface SignupFormValues {
  readonly email?: string;
  readonly name?: string;
  readonly slug?: string;
  readonly seats?: string;
}

export interface SignupFormInput {
  /** `<app-domain>`, which the slug's field names as the team's address. */
  readonly appDomain: string;
  readonly values?: SignupFormValues;
  /** Why the last post was refused. */
  readonly error?: string;
}

export function renderSignupForm(input: SignupFormInput): string {
  const v = input.values ?? {};
  const value = (text: string | undefined): string => (text === undefined ? '' : ` value="${escapeHtml(text)}"`);
  const error = input.error === undefined ? '' : `<p class="error" role="alert">${escapeHtml(input.error)}</p>`;
  return page(
    'Sign up',
    `<h1>Start a Wirebench team</h1>${error}
<form method="post" action="/signup">
<label for="email">Your email</label><input id="email" name="email" type="email" autocomplete="email" maxlength="254" required${value(v.email)}>
<label for="name">Team name</label><input id="name" name="name" maxlength="80" required${value(v.name)}>
<label for="slug">Team address</label><input id="slug" name="slug" maxlength="40" autocapitalize="none" required${value(v.slug)}>
<p class="hint">Your team will be at https://&lt;address&gt;.${escapeHtml(input.appDomain)}</p>
<label for="seats">Seats</label><input id="seats" name="seats" type="number" min="1" max="${String(SIGNUP_MAX_SEATS)}" required${value(v.seats ?? '1')}>
<button type="submit">Email me a link</button>
</form>`,
  );
}

/** The answer to every accepted post: whether or not the address already has teams, or was over a limit. */
export function renderSignupSent(): string {
  return page(
    'Check your inbox',
    `<h1>Check your inbox</h1><p class="answer" role="status">${escapeHtml(SIGNUP_SENT)}</p>`,
  );
}
