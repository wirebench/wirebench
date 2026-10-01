# Spec: Website

- Status: **approved** (2026-10-01).
- Plan: `docs/plans/2026-10-01-wirebench-website-plan.md`.
- Date: 2026-10-01.
- Issue: opened after this spec is merged (milestone 2.2 — Install and learn, `area: docs`,
  `area: release`, `audience: dev`).
- Branch: `docs/website-spec` for this spec; `feat/website` for the implementation.

## Assumptions

1. The site is served from the default GitHub Pages URL, `https://wirebench.github.io/wirebench/`, with
   the `/wirebench` base path. A custom domain is a later change that touches only the `site` setting, the
   base paths and a CNAME file.
2. The landing site is its own pnpm workspace package, `site/`, on plain Astro without Starlight. The
   docs site stays in `docs-site/` and moves from `/wirebench/` to `/wirebench/docs/`. Existing doc URLs
   change once; nothing outside this repository links to them yet.
3. The landing site is product-led: the app is the hero, every claim is a screenshot of the real app, and
   teams, editions and pricing are not on it. Those pages come with the licensing work
   (`docs/specs/2026-10-01-wirebench-server-licensing-design.md`), not before it ships.
4. The site describes Wirebench on its own terms. No page, component, comment or style names another
   product; `pnpm check:banned-terms` scans every tracked file and covers `site/` with no change.
5. English only. No analytics, no cookies, no newsletter, no blog.
6. Download links are built from the latest GitHub Release at build time. The site never carries a
   hand-written version number.

## 1. Objective

**What.** A landing site at the Pages root that lets a visitor understand what Wirebench is in ten
seconds, download the right installer in one click, and reach the user guide in one more.

**Who.** Integration and QA engineers and backend developers who are deciding whether to install it.

**Why.** Today the Pages root is the user guide's introduction. A guide assumes the reader has already
chosen the product; a visitor who has not needs the pitch, the pictures and the download first.

## 2. Pages

| Path | Page |
| --- | --- |
| `/wirebench/` | Home |
| `/wirebench/features/` | Features |
| `/wirebench/download/` | Download |
| `/wirebench/404.html` | Not found (GitHub Pages serves it for any unknown path, docs included) |
| `/wirebench/docs/` | The user guide, unchanged apart from its base path |

Every other destination is a docs page or the GitHub repository. There are exactly three pages; a
fourth needs a new spec.

## 3. Home

Sections, top to bottom:

1. **Nav.** Wordmark (the `hero-mark.svg` from the docs site, copied into `site/`), then Features,
   Download, Docs, GitHub. Collapses to a single row with the wordmark and a Download button at phone
   width; the other links move to the footer, there is no hamburger menu.
2. **Hero.** Headline "One workbench for SOAP, REST and gRPC." One supporting sentence: import a WSDL,
   an OpenAPI document or a `.proto` set, get a request from the contract, send it, read the response.
   Two buttons: **Download** (primary, to the download page) and **Read the docs**. Under them the
   response-pane screenshot at 1280×800, shown at full width on desktop and cropped to its left two
   thirds at phone width.
3. **Protocol switcher.** Three tabs, SOAP, REST, gRPC. Each tab shows one screenshot and three bullets
   taken from the README's first paragraph: SOAP — generated from the WSDL, WS-Security and
   WS-Addressing, MTOM/SwA attachments and WS-I validation; REST — OpenAPI import or start from a URL,
   every body kind, Basic/NTLM/Bearer/API-key/OAuth2; gRPC — `.proto` import or server reflection,
   unary and streaming, status, replies and trailers in one pane. Below the tabs one line: all three
   share one project, one set of environments, one history and one HTTP stack. The tabs are real
   buttons with `aria-selected`, keyboard-reachable, and the first tab's panel is rendered without
   JavaScript.
4. **Projects live in git.** A monospace folder tree of a real project (taken from the project format
   reference page, not invented) beside three bullets: small YAML and XML files made for review; export
   and link to a folder when a project meets git; credentials never go in them, with a link to the
   secrets guide.
5. **Beyond the desktop.** Four cards, each one sentence and a "Read the guide" link: CLI and CI
   (`guides/run-in-ci`), snapshot regression (`guides/snapshot-regression`), shared workspaces
   (`guides/shared-workspaces`), agents over MCP (`guides/agents-mcp`).
6. **Download band.** "Free and open source, Apache-2.0." Download button and the three platform names.
7. **Footer.** Docs, GitHub, releases, code-signing policy (`help/code-signing-policy`), licence.

## 4. Features

The protocol switcher in long form, one section per area, each with a heading, a paragraph, one
screenshot and a "Read the guide" link into the docs: SOAP and WSDL, REST, gRPC, WebSocket and SSE,
importers and switching, environments and properties, authentication and secrets, HTTP Log and history,
sequences and scripts, snapshot regression, shared workspaces, webhooks, CLI and agents. The section
list mirrors the docs sidebar so the two cannot drift far apart; a feature without a guide is not on
the page.

## 5. Download

