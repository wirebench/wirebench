# Manual tests: the first Paddle sandbox run (#829)

CI runs signup to deletion against a fake Paddle: webhook fixtures signed with a placeholder secret, as Paddle
documents its `Paddle-Signature` header (`packages/server/test/integration/control-plane/hosted-e2e.test.ts`, CI's
`hosted-e2e` job). Nothing there loads Paddle.js or reaches Paddle. These rows check the same path against Paddle's
sandbox, which needs a Paddle account, a registered `<app-domain>` and the hosted deployment recipe
(`packages/server/deploy/hosted/`) running on it. None of these exists yet, so run them once an account does, before
the first real customer.

Use the sandbox only: a `test_…` client token, a `pri_…` sandbox price, a sandbox notification destination and
Paddle's published test cards. Never put a key in a ticket, a log excerpt or this file: record results only. Record the
date, the server version and the result of each row, and file an issue for any failure.

## Setup

1. In the sandbox dashboard, create the Team product with a per-seat monthly price, a client-side token, the approved
   checkout domain `https://app.<app-domain>`, and a notification destination for
   `https://app.<app-domain>/billing/paddle` with every `subscription.*` event.
2. Fill `.env` (`PADDLE_ENVIRONMENT=sandbox`, the token, the price) and `secrets/paddle_webhook_secret` (mode 600) as
   the recipe's README says, then `docker compose up -d`.

## The checkout page's policy

The checkout page's Content-Security-Policy (`checkoutCsp` in `control-plane/signup/page.ts`) allows Paddle.js from
`https://cdn.paddle.com`, frames from `https://sandbox-buy.paddle.com` and requests to
`https://sandbox-checkout-service.paddle.com` (production: `buy.paddle.com`, `checkout-service.paddle.com`). These
origins are taken from Paddle's documentation and are **unverified**: no checkout has run under the policy. P2 to P4
verify them; a violation means the list in `PADDLE_ORIGINS` changes, and the production origins need the same check on
the first production checkout.

| #   | Step                                                                                                    | Expected                                                                                                   | Result |
| --- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------ |
| P0  | `docker compose run --rm server config check`                                                           | Every variable `set` or `defaulted`; none of `WIREBENCH_SERVER_OIDC_*`, `_SAML_*`, `_AUDIT_FORWARD_*` set  | —      |
| P1  | Open `https://app.<app-domain>/signup`, fill the form, open the mailed link and choose a password       | The checkout page, with the team's name, slug and seats                                                    | —      |
| P2  | With the browser's developer tools open on the Console and Network tabs, wait for the overlay to load  | Paddle's overlay opens; **no** Content-Security-Policy violation in the console                            | —      |
| P3  | Note every origin the page loaded a script from, framed, or sent a request to (Network tab)             | Only this origin, `cdn.paddle.com`, and the sandbox frame and checkout-service origins above              | —      |
| P4  | For any violation in P2, record the directive (`script-src`, `frame-src`, `connect-src`, `img-src`, `style-src`) and the blocked origin | None; otherwise file it with the directive and origin, and no key or token from the page | — |
| P5  | Pay with Paddle's published test card for a successful payment                                         | The overlay completes; the page polls and moves to "ready" with a link to `https://<slug>.<app-domain>/sign-in` | — |
| P6  | `docker compose logs server` around the payment                                                         | One webhook line answered 200, naming no header, token or secret; `admin tenant list` shows the team `team` | — |
| P7  | Sign in at the link with the email and password from P1                                                 | Signed in as the team's server admin                                                                       | —      |
| P8  | In Paddle's customer portal (the email Paddle sent), change the seats                                   | A `subscription.updated` arrives; `admin tenant list` shows the new seat count                             | —      |
| P9  | In the sandbox dashboard, resend the last notification                                                  | Answered 200, applied once: nothing changes (the event id is recorded)                                     | —      |
| P10 | Edit the destination's secret in the dashboard without changing the server's file, and trigger an event | Answered 401 with an empty body; the server's log gives a reason code, never the header                   | —      |
| P11 | Restore the secret; cancel the subscription in the portal, effective immediately in the sandbox         | `subscription.canceled` arrives; the team is suspended `canceled`; its sign-in page says why               | —      |
| P12 | `admin tenant export <slug> --out /data/x.tar.gz`, then `admin audit verify --export /data/x.tar.gz`    | The export is written and verifies                                                                         | —      |
| P13 | `admin tenant delete <slug>` and, after its 14 days (or in a throwaway deployment, the clock moved), the next control-loop pass | No row of the team on the control role; its directory gone; its host answers `404`          | —      |
| P14 | A past-due subscription: pay with the test card that declines renewals and wait for the retry window   | `past_due`; the server admins get the past-due mail; 14 days later the team is suspended `unpaid`          | —      |
| P15 | Grep the server's log for the client token, the webhook secret and the signature header's `h1=`         | None of them                                                                                               | —      |
