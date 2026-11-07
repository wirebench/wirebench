# Team management in the browser — design

Date: 2026-11-06 · Status: approved by the owner (decisions 1–3 below are final) · Amends:
`docs/specs/2026-10-24-wirebench-hosted-edition-design.md` §3.1, §3.2 and §17 (see its §24) and
`2026-09-24-wirebench-server-teams-access-design.md` §3.5 · Plan: `docs/plans/2026-11-06-team-management-in-browser.md`

## 1. Owner decisions

1. **The Team dialog is browser-only.** Members, Workspaces, Invitations, Access, License, Audit,
   Provisioning and Domain are managed in the server's browser client. The desktop keeps sign-in,
   choosing a team (Share to server, Open team workspace) and sync.
2. **The desktop shows *Manage team…*,** which opens the server's team page in the default browser,
   already on the right server and team.
3. **An invitation can be accepted in the browser.** The invitation page lets a new person set up
   their account and lands them signed in on the browser client. Accepting in the desktop keeps working.

## 2. Behaviour

### 2.1 The desktop link

- Every entry point that opened the dialog (the `team.manage` command, the status bar's account menu,
  Settings → Accounts' row button) calls one function, `manageTeam(url?)`. Its label is *Manage team…*.
- In a browser tab (`env.host === 'browser'`) it opens the dialog as before: the browser *is* the place.
- In the desktop it picks the server (the one asked for; else the open workspace's server when that
  workspace is shared to a signed-in server; else the first signed-in server), asks that server's
  `GET /api/v1/meta` through `account.probe`, and, when `capabilities` lists `browser-client`, opens
  `<server>/?panel=team[&workspace=<id>]` with `window.open(…, '_blank', 'noopener')`. The main window's
  `setWindowOpenHandler` passes it to `shell.openExternal` behind `isExternalUrlAllowed` (http and https
  only), so no new channel is needed.
- `workspace=<id>` is added when the open workspace is shared to that same server: the browser selects
  that workspace's team. The desktop holds no team id of its own (`share.yaml` keeps the team's name only).

### 2.2 The browser deep link

- The host module adds the `browser-client` capability to `GET /meta` when the browser client is on.
- `GET /?panel=team&team=<id>` and `…&workspace=<id>` load the renderer as any page does (a signed-out
  browser goes through `/sign-in?redirect_to=…`, which keeps the query). At start-up the renderer reads
  `panel`, `team` and `workspace` once, removes them from the address bar with `history.replaceState`,
  and opens the dialog on the tab's server. An id is used only if it is 1–64 characters of
  `[A-Za-z0-9_-]`; an unknown one falls back to the first team, as the dialog always did.
- Team selection order: `team`, else the team owning `workspace`, else the first team.

### 2.3 Accepting an invitation in the browser

- With the browser client off, `GET /invite/<secret>` is today's page and nothing else changes.
- With it on, an open invitation's page offers, under the sign-in page's CSP
  (`default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'`) and
  `referrer-policy: same-origin` (under `no-referrer` a browser posts `Origin: null`):
  - when local sign-in is on: a form with *Your name* (optional), *Password* and *Confirm password*,
    posting to `POST /invite/<secret>`. A password reset (the same table's `reset` row) shows only the
    two password fields, titled *Set a new password*;
  - for an `invite`, when OIDC or (licensed) SAML is offered: *Continue with <provider>*, linking to
    `/sign-in/oidc` or `/sign-in/saml`. The provider's first sign-in with the invited, verified email
    creates the account from the open invitation (identity spec §3.2), as the desktop's does;
  - the desktop's instructions and code, below, as the other way in.
- `POST /invite/<secret>` (form-encoded, 16 KiB) checks `Origin` equals the tenant URL (`403
  identity-origin-refused` otherwise), is rate-limited per address like `POST /invitations/accept`,
  and runs the **same** claim as that route (`claimInvitation`: one conditional `UPDATE`, seat check,
  `user.created` or `auth.password_changed`, the `invitationAccepted` hooks). It then signs the browser
  in with `finishBrowserSignIn` (a `browser` token, the session cookie, `auth.signed_in`) and answers
  `303` to `/`. The person types the password; the server never chooses one.
- A refusal re-renders the page with the reason: a short or mismatched password (`400`), no free seat
  (the licensing message), local sign-in off. An expired, revoked, used or unknown secret renders the
  closed page (`404`).

## 3. Rulings

1. **A server without the browser client keeps the in-app dialog.** The desktop opens the browser only
   when `GET /meta` lists `browser-client`; otherwise (`WIREBENCH_SERVER_BROWSER_CLIENT` off, the
   self-hosted default, or an older server) *Manage team…* opens the dialog in the window, as before.
   Removing it would leave every default self-hosted install with no way to manage its teams except
   the console. The fallback is the one `if` in `manageTeam`; dropping it later is a one-line change.
2. **`env.host` is read in one place.** Hosted spec §3.1 says the renderer never compares `host`; the
   owner's decision is about which *app* is running, not what the host can do, so `isBrowserTab()` in
   `lib/capabilities.ts` is the one reader, documented as such.
3. **The desktop sends a workspace, not a team.** It has the open workspace's server id, not its team id;
   the browser resolves the team. `team=<id>` is also accepted for links built elsewhere.
4. **The probe failing opens the dialog** (the server is unreachable either way, and the dialog says why).
5. **The page asks for the password twice.** A browser form has no second chance to show it; a typo would
   lock a new person out until an admin issues a reset.
6. **The invite form lands on `/`,** not on a deep link: a new member has nothing to manage yet.
7. **Labels:** *Manage team…* on both hosts (command: *Account: Manage team…*), test ids unchanged.

## 4. Security

- The form post is same-origin only (Origin check), rate-limited, size-limited, and claims the row in the
  one transaction the JSON route uses, so a race between the desktop and the browser accepts once.
- The secret stays in the path; the page's `same-origin` referrer policy keeps it from every other site,
  including the identity provider after *Continue with …*.
- The deep link carries only ids the person can already see; the dialog loads everything through the
  same channels and the server checks every call.

## 5. Testing

- Renderer unit tests: `manageTeam` (browser tab opens the dialog; desktop with `browser-client` opens
  the URL with the workspace; without it, or on a failed probe, opens the dialog); the deep-link parser
  and its start-up effect; the team store choosing the team from `team` and `workspace`.
- Server integration tests: the page's variants (client off: today's page; on: form and SSO links,
  CSP, referrer policy); the form's happy path (user, cookie, `303 /`, audit), a password reset, an
  expired and a used invitation, a wrong or missing Origin, mismatched and short passwords, the route
  absent with the client off; `browser-client` in `/meta`; the tenancy route map.
- e2e stays in CI; the Electron specs run against a server without the browser client, so they keep the
  in-window dialog (ruling 1) and change only the command's label.