- A table of every installer from the latest release, grouped by platform and in this order:

  | Platform | Installers |
  | --- | --- |
  | macOS | Universal `.dmg`, Apple silicon `.dmg`, Intel `.dmg` |
  | Windows | x64 setup `.exe`, arm64 setup `.exe`, x64 `.msi`, arm64 `.msi` |
  | Linux | x86_64 and arm64 `.AppImage`, amd64 and arm64 `.deb`, x86_64 `.rpm`, amd64 `.snap` |

- Each row shows the file name and size. The version and date head the page, with a link to the release
  notes on GitHub.
- A small inline script reads `navigator.userAgentData.platform`, falling back to `navigator.platform`,
  and moves the visitor's platform group to the top with a "For your Mac / PC / Linux machine" label.
  Without JavaScript the page is the full table in the fixed order; nothing is hidden.
- Below the table: a line to the install guide (`getting-started/installation`) for first-launch
  prompts, and a line to the code-signing policy.
- **Release data.** `site/src/data/release.ts` fetches
  `https://api.github.com/repos/wirebench/wirebench/releases/latest` at build time, sends `GITHUB_TOKEN`
  as a bearer token when the environment has one (the Pages workflow does), and maps assets to the table
  by the artifact names in `apps/desktop/electron-builder.yml`:
  `Wirebench-<v>-mac-<universal|arm64|x64>.dmg`, `Wirebench-<v>-windows-<x64|arm64>-setup.exe`,
  `Wirebench-<v>-windows-<x64|arm64>.msi`, `Wirebench-<v>-linux-<x86_64|arm64>.AppImage`,
  `wirebench_<v>_<amd64|arm64>.deb`, `wirebench-<v>.x86_64.rpm`, `wirebench_<v>_amd64.snap`.
  The build fails when the request fails or any listed installer is missing from the release: a stale
  or incomplete download page is worse than no deploy. `.zip`, `.blockmap`, `latest*.yml` and the SBOM
  are not listed.
- `pnpm site:dev` without network reads `site/src/data/release.fixture.json`, a copy of one real
  release's asset list, when `WIREBENCH_SITE_OFFLINE=1` is set. The same fixture feeds the unit tests.

## 6. Look

- Tokens: the terracotta accent on the warm near-black ramp, copied from `docs-site/src/styles/custom.css`
  into `site/src/styles/tokens.css` as `--wb-*` variables. Dark by default; light under
  `prefers-color-scheme: light`, with the same light ramp the docs use. No theme toggle on the landing
  site.
- Type: the system sans stack for text, `ui-monospace` for the folder tree, file names and code. No
  web fonts.
- Imagery: real screenshots only, from the e2e screenshot spec, and the wordmark. No illustrations, no
  stock art, no mocked-up windows.
- Layout: a single centred column, 72rem wide at most, 16px side gutter, no horizontal scroll at 360px.
  Screenshots carry `width` and `height` so nothing shifts while they load, and `loading="lazy"` below
  the hero.
- Accessibility: every text and surface pair in the tokens file clears WCAG AA, enforced by the contrast
  check (section 8); skip link, visible focus rings, one `h1` per page, alt text that says what the
  screenshot shows.

## 7. Package and deploy

- `site/` joins `pnpm-workspace.yaml` as `@wirebench/site` with `astro` at the version `docs-site/` uses,
  no other dependencies, `base: '/wirebench'`, `site: 'https://wirebench.github.io'`, and the same
  `passthroughImageService`.
- `docs-site/astro.config.mjs` changes `base` to `/wirebench/docs`. Its content, sidebar and search are
  untouched. Every `/wirebench/images/` citation in its pages becomes `/wirebench/docs/images/`, and
  `scripts/check-docs-images.ts` matches the new prefix.
- Root scripts: `site:dev`, `site:build`, `site:preview` mirroring the `docs:*` scripts, and
  `site:assemble`, which runs both builds and copies `docs-site/dist` into `site/dist/docs`. The
  assembled folder is what Pages serves.
- `.github/workflows/docs.yml` becomes `site.yml`, named "Site". It runs `pnpm site:assemble`, uploads
  `site/dist` as the Pages artifact on pushes to `main` and `workflow_dispatch`, and only builds on pull
  requests that touch `site/**`, `docs-site/**` or the workflow. Same concurrency rule, same pinned
  action majors.
- `docs/roadmap.md`'s docs-site entry gains one sentence on the landing site and the moved docs path.

## 8. Screenshots and checks

- `e2e/specs/docs-screenshots.spec.ts` gains the landing site's shots, written to
  `site/public/images/<page>/<name>.png` with the same window size, theme and masks. The home page
  reuses the response, REST response and gRPC screenshots the docs already take, written a second time
  to the site folder rather than referenced across packages, so each package's image check stays
  self-contained.
- `scripts/check-docs-images.ts` takes a list of (content dir, images dir, URL prefix) triples and checks
  `docs-site/` and `site/` alike: a cited image must exist and every image must be cited. For `site/`,
  content is `site/src/**/*.astro` and the prefix is `/wirebench/images/`.
