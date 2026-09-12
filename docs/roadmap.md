# Roadmap follow-ups

Not gaps in v1 — things noticed while building it that are deliberately out of scope for now,
recorded here so they are not lost.

- **Same-host `http://` → `https://` 301 on a POST.** `packages/engine/test/interop/public-services.test.ts`
  posts straight to the redirect target for `tempconvert` (see the comment on that fixture)
  because Wirebench does not follow redirects on `send` by default: `fetch`/undici semantics
  downgrade a redirected POST to a GET, which would silently turn a SOAP call into a page fetch
  and lose the envelope. That is the right default, but a same-host, same-path `http→https`
  upgrade is common enough (`tempconvert` is a live example) that it is worth a purpose-built
  case: either preserve the method and body across exactly that redirect shape, or — if that is
  judged too surprising to do silently — detect it and surface a Problem telling the user their
  request was declined rather than silently sent nowhere. Left as a follow-up because it is a
  design decision (which of the two, and how narrow "same-host, upgrade-only" needs to be) that
  a bug-fix pass should not make in passing.

- **Multi-window.** The workspaces design (`docs/specs/2026-09-11-wirebench-workspaces-design.md`
  §1, assumption 7) deliberately keeps one window holding one open workspace at a time. Several
  workspaces open at once, each in its own window, is a natural next step but changes how main's
  singletons (the open `WorkspaceService`, dialog picks) are scoped, so it is left as a
  follow-up rather than folded into workspaces v1.
- **Workspace sharing/syncing.** Nothing propagates a workspace's projects or environments to
  another machine or another person today — a workspace is one user's local app-data folder.
  Export/link/import are the only way a project crosses machines, one project at a time. Sharing
  a whole workspace (its environments, its project set) is a deliberately deferred idea, not a
  gap in what shipped (`docs/adr/0006-workspaces-in-app-data.md`, Consequences).
