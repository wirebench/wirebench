# Switch accounts — implementation plan

Spec: `docs/specs/2026-11-07-switch-accounts-design.md` · Branch: `feat/switch-accounts`, cut from
`feat/user-profile` (#865; the menu shows its photos) and rebased on `main` once #865 merges · One commit per task
after `WIREBENCH_SKIP_PERF=1 pnpm check` is green; `pnpm test:perf` before each push.

## Rulings on gaps in the spec

1. **Account key on the wire:** `AccountRef = { url, userId }`. Channels that took `url` take `account: AccountRef`;
   the host keeps a `url`-only overload for one release only where a caller outside the renderer still passes a
   URL (the CLI, the agent), resolving to that server's active-or-only account.
2. **"Most recently used"** is `lastActiveAt` on each desktop account (set on activate); the browser's order is the
   cookie's order (most recent first).
3. **v1 → v2 migration** writes v2 on the next save, not on read; reading a v1 file is pure. The first signed-in entry
   in v1 order becomes active.
4. **Token label** `wirebench-server:<url>#<userId>`; a v1 token keeps its `tokenRef`, so no keychain rewrite.
5. **Workspace account:** the workspace's sync state (`sync.json` remote) gains `userId`; absent means "the only
   account on that server, else the active one", written on the first sync after this change.
6. **Browser host:** the embedded account stays the active one; remembered accounts come from `GET /me/accounts`
   and are listed as `{ embedded: false, remembered: true }` rows that only `account.switch` and `account.signOut`
   accept.
7. **Browser actions** reach the page through `env`: `env.switchAccount(userId)` and `env.addAccount()` submit forms
   like `env.signOut`; the renderer calls them through `lib/capabilities.ts`.
8. **Cookie cap:** `wb_accounts` holds at most 4 tokens; `/sign-in?add=1` with 4 remembered answers the refusal page
   before showing the form.
9. **Audit action** `user.session.switched` is added to `AUDIT_ACTIONS` with `details: { from: userId }`, target the
   new user.
10. **Menu order:** header · View profile · Settings · Sign out · separator · Switch accounts (title + rows) · Add
    account. *Manage team…* moves to the palette and User settings → Servers row only.

## Tasks

### 1. Core: accounts file v2 (`packages/core/src/account/schema.ts`)

- `serverAccountSchema` gains `lastActiveAt?`; `accountsFileSchema` v2 `{ version: 2, active: AccountRef | null,
  servers }`; `readAccountsFile` accepts v1 and v2 (ruling 3).
- Tests: v1 parse and upgrade, two accounts on one server, active must name a signed-in entry.

### 2. Host: accounts keyed by `(url, userId)` (`packages/host/src/account-service.ts`, wire, IPC)

- `find`, `replace`, `signOut`, `remove`, `tokenFor` by `AccountRef`; sign-in adds a second account on a server;
  `active()`, `setActive(ref)`; sign-out promotes the most recent other (ruling 2); tokens per account (ruling 4).
- Wire: `AccountRef`, `AccountWire.active`, channels `account.setActive`, `account.active`; existing account
  channels take `account` (ruling 1); `account.changed` carries the active ref. `ipc-names.json`, mocks.
- Workspace sync records and uses the account (ruling 5).
- Tests: service, migration through the service, sync account choice, handlers.

### 3. Server: remembered sessions (`packages/server/src/identity/`)

- `cookies.ts`: `wb_accounts` read/write (ruling 8).
- `browser-flows.ts`: `finishBrowserSignIn` add mode; sign-out promotes; `?all=1`.
- Routes: `POST /sign-in/switch`, `GET /me/accounts`, `/sign-in?add=1` page state, refusal page at the cap;
  `sign-in-page.ts` heading and *Cancel*.
- Audit `user.session.switched` (ruling 9).
- Tests: integration for each spec §10 server case, Origin checks, foreign-tenant and dead tokens.

### 4. Browser client and browser host

- `apps/desktop/src/browser/browser-bootstrap.ts`: `env.switchAccount`, `env.addAccount` (ruling 7).
- Browser host lists remembered accounts (ruling 6) and routes `account.setActive` on one to `env.switchAccount`
  through the renderer.
- Tests: bootstrap form submission, host listing.

### 5. Renderer: active account and the menu

- `state/account.ts`: `active`, `setActive`, `others`; `capabilities.ts` gains the browser actions.
- `features/account/account-status-item.tsx`: the menu per ruling 10, Switch rows with `PersonAvatar`, dimmed
  signed-out rows with *Sign in*, *Add account*; toast on switch (spec §4).
- Tests: menu structure, switching on desktop and in the browser, signed-out row.

### 6. Renderer: everything follows the active account

- User settings: drop the server dropdown and `settingsServerUrl` use; pages read the active account.
- Servers page: *Sign out of all accounts in this browser* (browser only).
- `team-link.ts` `chooseServer`, Team settings, `open-team-workspace-dialog.tsx`, `server-share-form.tsx` (drop the
  select) follow the active account; toast when an open workspace belongs to another account (spec ruling 4).
- Tests for each surface.

### 7. Docs and changelog

- Guides: the account menu, switching and adding accounts, what follows the active account, the browser's five.
- `CHANGELOG.md` [Unreleased].

### 8. e2e (browser suite)

- `e2e/browser/switch-accounts.spec.ts`: add the seeded plain account through *Add account* (its password comes
  from the seed), switch to it and back, sign out of one keeps the other. Seed exposes the plain account's password.

### 9. Gate and PR

- Full gate, `pnpm test:perf`, check on the local server, open the PR with Auto-fix on.
