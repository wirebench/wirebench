# App, team and user settings — design

Date: 2026-11-07 · Status: approved by the owner (decisions 1–6 below are final) · Amends:
`docs/specs/2026-11-06-team-management-in-browser-design.md` §2 (the Team dialog becomes a page) and the
Settings page of #396 (its Account and Server groups move out) · Plan: `docs/plans/2026-11-07-settings-split.md`

## 1. Owner decisions

1. **Three settings areas.** *App settings* (how the app works on this computer), *Team settings* (the team
   and its server) and *User settings* (you, on every server). Each is a full page in the window, with its
   own left menu, in place of the workbench, like today's Settings page.
2. **Team settings replaces the Team dialog** in the browser client. The desktop keeps *Manage team…*,
   which opens the browser (team management in the browser §2.1), and keeps the dialog only as the
   fallback for a server without the `browser-client` capability.
3. **The server-admin pages live in Team settings,** in a *Server* group at the bottom of its menu, shown to
   server admins only. In the hosted edition the server is the team, so they belong together.
4. **The machine pages stay in App settings:** *This machine* and *Paired browsers* are about this
   computer, not about a person or a team.
5. **Members and open invitations are one list** (*People*), filtered by All, Joined and Waiting.
6. **The layout is Wirebench's own.** Menu names follow who a change affects; no other product's menu is
   reproduced.

## 2. The three areas

| Area | Opens from | Menu |
| --- | --- | --- |
| App settings | the activity bar's Settings button, ⌘, / Ctrl+, , *Preferences* in the palette | **General**: Appearance, Behaviour, Features, Plugins, Keyboard shortcuts, Updates · **Protocols**: HTTP, REST, WSDL, WS-I · **Network and tools**: Proxy, SSL / TLS, Git, Mock services, Terminal, SSH, Secrets · **This computer**: This machine, Paired browsers |
| Team settings | *Manage team…* (palette, account menu, User settings → Servers row) | team switcher · **This team**: Overview, People, Workspaces, What roles can do · **Server** (admin): License and seats, Sign-in, Provisioning, Domain, Email, Audit log, Audit forwarding, Retention, Export, Billing (hosted), Close this account (hosted) |
| User settings | your name in the status bar, *Account settings* in the palette | **You**: Profile, Password · **Access**: Servers you're signed in to, Signed-in devices, CI tokens |

- App settings keeps today's sections and their order (`settings-model.ts`); the groups are renamed as in
  the table, and the Account and Server groups leave it.
- Each page has a header (title and one-line subtitle) and a *Back to workspace* link; Escape does the same.
- App settings and User settings exist in the desktop and the browser client. Team settings exists in the
  browser client only (decision 2).
