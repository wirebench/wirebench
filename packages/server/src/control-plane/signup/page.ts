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

/** What an unknown, expired or used link shows: one page for all three, so a token's state is not told. */
export function renderSignupExpired(): string {
  return page(
    'Link expired',
    `<h1>This link has expired</h1><p>Signup links work once, for 24 hours. <a href="/signup">Start again</a>.</p>`,
  );
}

export interface SignupSummary {
  readonly email: string;
  readonly name: string;
  /** `https://<slug>.<app-domain>`. */
  readonly teamUrl: string;
  readonly seats: number;
}

/** The price summary: the seats bought; Paddle's checkout shows the price and the tax for the buyer's country. */
function summary(input: SignupSummary): string {
  const seats = `${String(input.seats)} ${input.seats === 1 ? 'seat' : 'seats'}`;
  return `<dl><dt>Team</dt><dd>${escapeHtml(input.name)}</dd><dt>Address</dt><dd>${escapeHtml(input.teamUrl)}</dd>
<dt>Admin</dt><dd>${escapeHtml(input.email)}</dd><dt>Plan</dt><dd>Team, ${seats}, billed monthly</dd></dl>
<p class="hint">The checkout shows the price and any tax before you pay.</p>`;
}

export interface PasswordStepInput extends SignupSummary {
  /** The link's token, which the form posts back to. */
  readonly token: string;
  readonly minLength: number;
  readonly error?: string;
}

/** The password step: the first admin's password, and what will be bought. */
export function renderPasswordStep(input: PasswordStepInput): string {
  const error = input.error === undefined ? '' : `<p class="error" role="alert">${escapeHtml(input.error)}</p>`;
  return page(
    'Choose a password',
    `<h1>Choose your password</h1>${summary(input)}${error}
<form method="post" action="/signup/${escapeHtml(input.token)}">
<label for="password">Password (at least ${String(input.minLength)} characters)</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="${String(input.minLength)}" maxlength="1024" required>
<button type="submit">Continue to payment</button>
</form>`,
  );
}

/** Paddle.js, from Paddle's CDN only (spec §22.6): the only third-party script the server ever serves. */
export const PADDLE_JS = 'https://cdn.paddle.com/paddle/v2/paddle.js';

/** The origins the checkout overlay's frame and its requests use, per Paddle environment. */
export const PADDLE_ORIGINS = {
  sandbox: { frame: 'https://sandbox-buy.paddle.com', connect: 'https://sandbox-checkout-service.paddle.com' },
  production: { frame: 'https://buy.paddle.com', connect: 'https://checkout-service.paddle.com' },
} as const;

export type PaddleEnvironment = keyof typeof PADDLE_ORIGINS;

/**
 * The checkout page's policy, this page's only: scripts from Paddle's CDN and the one inline script carrying
 * `nonce`, never `'unsafe-inline'`; frames and requests to Paddle's checkout and this origin (the status poll).
 */
export function checkoutCsp(environment: PaddleEnvironment, nonce: string): string {
  const origins = PADDLE_ORIGINS[environment];
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' https://cdn.paddle.com`,
    "style-src 'unsafe-inline'",
    `frame-src ${origins.frame}`,
    `connect-src 'self' ${origins.connect}`,
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export interface CheckoutStepInput extends SignupSummary {
  readonly nonce: string;
  readonly environment: PaddleEnvironment;
  /** Paddle.js's client-side token: public by design (spec §22.5). */
  readonly clientToken: string;
  readonly priceId: string;
  /** The signups row id the server minted: the checkout's custom data, which the `created` event is matched by. */
  readonly signupId: string;
  /** `/signup/<token>/status`. */
  readonly statusPath: string;
}

/**
 * Opens Paddle's overlay with the Team price, the seats, the buyer's email and `customData: { signup }`, then polls
 * the status every 2 s and goes to the team's sign-in page once it is ready. Every value is read from the page's
 * escaped data attributes, so the script itself is the same bytes for every signup.
 */
const CHECKOUT_SCRIPT = `(function () {
  var d = document.getElementById('checkout').dataset;
  if (d.environment === 'sandbox') Paddle.Environment.set('sandbox');
  Paddle.Initialize({ token: d.token });
  function open() {
    Paddle.Checkout.open({
      items: [{ priceId: d.price, quantity: Number(d.seats) }],
      customer: { email: d.email },
      customData: { signup: d.signup }
    });
  }
  document.getElementById('pay').addEventListener('click', open);
  open();
  function poll() {
    fetch(d.status, { cache: 'no-store', credentials: 'omit' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (s.status === 'ready' && typeof s.url === 'string') { location.assign(s.url); return; }
        setTimeout(poll, 2000);
      }, function () { setTimeout(poll, 2000); });
  }
  setTimeout(poll, 2000);
})();`;

/** The checkout step (spec §22.6, step 3). */
export function renderCheckoutStep(input: CheckoutStepInput): string {
  const attr = (name: string, value: string): string => ` data-${name}="${escapeHtml(value)}"`;
  return page(
    'Payment',
    `<h1>Payment</h1>${summary(input)}
<p id="checkout"${attr('environment', input.environment)}${attr('token', input.clientToken)}${attr('price', input.priceId)}${attr('seats', String(input.seats))}${attr('email', input.email)}${attr('signup', input.signupId)}${attr('status', input.statusPath)} role="status">Your team is set up as soon as the payment goes through. This page then takes you to it.</p>
<button type="button" id="pay">Open the checkout</button>
<script src="${PADDLE_JS}" nonce="${input.nonce}"></script>
<script nonce="${input.nonce}">${CHECKOUT_SCRIPT}</script>`,
  );
}
