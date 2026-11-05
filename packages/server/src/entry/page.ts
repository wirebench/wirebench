/**
 * The entry's page (hosted edition spec §21.4), in the sign-in page's style: static HTML, no script, no external
 * asset, no cookie. One email field and one button; after a post, the one answer every input gets.
 */
import { escapeHtml } from '../identity/invite-page.js';
import { SIGN_IN_PAGE_CSP } from '../identity/sign-in-page.js';

/** The sign-in page's policy: the form posts to this page and nothing frames it. */
export const ENTRY_PAGE_CSP = SIGN_IN_PAGE_CSP;

/** What the page says after any post: whether or not the address has a team, and whether it was valid. */
export const ENTRY_ANSWER = 'If that address has a team, a message is on its way.';

export const ENTRY_PAGE_STYLE =
  'body{font:15px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:24rem;padding:0 1rem;color:#222}' +
  'label{display:block;margin:.75rem 0 .25rem}input{box-sizing:border-box;width:100%;padding:.4rem;font:inherit}' +
  'button{display:block;box-sizing:border-box;width:100%;margin-top:1rem;padding:.5rem;font:inherit}' +
  '.answer{font-weight:600}';

export interface EntryPageInput {
  /** `https://<site-domain>/`. */
  readonly siteUrl: string;
  /** Set after a post: the one answer. */
  readonly answered: boolean;
}

export function renderEntryPage(input: EntryPageInput): string {
  const answer = input.answered ? `<p class="answer" role="status">${escapeHtml(ENTRY_ANSWER)}</p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Find your team · Wirebench</title>
<style>${ENTRY_PAGE_STYLE}</style>
</head><body><h1>Find your team</h1><p>Enter your email address and we will send you a link to each team you belong to.</p>${answer}
<form method="post" action="/">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" maxlength="254" required>
<button type="submit">Email me my teams</button>
</form>
<p><a href="${escapeHtml(input.siteUrl)}">About Wirebench</a></p></body></html>`;
}
