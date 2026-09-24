# Intent: Wirebench Server — sign-in, teams, workspace roles

- Date: 2026-09-24
- Confirmed with the owner via interview; feeds the Wirebench Server spec (issue #74)
- Builds on: `docs/specs/2026-09-13-wirebench-shared-workspaces-design.md` (§5.4 fixes the server socket)

## Statement

- **Outcome:** a self-hosted Wirebench Server that hosts shared-workspace repositories and lets a team
  admin manage who is on the team and what role each member has per workspace.
- **User:** the owner's own team first, including QA and analysts who have no git hosting account;
  enterprise customers inherit it later.
- **Why now:** git-only sharing gives everyone who can read the power to edit and push, and it excludes
  people without git.
- **Success:** a non-git teammate signs in from the app, opens a shared workspace they were granted, sends
  requests, and cannot push edits as a viewer; an admin adds, removes and re-roles members without
  touching a git host.
- **Constraint:** both local accounts (invite by email) and OIDC from day one; the app stays fully usable
  without an account; the server never holds plaintext secrets; the server runs the same Node engine and
  merge code as the client.
- **Out of scope (this slice):** live updates and presence, SAML, SCIM, audit log, per-project or
  per-environment roles, a cloud operated by Wirebench, shared secret values (#38).

## Decisions taken during the interview

| Question | Answer |
| --- | --- |
| Where does sign-in live? | Self-hosted server inside the customer's network |
| Why now? | The owner's own team needs it (dogfooding), not a sales gate |
| What breaks with git-only sharing? | No roles; not everyone has git |
| Roles and unit | Viewer / editor / admin, assigned per workspace by a team admin |
| Identity | Local accounts and OIDC, both from day one |
| First slice | Server transport behind `SyncBackend` + sign-in + teams + roles |
