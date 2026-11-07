# App, team and user settings — implementation plan

**Goal:** Settings becomes three pages with their own menus: *App settings* (today's page, minus Account and
Server), *User settings* (you, on every server) and, in the browser client, *Team settings* (the team and its
server), which replaces the Team dialog there. Two server additions: renewing an invitation, and changing your
own display name.

**Spec:** `docs/specs/2026-11-07-settings-split-design.md` (owner decisions §1, rulings §7). It amends
`docs/specs/2026-11-06-team-management-in-browser-design.md` §2 and the Settings page of #396. Builds on the
browser client always being on (#855).

## Global constraints

- One commit per task after `WIREBENCH_SKIP_PERF=1 pnpm check` is green, as Mohammed Naami
  <m.naami@outlook.com>, no trailers. `pnpm test:perf` before the push in Task 15.
- No local Electron or e2e windows; e2e runs in CI (browser e2e via `pnpm test:e2e:browser`, desktop e2e
  via `pnpm build && xvfb-run -a pnpm test:e2e` in CI only).
- Renderer files never value-import from `@shared/wire-types.js` or `@wirebench/engine` (the zod CSP probe):
  page ids, role tables and ability tables are restated in renderer modules, each with a test that keeps the
  copy honest, as `roles.ts` does today.
- `eslint.config.js` is protected: do not touch it. Never `git stash` bare.
- No other product named anywhere (`pnpm check:banned-terms`); menu names follow who a change affects.
- Every server write keeps its existing role check; the client hides what the caller may not use, and the
  server checks again regardless.
- No avatars, no images, no reusable invite links (spec §7).
- Test ids keep their current names where a page is a moved tab (`member-row-<id>`, `member-role-<id>`,
  `invitation-row-<id>`, `team-name`, `team-delete`, `accounts-section` stay), so existing unit tests move
  rather than get rewritten.

## Review focus

- **Renew is one transaction** (Task 2): revoke, seat check, insert, team row, audit, all or nothing; the old
  link refused afterwards; a renew of another team's invitation is 404, as revoke is.
- **The address is the state** (Task 8): parse rejects anything outside the id pattern, an unknown team or
  page falls back without throwing, every page change writes with `replaceState` (never `pushState`, so Back
  leaves the app as today), and *Back to workspace* strips the parameters.
- **Who sees which page** (Tasks 5, 10, 11): the menu functions are pure and tested for member, team admin,
  server admin, hosted and self-hosted; a page the caller may not see is never rendered even when the address
  names it.
- **Nothing lost in the move** (Tasks 11, 12): every page of today's Settings → Server group and every tab of
  the Team dialog has a home; the desktop fallback dialog is unchanged.
- **The password crosses the bridge once more** (Task 4): `account.changePassword` carries the current and new
  password to the host and nowhere else; it is never logged, never kept in a store, and the form clears both
  fields after every answer.

## Rulings (spec gaps found while planning)

1. **The Password page and Signed-in devices are new client code, not moved code.** The spec calls the
   change-password form "today's", but no client calls `POST /me/password` or `/me/devices` yet; the server
   routes exist (`identity/routes/me.ts`). Task 4 adds the channels, Task 7 the forms.
2. **Display name length is the existing `MAX_DISPLAY_NAME_LENGTH` (120)**, not the spec's 100: the accept
   form and SCIM already allow 120, and two limits for one field would refuse names the server already holds.
3. **`PATCH /me` audits as `user.updated`** with `details: { fields: 'displayName', via: 'self' }`, not a new
   `identity.profile-updated`: `AUDIT_ACTIONS` is a closed list in `user.*` / `auth.*` form, and SCIM already
   records name changes as `user.updated` with `fields`. A SCIM-provisioned user may still rename themselves;
   the next SCIM push overwrites it, as it does any field it owns.
4. **Renew runs the seat check**, as create does (`assertSeatAvailable` inside the transaction, after the
   revoke). Seats count enabled users, not invitations, so a renew never changes the count; the check is kept
   so an admin at the limit learns it from the renew, not from the invitee.
5. **Renew's refusals.** 404 `teams-invitation-not-found` for an invitation that is not this team's, not open,
   or a reset; 409 `teams-user-exists-invite` when the email has become an account since — the transaction
   rolls back and the old invitation stays open.
6. **Team admins keep their team's Audit log.** Today a team admin who is not a server admin has the Audit tab
   for their team. Spec §3.5 puts *Audit log* in the server-admin group, which would take it away from them.
   The page appears under **This team** for a team admin who is not a server admin (scoped to the team, as
   today), and under **Server** for a server admin (all teams). One page id, `audit`.
7. **One Provisioning page.** The Team dialog's Provisioning tab (SAML groups → teams) and Settings → Server →
   Provisioning (SCIM base URL and tokens) both exist today. The Server group's *Provisioning* page shows the
   SCIM card first, then the groups card.
8. **Server group gating.** The group shows when `team.list` says `serverAdmin`. License and seats, Domain
   (when the domain read answers), Audit log and Provisioning's groups card need only that; Sign-in,
   Provisioning's SCIM card, Email, Audit forwarding, Retention, Export, Billing and Close this account show
   once `serverSettings.get` answered (`available`), as today. An older server without the settings routes
   therefore shows the first set only.
9. **Page id `delete` becomes `close-account`** in `SERVER_PAGES`, so the address reads
   `page=close-account`; test ids follow (`server-page-close-account`, `team-settings-nav-close-account`).
10. **People for a non-admin has no Waiting filter.** The server answers `GET …/invitations` to team admins
    only, so a member's list holds members alone; the filter row shows *All* and *Joined* only.
11. **"· you" comes from the account,** not from `/me`: `AccountWire.userId` for the page's server.
12. **The current device has no Sign out** on *Signed-in devices*; it says "This device". Signing this device
    out is the status bar's *Sign out*, which in a browser tab ends the tab's session properly.
13. **The status bar keeps its menu.** The spec opens User settings "from your name in the status bar": the
    menu's *Manage accounts…* becomes *Account settings…* (User settings → Servers you're signed in to) and
    *Devices & tokens…* becomes *Signed-in devices…* (User settings → Signed-in devices). The trigger still
    opens the menu, so *Sign out* stays one click away.