- Settings search (today's search box) searches the area it is in.

## 3. Team settings

### 3.1 Team switcher

- A button at the top of the menu: the team's initial in a square, its name, a chevron. It opens a list of
  the caller's teams on this server; picking one opens that team's *Overview* and makes it the title bar's team when
  this is the active account's server (team overview landing, 2026-11-09).
- Server admins also see *New team…* at the end of the list. It asks for a name in a small dialog, creates
  the team (`POST /api/v1/teams`) and switches to it on *Overview*, where a setup list waits.
- With no team: a server admin lands on an empty state, "Create your first team", with *New team…*; anyone
  else sees "You're not on a team on this server yet. A server admin can add you." The Server group still
  shows to a server admin.

### 3.2 Overview

- Where picking a team lands (the switcher above, *New team…*, *Manage team…*, and the browser tab's title-bar
  team switcher; the desktop's title-bar switcher only changes the team you work in).
- The team's initial and name (editable by team admins, saved on blur or Enter, `PATCH /api/v1/teams/:id`), your
  role and the date it was created.
- Tiles that open their page: People (joined and waiting), Workspaces, and for a server admin the server's seats
  (`GET /api/v1/license`).
- The team's workspaces as rows (§3.4) with an *Open now* mark on the open one; no Open button (owner ruling):
  opening stays with the workspace list and the title bar.
- Team admins: *Add people*, *New workspace…*, the invitations still waiting with *New link*, and — until the team has
  a second person (joined or invited) and a workspace — a three-step setup list.
- *Delete this team* in a danger zone at the bottom, server admins only, behind a confirm dialog that
  names the team (`DELETE /api/v1/teams/:id`).

### 3.3 People

- One list: every member, then every open invitation. Filters: *All*, *Joined*, *Waiting*, each with its
  count; a *Find a person* box matches name and email.
- A member row: initials, name, email, the date they joined, their role. A team admin changes a role with a
  select (`PATCH …/members/:userId`); other rows show the role as text. *Remove* sits in the row's ⋯ menu.
- Your own row says "· you" and carries *Leave team* (`DELETE …/members/<you>`).
- An invitation row: a dashed mail icon, the email, "Invited as <role> · link expires in N days". Admins
  get *New link* and *Revoke*.
- *Add people* (team admins): one dialog with email and role. The client adds the person as a member
  (`POST …/members`); when the server answers that no account has that email (`teams-user-unknown`), it creates
  an invitation (`POST …/invitations`) and shows the link with *Copy*. The dialog says which happened.
- The server refuses removing or demoting the last admin (`teams-last-admin`); the row shows that message.
- A server admin sees "N of M seats in use on this server" under the list, from `GET /api/v1/license`.

### 3.4 Workspaces and roles

- *Workspaces* lists the team's workspaces as rows, the same rows as Overview: name, "Created <date> by <name>",
  the default access and how many have a grant (`createdByName` and `grantCount` on the team workspace, optional
  for an older server), your role. *New workspace…* sits above. (2026-11-09 owner ruling: one row style.)
- A row opens the workspace's overview (`page=workspace&workspace=<id>`, under *Workspaces* in the menu): a
  breadcrumb back, today's workspace card (name, role, *Access…*, *Delete*, default access, recording, features),
  when and by whom it was made, and *Who can open it* (the access panel inline) for those who may share it. The
  desktop's fallback Team dialog keeps the cards.
- *What roles can do* is a read-only table of Viewer, Editor and Admin against what each may do (read,
  send, edit, share, manage people, manage workspaces), plus a line on server admins. It is built from the
  renderer's `roles.ts`, so the table and the checks cannot drift.

### 3.5 Server group

- Today's Settings → Server pages (`server-page.tsx`) move here unchanged, joined by the Team dialog's
  License, Audit and Domain tabs as pages *License and seats*, *Audit log* and *Domain*.
- The hosted-only *Delete team* page is renamed *Close this account*, so it can't be mistaken for deleting a
  team (§3.2).

## 4. User settings

- *Profile*: your name (editable), your email and your sign-in methods, from `GET /api/v1/me`.
- *Password*: today's change-password form (`POST /api/v1/me/password`); hidden when local passwords are off.
- *Servers you're signed in to*: today's Accounts section, with *Manage team…* on each row.
- *Signed-in devices*: `GET /api/v1/me/devices`, each with *Sign out* (`DELETE /api/v1/me/devices/:id`).
- *CI tokens*: today's section (tokens of the open server workspace).
- With several servers signed in, Profile, Password and Signed-in devices show a server picker at the top.

## 5. Addresses

- In the browser client each Team settings page has an address that reload and bookmarks keep:
  `/?panel=team&team=<id>&page=<page>`, written with `history.replaceState` as the page changes.
  `<page>` is one of `overview`, `people`, `workspaces`, `roles` or a Server page id. The existing
  `panel=team[&team][&workspace]` link opens *Overview*.
- Ids follow the browser deep-link rule (1–64 characters of `[A-Za-z0-9_-]`); an unknown team falls back to
  the first, an unknown page to *Overview*.

## 6. Server changes

1. `POST /api/v1/teams/:teamId/invitations/:id/renew` (team admin): in one transaction, revokes the open
   invitation and creates a new one for the same email and role; answers like the create (201 with `url`).
   Needed because the server keeps one open invitation per email and stores only the link's hash, so
   the old link can't be shown again and revoke-then-create from the client could lose the invitation.
2. `PATCH /api/v1/me` with `{ name }` (1–100 characters, trimmed), audited as `identity.profile-updated`.

No other endpoint changes: every page reads and writes through routes that exist today, with their role checks.

## 7. Rulings

- **Team settings is browser-only; User settings is not.** Your profile and devices are about you, and the
  desktop already shows the signed-in servers.
- **The Server group moves out of App settings in the desktop too.** A server admin in the desktop opens it
  through *Manage team…*, like the rest of Team settings.
- **No avatars or team images.** Initials only; the server stores no images and this change adds none.
- **No reusable invite links.** Every invitation stays one-time and tied to an email, as the identity
  design requires.

## 8. Testing

- Unit: the three menus (which pages show for a member, a team admin, a server admin, hosted and
  self-hosted); the People list merge and filters; the address parse and write.
- Server: `renew` (role check, one transaction, old link refused after, audit); `PATCH /me` (validation,
  audit).
- Browser e2e: open Team settings from the link, switch team, add a person with an account and one without,
  renew and revoke an invitation, leave a team, reload on a Server page as admin.
- Desktop e2e: *Manage team…* still opens the browser; the fallback dialog still opens without the capability;
  App settings no longer shows Account or Server.
