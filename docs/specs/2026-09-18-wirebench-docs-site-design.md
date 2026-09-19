# Spec: Documentation Site

- Status: **approved** (2026-09-18).
- Plan: `docs/plans/2026-09-18-wirebench-docs-site-plan.md`.
- Date: 2026-09-18 (supersedes the 2026-09-14 scaffold spec).
- Issue: [#29](https://github.com/wirebench/wirebench/issues/29) · Roadmap item 2.
- Branch: `feat/docs-site`, rebased onto `main` at `6bbf468`.

## Assumptions

1. The site stays in `docs-site/` as a pnpm workspace package on Astro Starlight with Pagefind search.
2. The Scalar API explorer, `public/specs/wirebench-api.json`, `Endpoint.astro` and `MethodBadge.astro`
   are removed. Wirebench has no public HTTP API to document.
3. The site is published at the default Pages URL, `https://wirebench.github.io/wirebench/`
   (`base: '/wirebench'`). There is no custom domain.
4. The site documents the release on `main`. There are no versioned docs yet.
5. English only.
6. The site describes Wirebench on its own terms. No page, style comment or spec names another product as
   the source of a look or a feature. The scaffold's "inspired by" wording is removed.

## 1. Objective

**What.** A published user manual that lets a new user install Wirebench, send a first request in ten
minutes, and then find a guide for any feature area without opening an issue.

**Who.** Integration and QA engineers and backend developers who install the desktop app, and platform
teams who evaluate it for enterprise rollout.

**Why.** A release that people can install but cannot learn sends every question to the issue tracker.
The scaffold predates the importers, gRPC and the HTTP Log rework.

## 2. Content

| Section | Pages |
| --- | --- |
| Getting started | Introduction; install and first run for macOS, Windows and Linux (download, first-launch security prompts, where data lives); ten-minute walkthrough |
| Guides (one per feature area) | Workspaces and projects; SOAP and WSDL; REST; gRPC (reflection, streaming, message completion); importers (WSDL, OpenAPI, cURL, legacy SOAP project); environments and properties; auth, OAuth 2 and keystores; secrets; HTTP Log; history; shared workspaces and sync (share, join, pull, conflicts); preferences and layout |
| Reference | Commands and shortcuts (generated); project folder format; property expansion syntax; WS-I assertions (links to `docs/ws-i-assertions.md`, not duplicated) |
| Help | Troubleshooting (install blocked, Git not found, TLS and proxy, import failures, HTTP Log reading); FAQ |

Every guide opens with what the feature is for, then gives task-shaped steps with a screenshot, then
limits and related links. No stubs: a page that isn't written isn't in the sidebar.

## 3. Generated reference: commands and shortcuts

- `scripts/docs-commands.ts` reads the command definitions (id, label, category, `shortcut`,
  `extraShortcuts`) and writes `docs-site/src/content/docs/reference/commands.md`, grouped by category.
  Shortcuts are shown for macOS and for Windows/Linux.
- `node scripts/docs-commands.ts --check` exits non-zero when the committed page is stale. It uses the
  same pattern as `scripts/wsi-docs.ts --check` and is added to `pnpm check` as `pnpm docs:commands --check`.
- The hand-written `reference/shortcuts.md` is deleted and replaced by the generated page.

## 4. Screenshots

- `e2e/specs/docs-screenshots.spec.ts` drives the real app and writes PNGs to
  `docs-site/public/images/<page>/<name>.png`. It reuses the helpers from `screenshots.spec.ts`: fixed
  window size, light theme, and masks over timings.
- `pnpm docs:screenshots` (which runs `pnpm build` and then that spec) refreshes them. The PNGs are
  committed.
- `scripts/check-docs-images.ts` fails when a page references an image that doesn't exist, or when an
  image isn't referenced by any page. It runs in `pnpm check`.
- The scaffold's seven hand-captured images are replaced by images from the spec.

## 5. Publishing

- `.github/workflows/docs.yml` builds on every push to `main`, with no `paths` filter, because the
  generated reference and the screenshots depend on app code. It also builds on `workflow_dispatch`.
- Pull requests that touch `docs-site/**` run `pnpm docs:build` as a check, without deploying.
- Actions are pinned to major versions, the same way the existing workflows pin them.

## 6. Checks extended to the site

- `check:banned-terms` already scans every tracked file, so `docs-site/` is covered. A test proves it
  with a fixture under `docs-site/`.
- `check:doc-paths` is extended to `docs-site/src/content/**`. Repo paths written in backticks must exist,
  and internal site links must resolve to a page.
- The Starlight build fails on broken internal links via `starlight-links-validator`. Approved
  2026-09-18.

## Tech stack

Astro and `@astrojs/starlight` at the versions already on the branch, plus Pagefind (built in). Node 24
and pnpm 9.13.2, matching the root `package.json`.

## Commands

```
Dev:          pnpm docs:dev
Build:        pnpm docs:build
Screenshots:  pnpm docs:screenshots
Commands ref: pnpm docs:commands            # write
              pnpm docs:commands --check    # verify (in pnpm check)
Image check:  pnpm check:docs-images        # in pnpm check
Gate:         WIREBENCH_SKIP_PERF=1 pnpm check
```

## Project structure

```
docs-site/src/content/docs/   getting-started/ guides/ reference/ help/
docs-site/public/images/      generated screenshots, one folder per page
scripts/docs-commands.ts      generated command and shortcut reference
scripts/check-docs-images.ts  image reference check
e2e/specs/docs-screenshots.spec.ts
.github/workflows/docs.yml
```

## Code style

Scripts follow `scripts/wsi-docs.ts`: a top doc comment that states what the script writes and what
`--check` does, `node:` imports, no new runtime dependencies. Pages are plain Markdown. MDX is used only
where a Starlight component (`Tabs`, `Aside`, `Steps`) earns its place. Prose uses short sentences and
describes behaviour directly.

## Testing strategy

- Vitest unit tests for `docs-commands.ts` (grouping, platform shortcuts, `--check` on a stale file) and
  `check-docs-images.ts` (missing and orphaned images).
- `pnpm docs:build` in CI on pull requests.
- The screenshot spec runs in CI e2e. Local runs are headless only.

## Boundaries

- **Always:** run `WIREBENCH_SKIP_PERF=1 pnpm check` before each commit, with one commit per task; take
  screenshots only from the spec; keep generated files in sync with `--check`.
- **Ask first:** new npm dependencies; a custom domain; versioned
  docs; changing the root `pnpm check` order.
- **Never:** name other products as the source of a look or behaviour; commit hand-made or mocked-up
  images; duplicate `docs/` engineering specs into the site; open local Electron windows while the owner
  is working.

## Success criteria

- [x] `feat/docs-site` is rebased onto `main`, and Scalar and its components and spec are gone.
- [x] Every page in the Content table exists with real content. The walkthrough goes from install to a
      sent SOAP request and a sent REST request.
- [x] Guides for the importers, gRPC and the HTTP Log match current behaviour.
- [x] `pnpm docs:commands --check` passes, and fails after a shortcut is changed without regenerating.
- [x] Every image comes from `docs-screenshots.spec.ts`, and `pnpm check:docs-images` passes.
- [x] `pnpm check` passes, including banned terms and doc paths across `docs-site/`.
- [x] A push to `main` deploys to GitHub Pages, and the site loads with working search.

## Resolved questions

1. Command definitions live in the renderer `register-*-commands.ts` files next to their handlers. Their
   static fields (id, label, category, shortcuts) move to `apps/desktop/src/shared/command-catalog.ts`
   before the generator is written, and registration looks them up by id.
2. GitHub Pages must use "GitHub Actions" as its source. The owner switches this repo setting.