- `scripts/contrast-check.ts` reads `site/src/styles/tokens.css` as a second tokens file with its own
  pair list: body text, muted text, link and button label on each surface, in both themes.
- Every link from the site into the docs is a slug in one module, `site/src/docs-links.ts`. A Vitest
  test resolves each slug to a file under `docs-site/src/content/docs/` and fails on a slug with no page,
  which is the landing site's version of the docs site's link validator.
- `scripts/check-doc-paths.ts` is not extended: the site has no backticked repo paths.
- `pnpm check` gains nothing new at the top level; the existing image and contrast steps cover the site
  and the Vitest run picks up the new tests.

## Tech stack

Astro at the version pinned in `docs-site/package.json`, no integrations, no UI framework, no CSS
framework. Node 24 and pnpm 9, matching the root `package.json`. The tab switcher and the platform
detection are two small inline scripts, together under 2 KB.

## Commands

```
Dev:          pnpm site:dev            # WIREBENCH_SITE_OFFLINE=1 to skip the release fetch
Build:        pnpm site:build
Assemble:     pnpm site:assemble       # site + docs under site/dist, what Pages serves
Preview:      pnpm site:preview
Screenshots:  pnpm docs:screenshots    # writes docs-site/ and site/ images
Image check:  pnpm check:docs-images   # in pnpm check
Contrast:     pnpm contrast:check      # in pnpm check
Gate:         WIREBENCH_SKIP_PERF=1 pnpm check
```

## Project structure

```
site/astro.config.mjs
site/package.json
site/public/images/<page>/        generated screenshots
site/public/favicon.svg           copied from docs-site
site/src/pages/index.astro        home
site/src/pages/features.astro
site/src/pages/download.astro
site/src/pages/404.astro
site/src/layouts/Base.astro       head, nav, footer, skip link
site/src/components/              Hero, ProtocolTabs, FolderTree, FeatureCard, DownloadTable
site/src/data/release.ts          latest-release fetch and asset mapping
site/src/data/release.fixture.json
site/src/docs-links.ts            every docs slug the site links to
site/src/styles/tokens.css        --wb-* tokens, both themes
site/src/styles/site.css
site/test/                        Vitest: release mapping, docs links
scripts/check-docs-images.ts      now covers site/ too
scripts/contrast-check.ts         now reads site/src/styles/tokens.css too
e2e/specs/docs-screenshots.spec.ts
.github/workflows/site.yml        replaces docs.yml
```

## Code style

Components are `.astro` files with a short leading comment saying what the component shows. Styles are
scoped per component with the tokens file as the only global sheet. Scripts in `scripts/` follow the
existing pattern: a top doc comment stating what the script checks, `node:` imports, no new runtime
dependencies. Copy uses short sentences, names behaviour directly and never a competitor.

## Testing strategy

- Vitest for `release.ts` (asset mapping from the fixture; a missing installer throws; the token header
  is sent only when set), `docs-links.ts` (every slug has a page), the extended image check (both
  packages, missing and orphaned cases) and the extended contrast check (the site tokens file).
- `pnpm site:assemble` on pull requests, so a broken build never deploys.
- The screenshot spec runs in CI e2e. Local runs are headless only.
- A manual pass before merge at 360px and 1280px, light and dark, with JavaScript off, checking the
  tabs and the download table still read.

## Boundaries

- **Always:** run `WIREBENCH_SKIP_PERF=1 pnpm check` before each commit, one commit per task; take
  screenshots only through the e2e spec; build download links only from the release API.
- **Ask first:** new npm dependencies; a custom domain; a fourth page; analytics of any kind.
- **Never:** name other products; commit hand-made or mocked-up images; hard-code a version number;
  hide installers the visitor did not match; open local Electron windows while the owner is working.

## Success criteria

- [ ] `https://wirebench.github.io/wirebench/` is the landing page and `/wirebench/docs/` is the user
      guide with working search and sidebar.
- [ ] The three pages exist with real copy and real screenshots; no placeholder text remains.
- [ ] The download page lists every installer of the latest release with its size, lifts the visitor's
      platform to the top, and the build fails on a release with a missing installer.
- [ ] Every screenshot comes from `docs-screenshots.spec.ts`, and `pnpm check:docs-images` passes for both
      packages and fails on a missing or orphaned site image.
- [ ] `pnpm contrast:check` covers the site tokens and passes in both themes.
- [ ] Every docs link on the site resolves to a page, proven by the Vitest test.
- [ ] `pnpm check` passes, and a push to `main` deploys the assembled site.
- [ ] The pages read correctly at 360px and 1280px, in light and dark, and with JavaScript off.

## Resolved questions

1. Direction: product-led landing site over an enterprise buyer site or a community site (owner,
   2026-10-01). The enterprise pages follow the licensing work; the switching guides already live in the
   docs and the home page links to them.
2. Hosting: the default Pages URL for now, custom domain later (owner, 2026-10-01).
3. Layout: a separate `site/` package with the docs under `/docs`, over folding landing pages into the
   Starlight package (owner, 2026-10-01).