14. **The "Show sign-in in the status bar" switch moves with Accounts** to User settings → Servers you're
    signed in to. It is still a preference (`accounts.showInStatusBar`), so that page carries the section's
    modified dot and *Reset*; App settings search no longer finds it (spec §2: search searches its own area).
15. **The roles table needs an ability table that does not exist yet.** `roles.ts` holds names and labels
    only; the renderer's role checks are inline comparisons. Task 10 adds `ABILITY_MIN_ROLE` (least workspace
    role per ability) to `roles.ts` and moves the inline checks it covers onto `roleCan`, so the table and those
    checks share one source. The table restates the server's route guards: read and send = viewer (the sync
    pull routes' `requireWorkspaceRole('viewer')`), edit = editor (`sync/routes/commits.ts`, CI tokens, hooks),
    share and manage workspace = admin (`teams/routes/access.ts`, `teams/routes/workspaces.ts`). *Manage
    people* is a team role, not a workspace role: the page shows it as a line under the grid.
16. **The desktop's server-settings e2e moves to a renderer test.** `e2e/specs/server-settings.spec.ts` drives
    Settings → Server in the desktop against the fake server playing a hosted team. The desktop no longer has
    that group (spec §7), and the browser e2e stack is self-hosted. Its assertions (the group shows for a server
    admin with the team's name, the OIDC card sends the typed secret once and then shows *Set*) move to
    `apps/desktop/test/renderer/team-settings-server.test.tsx` against the stubbed `ipc()`; the browser e2e
    covers a reload on a Server page against the real server.
17. **The deep link stays in the address.** Today `takeTeamDeepLink` strips it so a reload does not reopen the
    dialog; spec §5 wants reload and bookmarks to keep the page. It now opens Team settings and leaves the
    address to Task 8's writer; *Back to workspace* strips it.

## Tasks

### Task 1 — spec and plan

- [ ] This plan; the spec's "Plan: to follow" names it. (This PR, on top of #856.)

### Task 2 — server: renew an invitation

Files:

- `packages/server/src/identity/invitations.ts`: add

  ```ts
  /**
   * Revokes the open `invite` `id` and creates its replacement for the same email and server-admin flag, in one
   * transaction; `attach` writes the new row's team link (teams spec §3.4). `undefined` when `id` is not an open
   * invite. The old link is refused from the commit on.
   */
  export async function renewInvitation(
    env: InvitationEnv,
    scope: TenantScope,
    id: string,
    input: { readonly createdBy: string | null; readonly source: AuditSource; readonly serverUrl: string },
    attach?: (tx: TenantQuerier, invitationId: string) => Promise<void>,
  ): Promise<InvitationCreated | undefined>;
  ```

  Inside one `db.transaction`: re-read the row (`repo.invitationById`); `kind === 'invite'` and `isOpen`, else
  return `undefined`; `repo.findUserByEmail(tx, row.emailLower)` → `userExists()`;
  `repo.revokeInvitation(tx, id, now)`; `env.ctx.license.assertSeatAvailable(tx)`; `repo.insertInvitation` with
  a fresh `mintSecret()`, same `email` and `serverAdmin`, `createdBy: input.createdBy`, a new `expiresAt`;
  `attach`; audit `user.invitation_revoked` for the old row (`details: { emailLower, renewed: true }`) and
  `user.invited` for the new (`details: { emailLower, serverAdmin, renewedFrom: id }`). No new audit action:
  a renew is an invite that ends an earlier one. The unique index `invitations_one_open_per_email` holds
  because the revoke runs first in the same transaction; a racing create still loses with `invitationExists()`.
- `packages/server/src/teams/routes/invitations.ts`: `POST /teams/:teamId/invitations/:id/renew`,
  `requireTeamRole(env.ctx.tenancy, 'admin')`, params `teamInvitationParamsSchema`, response
  `{ 201: teamInvitationCreatedSchema }`. `repo.isTeamInvitation(tdb, teamId, id)` else `invitationNotFound()`;
  the role from `repo.teamInvitationOf(tdb, id)`; `renewInvitation` with
  `attach: (tx, newId) => repo.insertTeamInvitation(tx, { invitationId: newId, teamId, role })`; `undefined` →
  `invitationNotFound()`; `identity-user-exists` → `userExistsInvite()` as create does. Answers
  `{ id, email, role, url, expiresAt }`.
- `packages/server/test/integration/tenancy/route-map.ts`: the route, as a team-admin route.
- `packages/server/README.md`: the route in the teams table.

Tests — `packages/server/test/integration/teams/invitations.test.ts`, new `describe('renew')`:

- `it('a team admin renews: a new link, same email and role, the old link refused')` — create, renew; 201 with a
  `url` unlike the first; lookup with the old secret → `identity-invitation-invalid`; with the new → 200;
  `GET …/invitations` lists exactly one row, the new id, same role.
- `it('refuses a member with 403 and an outsider with 404')`.
- `it('another team’s invitation, a revoked one and an accepted one are 404')`.
- `it('an email that became an account since is 409 with the hint, and the old invitation stays open')`.
- `it('is one transaction: a seat refusal leaves the old invitation open')` — license at its limit; renew
  refused with the seat-limit answer; the old secret still looks up; no new row.
- `it('records the revoke and the new invite, the invite naming the old id')`.

Commit: `server: renew a team invitation in one transaction`.

### Task 3 — server: change your own display name

Files:

- `packages/core/src/server-api/identity.ts`: `meUpdateRequestSchema = z.object({ name:
  z.string().min(1).max(MAX_DISPLAY_NAME_LENGTH) })` and `MeUpdateRequest`, exported beside their neighbours.
- `packages/server/src/identity/repo.ts`: `setDisplayName(db: TenantQuerier, id: string, name: string): Promise<void>`.
- `packages/server/src/identity/errors.ts`: `displayNameInvalid()` — 400 `identity-name-invalid`.
- `packages/server/src/identity/routes/me.ts`: `app.patch('/me', { preHandler: requireUser, schema: { body:
  jsonSchema(meUpdateRequestSchema, { io: 'input' }), response: { 200: jsonSchema(meResponseSchema) } } }, …)`.
  Trim; empty after trim → `displayNameInvalid()`. One transaction: `setDisplayName`, audit `user.updated`
  (`target: { kind: 'user', id }`, `details: { fields: 'displayName', via: 'self' }`, ruling 3). An unchanged
  name writes and records nothing. Answers what `GET /me` answers.
- `route-map.ts`: `PATCH /me` as a user route. README: the row.

Tests — `packages/server/test/integration/identity/me.test.ts`:

- `it('PATCH /me trims and stores the name; GET /me shows it')`.
- `it('refuses a blank and a 121-character name with 400')` — blank after trim → `identity-name-invalid`.
- `it('records user.updated once, with the field name and no value')` — details deep-equal
  `{ fields: 'displayName', via: 'self' }`; a second PATCH with the same name adds no row.
- `it('needs a signed-in user')` — 401 without a token.

Commit: `server: PATCH /me changes your display name`.

### Task 4 — wire and host: the new channels

Files:

- `packages/wire/src/wire-base.ts`: `accountProfileWireSchema` (`{ user: { id, email, displayName,
  serverAdmin }, methods: { local, oidc: { issuer }[] }, localPasswords: boolean }`, `localPasswords` from
  the server's `GET /meta` `auth.local`), `accountUpdateProfileRequestSchema` (`{ url, name }`),
  `accountChangePasswordRequestSchema` (`{ url, currentPassword?, newPassword }`),
  `accountDeviceWireSchema` / `accountDevicesResponseSchema` (`{ devices }`), `accountDeviceRefRequestSchema`
  (`{ url, id }`).
- `packages/wire/src/ipc.ts`:
  - `team.renewInvitation`: `teamInvitationRefRequestWireSchema` → the answer `team.invite` gives.
  - `account.profile` (`accountUrlRequestSchema` → profile), `account.updateProfile` (→ profile),
    `account.changePassword` (→ `{ done: true }`), `account.devices`, `account.signOutDevice` (→ `{ done: true }`).
  - The `account` block comment: "A password crosses in `signInLocal`, `acceptInvitation` and
    `changePassword`, and nowhere else."
- `packages/host/src/server-client.ts`: `renewTeamInvitation(url, token, teamId, id)`, `updateMe(url, token,
  name)`, `changePassword(url, token, body)`, `listDevices(url, token)`, `revokeDevice(url, token, id)`, each
  parsing with the core schema like its neighbours.
- `packages/host/src/ipc/team.ts`: the `team.renewInvitation` handler; `'renewTeamInvitation'` in the `Pick`.
- `packages/host/src/ipc/account.ts`: the five `account.*` handlers through `withToken`; `account.profile` calls
  `me` and `meta` in parallel. A successful `updateProfile` also updates the stored account's `displayName`
  through the account service, so the Accounts list and the status bar follow.
- `packages/server/src/host/allowlist.ts`: nothing to add (the `account` and `team` groups are served).
- `apps/desktop/test/mocks/wirebench-api.ts`: `fail(...)` stubs for the six channels.

Tests:

- `packages/host/test/ipc-team.test.ts`: `it('team.renewInvitation posts to …/renew and answers the new link')`.
- `packages/host/test/ipc-account.test.ts` (new or extended): `it('account.profile joins /me and /meta’s
  auth.local')`, `it('account.updateProfile updates the stored account’s display name')`,
  `it('account.changePassword sends both passwords and answers done; a refusal keeps the server’s code')`,
  `it('account.devices and signOutDevice call /me/devices')`, and `it.each` over the five:
  `it('a signed-out answer marks the account signed out')`.
- `packages/server/test/integration/host/allowlist.test.ts`: `it('serves the new account and team channels to
  a browser session')`.

Commit: `wire, host: channels for renew, profile, password and devices`.

### Task 5 — renderer: three settings areas, their menus and the address

Files:

- `apps/desktop/src/renderer/state/ui.ts`:

  ```ts
  export type SettingsArea = 'app' | 'team' | 'user';
  export interface TeamSettingsTarget {
    readonly url?: string; readonly teamId?: string; readonly workspaceId?: string; readonly page?: TeamSettingsPageId;
  }
  readonly preferences: {
    readonly open: boolean;
    readonly area: SettingsArea;
    /** App: a section request. User: a user page. Team: unused (`team` holds the page). */
    readonly section: SettingsSectionRequest | UserSettingsPageId | undefined;
    readonly team?: TeamSettingsTarget;
  };
  readonly openPreferences: (section?: SettingsSectionRequest) => void;   // area 'app'; callers unchanged
  readonly openUserSettings: (page?: UserSettingsPageId) => void;
  readonly openTeamSettings: (target?: TeamSettingsTarget) => void;
  readonly setPreferencesOpen: (open: boolean) => void;                   // closes whichever area is open
  ```

  The field keeps its name so the shell's `settingsOpen` and its tests stay; the default `area` is `'app'`.
- `features/preferences/settings-model.ts`: regroup `SETTINGS_NAV` as spec §2 — **General** (unchanged),
  **Protocols** (`http`, `rest`, `wsdl`, `wsi`), **Network and tools** (`proxy`, `ssl`, `git`, `mocks`,
  `terminal`, `ssh`, `secrets`), **This computer** (`this-machine`, `paired-browsers`). `accounts` and `tokens`
  stay, for now, in an **Account** group at the end; Task 12 removes them once User settings has them.
- New `features/preferences/user-settings-model.ts`:

  ```ts
  export const USER_PAGES = ['profile', 'password', 'servers', 'devices', 'tokens'] as const;
  export type UserSettingsPageId = (typeof USER_PAGES)[number];
  export interface UserPage { readonly id: UserSettingsPageId; readonly label: string; readonly subtitle: string }
  export const USER_NAV: readonly { readonly title: 'You' | 'Access'; readonly pages: readonly UserPage[] }[];
  /** Password only where the chosen server allows local passwords; everything else always. */
  export function userNav(facts: { readonly localPasswords: boolean }): typeof USER_NAV;
  export const DEFAULT_USER_PAGE: UserSettingsPageId = 'profile';
  export function resolveUserPage(page: string | undefined, facts: { readonly localPasswords: boolean }): UserSettingsPageId;
  ```

  Labels: Profile, Password, Servers you're signed in to, Signed-in devices, CI tokens.
- New `features/team/team-settings-model.ts`:

  ```ts
  export const TEAM_PAGES = ['overview', 'people', 'workspaces', 'roles', 'audit'] as const;
  /** The Server group, in the nav's order (spec §2). */
  export const SERVER_GROUP_PAGES = ['license', 'sign-in', 'provisioning', 'domain', 'email', 'audit',
    'audit-forwarding', 'retention', 'export', 'billing', 'close-account'] as const;
  export type TeamSettingsPageId = (typeof TEAM_PAGES)[number] | (typeof SERVER_GROUP_PAGES)[number];
  export interface TeamNavFacts {
    readonly hasTeam: boolean; readonly teamAdmin: boolean; readonly serverAdmin: boolean;
    readonly settingsAvailable: boolean; readonly hosted: boolean; readonly domain: boolean;
  }
  export interface TeamNavGroup { readonly title: 'This team' | 'Server'; readonly pages: readonly TeamSettingsPageId[] }
  export function teamNav(facts: TeamNavFacts): readonly TeamNavGroup[];
  export const DEFAULT_TEAM_PAGE: TeamSettingsPageId = 'people';
  /** A page `teamNav(facts)` lists, else People, else the first listed page when there is no team. */
  export function resolveTeamPage(page: string | undefined, facts: TeamNavFacts): TeamSettingsPageId | undefined;
  export const TEAM_PAGE_LABELS: Readonly<Record<TeamSettingsPageId, string>>;
  ```

  Rules: *This team* lists `overview`, `people`, `workspaces`, `roles` when `hasTeam`, plus `audit` when
  `teamAdmin && !serverAdmin` (ruling 6). *Server*, when `serverAdmin`: `license`, `provisioning`, `audit`, and
  `domain` if `domain`; with `settingsAvailable` also `sign-in`, `email`, `audit-forwarding`, `retention`,
  `export`, and `billing`, `close-account` if `hosted` — always in `SERVER_GROUP_PAGES` order (ruling 8).
  `undefined` only for a caller with no team who is not a server admin (the empty state).
- `features/preferences/server/server-settings-store.ts`: `SERVER_PAGES`' `'delete'` → `'close-account'`,
  `HOSTED_ONLY_PAGES` follows (ruling 9); `server-page.tsx` follows with the label *Close this account* and the
  subtitle "Close <team>’s account and delete everything in it."
- `features/team/team-link.ts`, the address (spec §5):

  ```ts
  export interface TeamSettingsAddress { readonly teamId?: string; readonly workspaceId?: string; readonly page?: string }
  /** `panel=team[&team][&workspace][&page]`; an id outside ID_PATTERN or a page outside /^[a-z-]{1,32}$/ is dropped. */
  export function readTeamDeepLink(search: string): TeamSettingsAddress | undefined;
  /** `search` with panel, team and page set (other parameters kept, workspace dropped), in that order. */
  export function teamSettingsSearch(search: string, address: { readonly teamId: string | undefined; readonly page: TeamSettingsPageId }): string;
  /** `search` without panel, team, workspace and page. */
  export function withoutTeamSettings(search: string): string;
  ```

  `teamPageUrl(serverUrl, target)` writes `page` when given. `takeTeamDeepLink` becomes `openTeamDeepLink`: it
  reads the link and calls `openTeamSettings`, and no longer strips it (ruling 17).

Tests:

- `apps/desktop/test/renderer/settings-model.test.ts` (extend): `it('groups App settings as General, Protocols,
  Network and tools, This computer, Account')` — titles and ids in order.
- New `user-settings-model.test.ts`: `it('lists every page with local passwords on')`, `it('hides Password with
  local passwords off')`, `it('an unknown page, or Password where it is hidden, resolves to Profile')`.
- New `team-settings-model.test.ts`, `it.each` over the callers, each asserting the whole `teamNav(...)`:
  member (This team without `audit`, no Server group); team admin (adds `audit` under This team); self-hosted
  server admin on a team with settings (Server = license, sign-in, provisioning, email, audit,
  audit-forwarding, retention, export); hosted server admin with a domain (adds domain, billing, close-account
  in order); server admin of an older server (license, provisioning, audit). Plus `it('a server admin with no
  team has the Server group only')`, `it('resolveTeamPage falls back to People, to the first page without a
  team, and to undefined for a member with no team')`.
- `team-link.test.ts` (extend): `it('reads team, workspace and page')`, `it('drops a malformed id and page')`,
  `it('teamSettingsSearch keeps other parameters and writes panel, team, page in order')`,
  `it('withoutTeamSettings strips only its own parameters')`, `it('teamPageUrl writes page when given')`.
- `ui` store test (extend): `it('openUserSettings and openTeamSettings set the area; setPreferencesOpen(false)
  closes either and resets to app')`.
- `server-settings.test.tsx`: `close-account` replaces `delete`.

Commit: `renderer: app, team and user settings areas and their menus`.

### Task 6 — renderer: one page shell for the three areas

Files:

- New `features/preferences/settings-shell.tsx`, what `preferences-editor.tsx` draws around its content today:

  ```tsx
  export interface SettingsShellProps {
    readonly area: SettingsArea;
    /** Above the search: Team settings' switcher, User settings' server picker. */
    readonly header?: ReactNode;
    readonly nav: ReactNode;
    readonly search?: { readonly value: string; readonly onChange: (value: string) => void; readonly placeholder: string };
    readonly children: ReactNode;
    readonly onBack: () => void;
  }
  export function SettingsShell(props: SettingsShellProps): JSX.Element;
  export function SettingsNavGroup(props: { readonly title: string; readonly testId?: string; readonly children: ReactNode }): JSX.Element;
  export function SettingsNavItem(props: {
    readonly label: string; readonly icon: LucideIcon; readonly current: boolean; readonly danger?: boolean;
    readonly modified?: boolean; readonly testId: string; readonly onSelect: () => void;
  }): JSX.Element;
  export function SettingsPageHeader(props: { readonly title: string; readonly subtitle: string; readonly actions?: ReactNode }): JSX.Element;
  ```

  The shell owns the Escape and ⌘F / Ctrl+F handlers now in `PreferencesEditor` (`escapeClaimedElsewhere` and
  `capturesEscape` move with them and stay exported); Escape clears the search, then calls `onBack`. The back
  link reads *Back to workspace* (spec §2), `data-testid="settings-back"` kept.
- `preferences-editor.tsx` renders inside `SettingsShell area="app"`; behaviour unchanged.
- `settings-page.tsx` switches on `preferences.area` — `app` → `PreferencesEditor`, `user` → `UserSettings`
  (Task 7), `team` → `TeamSettings` (Task 8) — each lazy, under one `Suspense`, keyed by area and section.
  Until Tasks 7–8 land, `user` and `team` render nothing and nothing opens them.

Tests:

- `preferences-editor.test.tsx`: the Escape, search and back tests stay green; the back label is
  `'Back to workspace'`.
- New `settings-shell.test.tsx`: `it('Escape clears the search, then calls onBack')`, `it('Escape inside an open
  menu does not leave')`, `it('⌘F focuses the search')`, `it('renders the header above the search')`.

Commit: `renderer: one settings shell for app, team and user settings`.

### Task 7 — renderer: User settings

Files:

- New `state/user-settings.ts` (zustand, nothing persisted):

  ```ts
  interface UserSettingsState {
    readonly url: string | undefined;
    readonly profile: AccountProfileWire | undefined;
    readonly devices: readonly AccountDeviceWire[];
    readonly loading: boolean;
    readonly error: string | undefined;
  }
  interface UserSettingsStore extends UserSettingsState {
    readonly load: (url: string) => Promise<void>;          // profile + devices; a stale answer is dropped by url
    readonly rename: (name: string) => Promise<boolean>;    // account.updateProfile, then the account store reloads
    readonly changePassword: (currentPassword: string | undefined, newPassword: string)
      => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
    readonly signOutDevice: (id: string) => Promise<boolean>;
    readonly reset: () => void;
  }
  ```

  `changePassword` hands the refusal to the form instead of storing it; nothing in the store holds a password.
- New `features/preferences/user/user-settings.tsx`: `SettingsShell area="user"`, nav from `userNav`, a server
  picker (`user-settings-server`) in `header` when more than one server is signed in (spec §4: Profile,
  Password and Signed-in devices follow it; it starts on `settingsServerUrl(signedIn, linked)`).
- New `features/preferences/user/profile-page.tsx`: name (`user-profile-name`, saved on blur or Enter,
  trimmed, 1–120; a refusal shows under the field), email read-only (`user-profile-email`), sign-in methods as
  text (`user-profile-methods`: "Password", "Single sign-on · <issuer>").
- New `features/preferences/user/password-page.tsx`: current (omitted when `profile.methods.local` is false: a
  user with no password yet sets one), new, repeat; submit disabled until new ≥ `MIN_PASSWORD_LENGTH`
  (restated in the renderer) and repeat matches. Success: "Password changed. Your other devices were signed
  out."; refusal: the server's message; both clear all three fields. Test ids `user-password-current`,
  `user-password-new`, `user-password-repeat`, `user-password-submit`, `user-password-result`.
- `servers` page: `sections/accounts-section.tsx` moves to `features/preferences/user/servers-page.tsx`
  (`AccountsSection` keeps its name and `data-testid="accounts-section"`) with its *Status bar* switch
  (ruling 14); the page carries the `accounts` stored section's modified dot and *Reset*.
- New `features/preferences/user/devices-page.tsx`: one row per device (`user-device-<id>`: name, signed in,
  last used; "This device" for `current`), *Sign out* (`user-device-sign-out-<id>`) on the others behind a
  `ConfirmDialog` (ruling 12).
- `tokens` page: `TokensSection` unchanged.

Tests — new `apps/desktop/test/renderer/user-settings.test.tsx`:

- `it('opens on Profile with the account’s name and email')`.
- `it('renames on blur and reloads the account list')` — `account.updateProfile` once with the trimmed name,
  `account.list` after.
- `it('hides Password where local passwords are off')`.
- `it('changes the password, says other devices were signed out, and clears the fields')`.
- `it('shows a refused change and clears the fields; the store never holds a password')` — no key of
  `useUserSettingsStore.getState()` holds either typed value.
- `it('lists devices; this device has no Sign out; another signs out after confirming')`.
- `it('with two servers signed in, the picker changes which server Profile reads')`.
- `it('Servers you’re signed in to is the Accounts list, with the status bar switch')`.
- `team-roles.test.ts`-style constant check: the renderer's `MIN_PASSWORD_LENGTH` equals the engine's.

Commit: `renderer: User settings — profile, password, servers, devices, CI tokens`.

### Task 8 — renderer: Team settings shell, switcher and address

Files:

- `state/team.ts`: the store's `tab` becomes `page: TeamSettingsPageId | undefined` with `setPage(page)`
  (the fallback dialog keeps a local `TeamTab` state in `team-dialog.tsx`, so it is unchanged); `open(url,
  target)` takes `TeamSettingsTarget`. The tab-fallback rules in `refresh` and `selectTeam` become one call to
  `resolveTeamPage(page, facts)` after every load.
- New `features/team/settings/team-settings.tsx`: `SettingsShell area="team"` (`data-testid="team-settings"`),
  `header` = `TeamSwitcher`, nav from `teamNav(facts)` (`team-settings-nav-<page>`), content by page. On mount
  `useTeamStore.open(url, target)` (url: the tab's server), the domain store and the server-settings store when
  `serverAdmin` (the effects from `team-dialog.tsx` and `settings-page.tsx` move here). Signed out → the
  dialog's *Sign in again* block (`team-signed-out`).
- New `features/team/settings/team-switcher.tsx`: button (initial in a square, name, chevron; `team-switcher`),
  a Radix dropdown of the caller's teams (`team-switcher-<id>`), *New team…* (`team-switcher-new`, server
  admins) opening a small dialog (`team-new-dialog`, `team-new-name`, `team-new-submit`) that calls `createTeam`
  and lands on People. Picking a team calls `selectTeam` and keeps the page (re-resolved, so an admin-only
  page falls back for a member).
- Empty states (spec §3.1, `team-settings-empty`): server admin — "Create your first team" with *New team…*;
  anyone else — "You’re not on a team on this server yet. A server admin can add you." The Server group still
  shows to a server admin.
- New `features/team/settings/use-team-address.ts`: `useTeamAddress(teamId, page)` writes
  `teamSettingsSearch(location.search, …)` with `history.replaceState` whenever either changes. The shell's
  `onBack` writes `withoutTeamSettings(location.search)` and calls `setPreferencesOpen(false)`.
- `team-link.ts` `manageTeam`: in a browser tab, `openTeamSettings(url === undefined ? {} : { url })` instead of
  `openTeamDialog`. `app-shell.tsx`: `openTeamDeepLink()` at mount in a browser tab.

Tests — new `apps/desktop/test/renderer/team-settings.test.tsx`:

- `it('opens on People for the team in the address')`, `it('an unknown team falls back to the first')`,
  `it('an unknown page falls back to People')`, `it('a workspace link opens People on that workspace’s team')`.
- `it('switching team keeps the page and writes team= with replaceState')` — `history.pushState` never called.
- `it('a page change writes page=')`, `it('Back to workspace strips panel, team and page and closes')`.
- `it('New team… creates the team and lands on its People page')`.
- `it('a member with no team sees the not-on-a-team text; a server admin sees Create your first team and the
  Server group')`.
- `it('switching to a team the caller does not admin leaves Audit log for People')`.
- `team-link.test.ts`: `it('manageTeam in a browser tab opens Team settings')`.
- `app-shell.test.tsx`: the deep-link test asserts `openTeamSettings` was called and the address is unchanged.

Commit: `renderer: Team settings page, team switcher and its address`.

### Task 9 — renderer: People

Files:

- New `features/team/settings/people.ts` (pure):

  ```ts
  export type PersonRow =
    | { readonly kind: 'member'; readonly member: TeamMemberWire; readonly you: boolean }
    | { readonly kind: 'invitation'; readonly invitation: TeamInvitationWire; readonly expiresInDays: number };
  export type PeopleFilter = 'all' | 'joined' | 'waiting';
  /** Members by name, then invitations by email. */
  export function peopleRows(members: readonly TeamMemberWire[], invitations: readonly TeamInvitationWire[],
    youId: string | undefined, now: Date): readonly PersonRow[];
  export function filterPeople(rows: readonly PersonRow[], filter: PeopleFilter, query: string): readonly PersonRow[];
  export function peopleCounts(rows: readonly PersonRow[]): Readonly<Record<PeopleFilter, number>>;
  ```

  `query` matches name or email, trimmed, ignoring case. `expiresInDays` rounds up, never below 0.
- `state/team.ts`:
  - `addPerson(email, role): Promise<{ kind: 'member' } | { kind: 'invited'; invitation: TeamInvitationCreatedWire }
    | { kind: 'failed'; message: string }>` — `team.addMember`; on `teams-user-unknown` → `team.invite`; any other
    refusal → `failed` (no toast; the dialog shows it). Refreshes after either success.
  - `renewInvitation(invitationId): Promise<boolean>` — sets `lastInvite` to the new link.
  - `rowErrors: Readonly<Record<string, string>>` by user id: `setMemberRole` and `removeMember` put a refusal
    (`teams-last-admin` included) there instead of toasting; cleared on the next action on that row.
- New `features/team/settings/people-page.tsx`: filters (`people-filter-all|joined|waiting`, each with its
  count; no Waiting for non-admins, ruling 10), `people-search`, then rows:
  - member `member-row-<userId>`: initials, name, email, "joined <date>", the role select
    (`member-role-<userId>`, team admins) or text; your row adds "· you" and *Leave team* (`member-leave`);
    other rows' ⋯ menu holds *Remove* (`member-remove-<userId>`) for team admins; `member-row-error-<userId>`
    shows `rowErrors`.
  - invitation `invitation-row-<id>`: dashed mail icon, email, "Invited as <role> · link expires in N days";
    team admins get *New link* (`invitation-renew-<id>`) and *Revoke* (`invitation-revoke-<id>`).
  - *Add people* (`people-add`, team admins) → new `add-people-dialog.tsx` (`add-people-dialog`,
    `add-people-email`, `add-people-role`, `add-people-submit`, `add-people-result`, `add-people-link`,
    `add-people-copy`): "Added <email> to <team>." or "No account has that email yet, so this is an
    invitation. Send them this link; it is shown only now." with the link and *Copy*. *New link* reuses the
    link view.
  - server admins: `people-seats` "N of M seats in use on this server" from `useLicenseStore` (loaded when
    `serverAdmin`); "N seats in use on this server" when there is no limit.
  - *Leave team* and *Remove* keep the dialog's confirms ("Leave <team>?", "Remove <email>?"). After leaving,
    the store refreshes; the team leaves the switcher and the page re-resolves.
- `members-tab.tsx`, `invitations-tab.tsx`, `invite-dialog.tsx` stay for the fallback dialog.

Tests:

- New `people.test.ts`: `it('lists members by name, then invitations by email')`, `it('marks your row')`,
  `it('filters joined and waiting, and counts each')`, `it('the search matches name and email, ignoring case')`,
  `it('days left round up and never go below 0')`.
- New `people-page.test.tsx`: `it('Add people adds an existing account as a member')`,
  `it('Add people invites an unknown email and shows the link with Copy')` — `team.addMember` refused with
  `teams-user-unknown`, then `team.invite` with the same email and role,
  `it('Add people shows any other refusal in the dialog')`, `it('New link renews and shows the new link once')`,
  `it('Revoke removes the row')`, `it('demoting the last admin shows the server’s message on the row')`,
  `it('Leave team asks first, then removes you')`, `it('a member sees roles as text, no Add people and no
  Waiting filter')`, `it('a server admin sees the seat line')`.

Commit: `renderer: People — members and invitations in one list`.

### Task 10 — renderer: Overview, Workspaces, What roles can do, team Audit log

Files:

- New `features/team/settings/overview-page.tsx`: team name (`team-name`, editable by team admins, saved on blur
  or Enter as in the dialog); counts (`team-overview-members` from the store's members,
  `team-overview-workspaces` from `teamWorkspaces`); created (`team-overview-created`, `TeamWire.createdAt`).
  For server admins a danger zone: *Delete this team* (`team-delete`) → `ConfirmDialog` "Delete <team>?" with
  the dialog's description; afterwards the store refreshes and the page resolves to the next team or the empty
  state.
- *Workspaces*: `WorkspacesTab` as the page body, unchanged (access panel included).
- `features/team/roles.ts`:

  ```ts
  export const WORKSPACE_ABILITIES = ['read', 'send', 'edit', 'share', 'manage-workspace'] as const;
  export type WorkspaceAbility = (typeof WORKSPACE_ABILITIES)[number];
  /** The least workspace role that may do each (ruling 15). */
  export const ABILITY_MIN_ROLE: Readonly<Record<WorkspaceAbility, WorkspaceRoleWire>> = {
    read: 'viewer', send: 'viewer', edit: 'editor', share: 'admin', 'manage-workspace': 'admin',
  };
  export const ABILITY_LABELS: Readonly<Record<WorkspaceAbility, string>>;
  export function roleCan(role: WorkspaceRoleWire | 'none' | undefined, ability: WorkspaceAbility): boolean;
  ```

  The inline role checks that are these abilities move onto `roleCan`: `tokens-section.tsx` `canManage`
  (`edit`), the webhooks store's manage gate if it compares roles inline (`edit`), `workspaces-tab.tsx`'s access
  and settings checks (`share`, `manage-workspace`). Others stay as they are.
- New `features/team/settings/roles-page.tsx`: a read-only table (`roles-table`): one row per ability, columns
  Viewer, Editor, Admin, a check where `roleCan`; under it "Manage people: team admins." and "Server admins are
  Admin on every workspace and manage every team."
- *Audit log* under This team (ruling 6): `AuditTab` with `teamId` = the team.

Tests:

- `team-roles.test.ts` (extend): `it('ABILITY_MIN_ROLE matches the server’s route guards')` — a literal
  expected table, each line commented with the guarding route file; `it('roleCan ranks viewer < editor < admin
  and refuses none')`.
- New `team-overview.test.tsx`: `it('a team admin renames on blur')`, `it('a member sees the name read-only')`,
  `it('counts members and workspaces and shows the created date')`, `it('a server admin deletes the team after
  confirming; a team admin has no danger zone')`.
- New `roles-page.test.tsx`: `it('one row per ability; the Viewer column checks only read and send')`.
- `team-workspaces.test.tsx` and the tokens-section tests: green unchanged.

Commit: `renderer: Overview, Workspaces and roles table in Team settings`.

### Task 11 — renderer: the Server group moves to Team settings

Files:

- `team-settings.tsx` renders the Server pages: `license` → `LicenseTab` (*License and seats*), `provisioning`
  → `ProvisioningSection` then `ProvisioningTab` (ruling 7; the SCIM card only with `settingsAvailable`),
  `domain` → `DomainTab`, `audit` → `AuditTab` for all teams, and the `ServerPage` pages with unchanged bodies.
  `ServerPage`'s heading becomes `SettingsPageHeader` with the same title and subtitle; `DeletionBanner` stays
  on every hosted page but Close this account.
- `server/delete-team-section.tsx` → `server/close-account-section.tsx` (`CloseAccountSection`); its copy
  says "Close this account" where it said "Delete team"; the typed-slug confirm and the `tenantDeletion` calls
  unchanged.
- The `LicenseBanner` the dialog shows a server admin shows at the top of every Team settings page for a server
  admin.

Tests:

- New `team-settings-server.test.tsx` (ruling 16): `it('a hosted team’s server admin sees the Server group
  with the team’s name, Billing and Close this account')`, `it('a self-hosted server shows its settings
  read-only, without Billing and Close this account')`, `it('Sign-in sends a typed client secret once and then
  shows it as Set')`, `it('Provisioning shows the SCIM card, then the groups card')`, `it('Close this account
  asks for the slug, then requests the deletion')`, `it('an older server without settings routes shows License,
  Provisioning and Audit log only')`.
- `server-settings.test.tsx`: section-body tests stay; its Settings-nav cases move to the file above.
- `domain-tab.test.tsx`, the audit and license tests: green unchanged.

Commit: `renderer: the Server group moves to Team settings; Delete team becomes Close this account`.

### Task 12 — renderer: entry points; Account and Server leave App settings

Files:

- `settings-model.ts`: drop the **Account** group and `accounts` / `tokens` from `SettingsSectionId`, `ICONS`
  and `SectionBody`, so a leftover `openPreferences('accounts')` fails typecheck.
- `preferences-editor.tsx`: drop `ServerNavGroup`, the `serverPage` state and the Server imports;
  `settings-page.tsx`: drop the server-settings load effect (Team settings has it).
- Callers:
  - `commands/register-account-commands.ts`: `account.signOut` with several servers → `openUserSettings('servers')`;
    new `account.settings` ("Account: Account settings"; `packages/wire/src/command-catalog.ts` and
    `commands.ts`) → `openUserSettings()`.
  - `account-status-item.tsx`: *Account settings…* (`account-manage` → `openUserSettings('servers')`) and
    *Signed-in devices…* (`account-devices` → `openUserSettings('devices')`) (ruling 13).
  - `state/exchanges.ts` `openPreferences('this-machine')`: unchanged (App settings keeps it).
- `app-shell.tsx`: `<TeamDialog />` mounts only when `!isBrowserTab()`; `team-dialog.tsx` unchanged.
- Docs that name Settings → Accounts, Devices & tokens, Settings → Server, or the browser's Team dialog
  (grep `docs/` and `packages/server/README.md`).

Tests:

- `settings-page.test.tsx` / `preferences-editor.test.tsx`: `it('App settings has no Account or Server
  group')` — no `settings-nav-accounts`, `settings-nav-tokens`, `settings-nav-server`.
- `account-commands.test.ts`: `it('Account settings opens User settings')`, `it('sign out with two servers
  opens Servers you’re signed in to')`.
- `account-status-item` test: the two renamed items open their user pages.
- `app-shell.test.tsx`: `it('a browser tab does not mount the Team dialog')`.
- `accounts-section.test.tsx`: follows the moved file; green.
- The command-catalog census test lists `account.settings`.

Commit: `renderer: Account and Server leave App settings; entry points open User and Team settings`.

### Task 13 — e2e

Browser — new `e2e/browser/team-settings.spec.ts` on the stack and seed of `browser-client.spec.ts`;
`seed.ts` gains a second team, an `existingEmail` account on no team, and makes the seeded user a server admin
if `admin invite` does not already:

- `test('the team link opens Team settings on People and keeps the address')` — `/?panel=team`; `team-settings`
  visible; the URL matches `/[?&]panel=team&team=[A-Za-z0-9_-]+&page=people/`.
- `test('switching team keeps the page and the address follows')`.
- `test('adding a person with an account makes them a member')`.
- `test('adding an email without an account makes an invitation and shows its link once')` — `add-people-link`
  contains `/invite/`; after closing, the row says "Invited as Member".
- `test('New link replaces the link; the old one no longer opens the invitation')` — the old link shows the
  invalid-link page, the new one the accept form.
- `test('Revoke removes the invitation')`.
- `test('leaving a team takes it out of the switcher')` — on the second team, with another admin on it.
- `test('as a server admin, a reload on a Server page stays on it')` — `page=sign-in`, reload,
  `server-page-sign-in` visible and its nav item current.
- `test('User settings shows your profile and renames you')` — from the palette's *Account settings*; the status
  bar label follows.
- `browser-client.spec.ts`: its deep-link test is rewritten for Team settings (it asserted the dialog and a
  stripped address; ruling 17). The closing "no page broke its CSP or logged an error" check also runs at the
  end of the new file.

Desktop — `e2e/specs/`:

- `team.spec.ts`, `audit.spec.ts`, `license.spec.ts`, `team-domain.spec.ts`, `saml-sign-in.spec.ts`: green
  unchanged — the fake server lists no `browser-client`, so *Manage team…* opens the fallback dialog, which is
  spec §8's "fallback still opens" check.
- `team.spec.ts`: `test('with browser-client listed, Manage team opens the browser and no dialog')` — the fake
  server started with `capabilities: ['sync', LIVE_CAPABILITY, 'browser-client']`; the window's open handler
  records `<server>/?panel=team`; `team-dialog` never visible.
- The nearest Settings spec: `test('App settings has no Account or Server group')`.
- `server-settings.spec.ts`: deleted (ruling 16).
- Specs that click `settings-nav-accounts`, `settings-nav-tokens`, `account-manage` or `account-devices-tokens`
  open User settings instead (grep `e2e/`).

Commit: `e2e: Team settings in the browser; desktop entry points and fallback`.

### Task 14 — docs and changelog

- `CHANGELOG.md` `[Unreleased]` — Added: User settings, Team settings in the browser, renew an invitation,
  edit your name. Changed: App settings groups; Account and Server moved out; Delete team → Close this account;
  the status bar menu's items. Removed: Settings → Server in the desktop.
- `docs/` pages on settings, teams and invitations; `packages/server/README.md` routes (`renew`, `PATCH /me`).
- `pnpm check:banned-terms` green.

Commit: `docs: app, team and user settings`.

### Task 15 — ship

- [ ] `pnpm test:perf`; push; `gh pr create` to `main` (no merge); Auto-fix on for the PR.

## Order and parallel work

Tasks 2–4 are server, wire and host only and can run beside Tasks 5–6. Task 7 needs 4–6; Task 8 needs 5–6;
Tasks 9–11 need 8 (and 9 needs 4 for renew); Task 12 needs 7 and 11; Task 13 needs everything before it.
Tasks 2 and 3 touch different route files but share `route-map.ts` and the README, so the second rebases.
