# Team management in the browser — implementation plan

**Goal:** the Team dialog lives in the browser client; the desktop's *Manage team…* opens it there on the
right server and team; an invitee can accept in the browser.

**Spec:** `docs/specs/2026-11-06-team-management-in-browser-design.md` (rulings in §3); hosted edition spec §24.

## Global constraints

- `WIREBENCH_SERVER_BROWSER_CLIENT` off changes nothing on the server.
- Reuse the invitation claim; no second copy of its transaction.
- One commit per task after `WIREBENCH_SKIP_PERF=1 pnpm check` is green, as Mohammed Naami
  <m.naami@outlook.com>, no trailers. No local Electron or e2e windows; e2e runs in CI.

## Tasks

### Task 1 — spec and plan

- [ ] This plan, the design, and §24 in the hosted edition spec pointing at it.

### Task 2 — server: `browser-client` capability and browser invite acceptance

- [ ] `host/module.ts`: `ctx.meta.addCapability('browser-client')` when on.
- [ ] `identity/invitations.ts`: split `acceptInvitation` into `claimInvitation` (returns the user) plus
      the desktop's `signIn`; behaviour of `POST /invitations/accept` unchanged.
- [ ] `identity/invite-page.ts`: a browser variant (form, SSO links, desktop instructions), reset variant,
      a message slot.
- [ ] `identity/routes/invite-page.ts`: render the browser variant when on, with the sign-in page's CSP and
      `same-origin` referrer policy.
- [ ] `identity/routes/browser-invite.ts`: `POST /invite/:secret` in the form scope of `browser-sign-in.ts`.
- [ ] Tests: `test/integration/identity/browser-invite.test.ts`; the tenancy route map gains the route;
      `/meta` lists the capability only when on.

### Task 3 — renderer: deep link opens the dialog

- [ ] `ui.ts`: `teamDialog.target` (`{ teamId?, workspaceId? }`), `openTeamDialog(url?, target?)`.
- [ ] `state/team.ts`: `open(url, target?)` picks the team from the target on the first load.
- [ ] `features/team/team-link.ts`: `readTeamDeepLink` / `takeTeamDeepLink` (parse, validate, strip).
- [ ] `app-shell.tsx`: take the link once at mount and open the dialog.
- [ ] Tests: parser, store selection, shell effect.

### Task 4 — renderer: *Manage team…* opens the browser from the desktop

- [ ] `lib/capabilities.ts`: `isBrowserTab()`.
- [ ] `features/team/team-link.ts`: `teamPageUrl`, `manageTeam(url?)`.
- [ ] The three entry points call `manageTeam`; labels *Manage team…*; catalog label.
- [ ] e2e specs: command label.
- [ ] Tests: `manageTeam` cases; the entry-point tests.

### Task 5 — docs and changelog

- [ ] `packages/server/README.md` (invitations, teams), `docs/` pages that describe the Team dialog and
      invitations, `CHANGELOG.md` `[Unreleased]`.

### Task 6 — ship

- [ ] `pnpm test:perf`, push, `gh pr create` (no merge).
