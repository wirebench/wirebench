# Switch accounts — design

Date: 2026-11-07 · Status: owner decisions 1–5 below are final · Amends:
`docs/specs/2026-11-07-settings-split-design.md` §4 (User settings' server picker goes) and the identity spec's
browser session (one cookie, one person) · Builds on: `docs/specs/2026-11-07-user-profile-design.md` (photos) ·
Plan: `docs/plans/2026-11-07-switch-accounts.md`

## 1. Owner decisions

1. **Switch accounts replaces the server picker.** User settings loses its *Server* dropdown; the account menu at the
   top right gains a *Switch accounts* list of every signed-in account, and one of them is **active**.
2. **The active account drives everything:** the account menu, User settings, *Manage team…* and Team settings, the
   team workspaces the app offers to open, and where a new share goes.
3. **The account menu holds:** a header (photo, name, `@username`, email), *View profile*, *Settings*, *Sign out*,
   then *Switch accounts* (the other accounts) and *Add account*.
4. **The browser remembers several accounts.** One browser can be signed in as several people on one server;
   switching reloads the tab as that person, and *Add account* signs someone in without signing the current person
   out.
5. **The menu is Wirebench's own:** its look follows the app; the structure above is the requirement.

## 2. Accounts and the active one

- An **account** is one person on one server: `(server URL, user id)`. Two accounts may share a server (a work and a
  test account) — on the desktop as in the browser.
- Exactly one signed-in account is **active** whenever any is signed in. It is remembered:
  - desktop: in `accounts.yaml` (`active: { url, userId }`), per machine;
  - browser: by the server, as the session the tab's cookie names (§5).
- Signing in (*Add account*, or a first sign-in) makes the new account active. Signing the active account out makes
  the most recently used other signed-in account active, or none.
- Order of the *Switch accounts* list: most recently active first.

## 3. The account menu

Top right of the title bar (where #859 put it). Trigger: the active account's photo (initials when none) and email.

1. **Header:** large photo, name, `@username · email`, and the server's host when the user has accounts on more than
   one server.
2. **View profile** → User settings → Profile. **Settings** → User settings (its last page, else Profile).
3. **Sign out** → signs the active account out (desktop: revokes its device token; browser: §5.4).
4. **Switch accounts:** one row per other signed-in account (photo, name, email, and the host when servers differ);
   choosing one makes it active (§4). Signed-out accounts the desktop still knows show dimmed with *Sign in*.
5. **Add account** → desktop: the sign-in dialog (server address prefilled with the active server's, editable);
   browser: §5.3.

*Manage team…*, *Account settings…* and *Signed-in devices…* leave the menu: they are reachable from Settings and
the palette. The *Show your account at the top right* setting stays.

## 4. What switching changes

| Surface | Follows the active account |
| --- | --- |
| Account menu | header and trigger |
| User settings | every page shows the active account; the *Server* dropdown is gone |
| Manage team / Team settings | open on the active account's server and teams |
| Open a team workspace… | lists the active account's team workspaces only |
| Share to a team | shares as the active account; the server dropdown is gone |
| Open workspaces | **unchanged**: a workspace keeps syncing as the account it was opened with (§6) |

Switching shows a toast "Now signed in as <name> on <host>." In the browser the tab reloads (§5.2).

## 5. Browser: several accounts per browser

### 5.1 Cookies

- `__Host-wb_session` (http: `wb_session`) keeps naming the **active** session's token, unchanged, so every
  existing reader (page serving, the API guard, the host socket) works as today.
- New `__Host-wb_accounts` (http: `wb_accounts`): the **other** remembered sessions' tokens, space-separated, at most
  4 (5 accounts per browser). Same attributes: `Path=/; HttpOnly; Secure; SameSite=Lax`, `Max-Age` of the longest.
  Only the server reads it; page script never sees a token.

### 5.2 Switching

`POST /sign-in/switch` (form, Origin checked as for sign-out) with `user` = a user id from the list: the server
finds that user's token in `wb_accounts`, checks it is a live browser token of this tenant, swaps it with the
active one, sets both cookies, and 303s to the page the form came from. A dead token is dropped and the answer is
303 to `/sign-in` for that person. The browser client submits the form, so the tab reloads as the new person.

### 5.3 Add account

`/sign-in?add=1&redirect_to=…`: the sign-in page says "Add an account" and shows *Cancel* back to `redirect_to`.
Finishing it (password, OIDC or SAML) does **not** revoke the presented session: the current active token moves
into `wb_accounts` and the new one becomes active. Signing in as someone already remembered replaces that entry.
At 5 accounts the page refuses with "This browser already holds five accounts. Sign one out first."

### 5.4 Sign out

`POST /sign-out` revokes the active session only; the most recent remembered one becomes active (303 to the
page), else 303 to `/sign-in`. `POST /sign-out?all=1` (Settings → Servers you're signed in to → *Sign out of all
accounts in this browser*) revokes every one.

### 5.5 Listing

`GET /api/v1/me/accounts` (cookie callers only) answers the remembered accounts: `{ userId, displayName, email,
username, photo }` for each live token in `wb_accounts`, dropping dead ones from the cookie. The browser host serves
it to the menu through the existing `account.list` path as extra, non-embedded rows.

## 6. Desktop

- `accounts.yaml` version 2: entries keyed by `(url, userId)`; `active: { url, userId } | null`. Version 1 files
  migrate on first read (every entry kept, the first signed-in one active). Device tokens stay one per account,
  labelled `wirebench-server:<url>#<userId>`.
- Signing in to a server as a second person adds an account instead of replacing the first.
- A workspace linked to a server records the `userId` it syncs as. A workspace from before this change syncs as
  the server's only account, or the active one if there are several; it records that on first sync.
- `account.*` channels take an account `{ url, userId }` where they took `url`; `account.setActive` and
  `account.active` are new; `account.changed` carries the active account.

## 7. Server

- `browser-flows.ts`: `finishBrowserSignIn` gains an `add` mode (§5.3); the default mode keeps today's behaviour
  for a browser with no remembered accounts.
- New routes: `POST /sign-in/switch`, `GET /me/accounts`; `POST /sign-out` and `?all=1` per §5.4.
- `sign-in-page.ts`: the "Add an account" heading and *Cancel*.
- Audit: `user.session.switched` (who, from which user, to which user) and the existing sign-in and sign-out records.

## 8. Security

- Tokens never reach page script: both cookies are `HttpOnly`; `/me/accounts` returns people, not tokens.
- Switching needs a same-origin POST (Origin check) and a token the browser already holds: a page cannot switch a
  tab to an account the browser was never signed in as.
- `__Host-` prefixes on https keep the cookies to the origin; each tenant has its own origin, so accounts never
  cross tenants. A token from `wb_accounts` is checked for tenant, kind `browser`, and life on every use.
- A remembered account that is disabled, removed or whose devices were signed out drops from the list at the next
  read, and switching to it fails like a stale cookie.
- Five accounts per browser bounds the cookie's size (5 × 47 characters).
- Signing out the active account never signs out the others unless asked (`?all=1`), and the confirmation names
  the person.

## 9. Rulings

1. No cross-device "remember accounts": each desktop and each browser keeps its own list.
2. The desktop shows signed-out accounts it knows (dimmed, *Sign in*); the browser forgets a signed-out session.
3. The *Servers you're signed in to* page stays: it is where accounts are removed and *Sign out of all* lives.
4. An open workspace never changes account when the active one changes; a toast on switching says so if a
   workspace of the previous account is open.

## 10. Testing

- Server: add-account keeps the old session; switch swaps cookies and refuses unknown, dead or foreign-tenant
  tokens; sign-out promotes the next account; `?all=1`; the five-account cap; `/me/accounts` drops dead tokens;
  Origin checks.
- Host: `accounts.yaml` v1 → v2 migration; two accounts on one server; active account persistence; workspace sync
  keeps its account.
- Renderer: menu structure, switching calls, User settings without the picker, share form and Open a team
  workspace follow the active account.
- e2e (browser): add a second account, switch to it and back, sign out of one keeps the other.
