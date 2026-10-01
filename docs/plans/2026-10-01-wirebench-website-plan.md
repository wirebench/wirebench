# Plan: Website

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

Spec: `docs/specs/2026-10-01-wirebench-website-design.md` · Issue: opened after the spec merges ·
Branch `feat/website` from `main`, worktree `git-worktrees/website-impl`.

**Goal:** A product-led landing site (home, features, download) at the Pages root, with the user guide
moved under `/wirebench/docs/`, deployed as one Pages artifact.

**Architecture:** A new `site/` workspace package on plain Astro renders three static pages from `.astro`
components, a build-time fetch of the latest GitHub Release, and one `--wb-*` tokens sheet. The docs
site only changes its base path. A root `site:assemble` script joins both builds; the Pages workflow
uploads the result. The existing image and contrast gates learn the second package.

**Tech stack:** Astro `^7.3.2` (the version `docs-site/package.json` pins), no integrations, Node 24,
pnpm 9.13.2, Vitest 5.

## Global constraints

- `site` is `https://wirebench.github.io`; the landing base is `/wirebench`; the docs base is
  `/wirebench/docs`.
- No new npm dependency beyond `astro` in `site/package.json`. Ask before adding one.
- Never name another product; `pnpm check:banned-terms` scans every tracked file.
- Screenshots come only from `e2e/specs/docs-screenshots.spec.ts`. No hand-made or mocked images.
- No hard-coded version number anywhere in `site/`.
- Every link from `site/` into the docs is a slug in `site/src/docs-links.ts`.
- `eslint.config.js` is protected: if a task needs it changed, stop and ask the owner.
- One commit per task, after `WIREBENCH_SKIP_PERF=1 pnpm check` is green. No `Co-Authored-By`, no
  `Claude-Session` trailer. Local e2e is never run with visible windows.

## File map

| Path | Responsibility |
| --- | --- |
| `site/package.json`, `site/astro.config.mjs`, `site/tsconfig.json`, `site/.gitignore` | Package scaffold |
| `site/src/styles/tokens.css` | `--wb-*` colours, dark on `:root`, light under `prefers-color-scheme` |
| `site/src/styles/site.css` | Reset, type scale, layout column, buttons, focus rings |
| `site/src/docs-links.ts` | Every docs slug the site links to, plus `docsUrl(slug)` |
| `site/src/layouts/Base.astro` | `<head>`, skip link, nav, footer |
| `site/src/components/Hero.astro` | Headline, sentence, two buttons, hero screenshot |
| `site/src/components/ProtocolTabs.astro` | SOAP/REST/gRPC tabs with screenshot and bullets |
| `site/src/components/FolderTree.astro` | The "Projects live in git" section |
| `site/src/components/FeatureCard.astro` | One card for "Beyond the desktop" |
| `site/src/components/DownloadTable.astro` | Installer table and platform lift script |
| `site/src/data/release.ts` | Latest-release fetch and asset mapping |
| `site/src/data/release.fixture.json` | One real release's asset list for offline dev and tests |
| `site/src/pages/{index,features,download,404}.astro` | The pages |
| `site/test/*.test.ts` | Vitest: release mapping, docs links |
| `scripts/site-assemble.ts` | Copies the docs build into `site/dist/docs/` |
| `scripts/check-docs-images.ts` | Now checks `docs-site/` and `site/` |
| `scripts/contrast-check.ts` | Now checks `site/src/styles/tokens.css` too |
| `e2e/specs/docs-screenshots.spec.ts` | Writes the site's shots as well |
| `.github/workflows/site.yml` | Replaces `docs.yml` |

## Phase 1 — The docs move and the package

- [ ] **T1. Docs under `/docs`.** In `docs-site/astro.config.mjs` set `base: '/wirebench/docs'`. Replace
  every `/wirebench/images/` with `/wirebench/docs/images/` in `docs-site/src/content/docs/**` (26
  citations in 16 files):

  ```bash
  grep -rl '/wirebench/images/' docs-site/src/content/docs | xargs sed -i '' 's#/wirebench/images/#/wirebench/docs/images/#g'
  ```

  In `scripts/check-docs-images.ts` change the regex in `citedImages` to
  `/\/wirebench\/docs\/images\/([^\s)"'#?]+)/g` and the fixture strings in
  `scripts/check-docs-images.test.ts` to match. Update the docs URLs in `README.md` (lines 132, 198,
  232), `docs/cli.md` (259, 311, 672), `docs/release.md` (226) and `docs/roadmap.md` (141) to insert
  `/docs` after `/wirebench`. Leave `CHANGELOG.md` alone: it is history.
  - Verify: `pnpm docs:build` passes; `pnpm check:docs-images` passes;
    `grep -rn '/wirebench/images/' docs-site/src` is empty.
  - Commit: `docs(site): move the user guide under /wirebench/docs/`.

- [ ] **T2. `site/` package.** Create:

  `site/package.json`

  ```json
  {
    "name": "@wirebench/site",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "scripts": {
      "dev": "astro dev",
      "build": "astro build",
      "preview": "astro preview"
    },
    "dependencies": {
      "astro": "^7.3.2"
    }
  }
  ```

  `site/astro.config.mjs`

  ```js
  import { defineConfig, passthroughImageService } from 'astro/config';

  export default defineConfig({
    site: 'https://wirebench.github.io',
    base: '/wirebench',
    trailingSlash: 'always',
    image: { service: passthroughImageService() },
  });
  ```

  `site/tsconfig.json` is a copy of `docs-site/tsconfig.json`; `site/.gitignore` a copy of
  `docs-site/.gitignore`. Add `'site'` to `pnpm-workspace.yaml` and `site/.astro` to `.prettierignore`.
  Root `package.json` scripts, next to the `docs:*` ones:

  ```json
  "site:dev": "pnpm --filter @wirebench/site dev",
  "site:build": "pnpm --filter @wirebench/site build",
  "site:preview": "pnpm --filter @wirebench/site preview",
  "site:assemble": "pnpm site:build && pnpm docs:build && node scripts/site-assemble.ts",
  ```

  `scripts/site-assemble.ts` (top doc comment in the house style, `node:` imports only). Astro's
  `dist/` is not prefixed by `base`, so the docs build lands at `docs-site/dist/index.html` and is copied
  whole under `site/dist/docs/`:

  ```ts
  import { cp, rm } from 'node:fs/promises';
  import { fileURLToPath } from 'node:url';

  const docsDist = fileURLToPath(new URL('../docs-site/dist/', import.meta.url));
  const target = fileURLToPath(new URL('../site/dist/docs/', import.meta.url));
  await rm(target, { recursive: true, force: true });
  await cp(docsDist, target, { recursive: true });
  process.stdout.write('site: docs copied into site/dist/docs\n');
  ```

  For this task `site/src/pages/index.astro` renders `<h1>Wirebench</h1>` inside a minimal
  `site/src/layouts/Base.astro` (doctype, `<head>` with charset, viewport and title, `<main><slot /></main>`),
  so the build has one real page and nothing placeholder-shaped.
  - Verify: `pnpm site:assemble` produces `site/dist/index.html` and `site/dist/docs/index.html`;
    `pnpm lint` passes with the new files.
  - Commit: `feat(site): scaffold the landing site package and the assemble script`.

- [ ] **T3. Workflow.** Rename `.github/workflows/docs.yml` to `site.yml`, `name: Site`. Replace
  `pnpm docs:build` with `pnpm site:assemble`, the artifact `path` with `site/dist`, and the
  `pull_request.paths` with `site/**`, `docs-site/**`, `scripts/site-assemble.ts`,
  `.github/workflows/site.yml`. Everything else stays: push to `main` with no filter,
  `workflow_dispatch`, the concurrency rule, pinned action majors. Update the roadmap line that names
  `docs.yml`.
  - Verify: `grep -rn docs.yml . --exclude-dir=node_modules --exclude-dir=.git` finds only
    `CHANGELOG.md` and the 2026-09-18 spec and plan.
  - Commit: `ci: the Site workflow deploys the landing site with the docs under /docs`.

## Phase 2 — Tokens, layout and the gates that guard them

- [ ] **T4. Tokens and the contrast gate.** Create `site/src/styles/tokens.css` from the values in
  `docs-site/src/styles/custom.css`:

  ```css
  :root {
    color-scheme: dark;
    --wb-bg-base: #151413;
    --wb-bg-raised: #1c1b19;
    --wb-bg-sunken: #0f0e0d;
    --wb-border: #2a2724;
    --wb-fg-default: #ece9e3;
    --wb-fg-muted: #a49d93;
    --wb-accent-default: #d97757;
    --wb-accent-hover: #e58c6e;
    --wb-accent-fg: #151413;
  }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --wb-bg-base: #faf8f5;
      --wb-bg-raised: #f2eee8;
      --wb-bg-sunken: #ebe6de;
      --wb-border: #dfdbd3;
      --wb-fg-default: #1c1917;
      --wb-fg-muted: #57534e;
      --wb-accent-default: #c45e3c;
      --wb-accent-hover: #a04627;
      --wb-accent-fg: #faf8f5;
    }
  }
  ```

  `--wb-accent-fg` is the button label on the accent. In `scripts/contrast-check.ts`:
  - Export `SITE_PAIRS: readonly Pair[]`: `--wb-fg-default` and `--wb-fg-muted` on `--wb-bg-base`,
    `--wb-bg-raised` and `--wb-bg-sunken` (text); `--wb-accent-default` on `--wb-bg-base` and
    `--wb-bg-raised` (text, links); `--wb-accent-fg` on `--wb-accent-default` (text, button label);
    `--wb-border` on `--wb-bg-base` (ui).
  - Give `checkTokens` a second parameter
    `options: { pairs?: readonly Pair[]; light?: 'data-theme' | 'media' }`, defaulting to the shell's
    pairs and `'data-theme'`. Add `export function parseMediaBlock(css: string, query: string): Declarations`
    that returns the `:root` declarations inside `@media (<query>) { … }`; `light: 'media'` uses it with
    `prefers-color-scheme: light`.
  - `main()` runs the shell file and then `site/src/styles/tokens.css` with
    `{ pairs: SITE_PAIRS, light: 'media' }`, prints each under its own heading, and a failure in either
    sets the exit code.
  - Tests in `scripts/contrast-check.test.ts`: `parseMediaBlock` reads the light block and ignores the
    dark one; the site file passes every `SITE_PAIRS` pair in both themes; a fixture with
    `--wb-fg-muted: #999999` on `--wb-bg-base: #faf8f5` fails.
  - Verify: `pnpm contrast:check` prints both files passing; `pnpm test -- scripts/contrast-check`.
  - Commit: `feat(site): design tokens, gated by the contrast check`.

- [ ] **T5. Image gate for `site/`.** In `scripts/check-docs-images.ts` replace the two constants with

  ```ts
  interface Site {
    readonly name: string;
    readonly contentDir: string;
    readonly pagePattern: RegExp;
    readonly imagesDir: string;
    readonly prefix: string;
  }
  export const SITES: readonly Site[] = [
    {
      name: 'docs-site',
      contentDir: 'docs-site/src/content/docs',
      pagePattern: /\.mdx?$/,
      imagesDir: 'docs-site/public/images',
      prefix: '/wirebench/docs/images/',
    },
    {
      name: 'site',
      contentDir: 'site/src',
      pagePattern: /\.astro$/,
      imagesDir: 'site/public/images',
      prefix: '/wirebench/images/',
    },
  ];
  ```

  `citedImages(page: string, prefix: string)` builds its regex from the escaped prefix; `main()` loops
  over `SITES` and reports each by name. `filesUnder` already tolerates a missing images folder, so
  `site/` passes with zero images until T8. Tests: `citedImages` with each prefix; a `.astro` page
  citing `/wirebench/images/home/response.png` is found; a docs page citing the old `/wirebench/images/`
  prefix is not.
  - Verify: `pnpm check:docs-images` prints both sites; the unit tests pass.
  - Commit: `test(site): the image check covers the landing site`.

- [ ] **T6. Base layout, global styles and the docs-link test.** `site/src/styles/site.css`:
  box-sizing reset; `body` background `var(--wb-bg-base)`, colour `var(--wb-fg-default)`, the system
  sans stack; `.column` (`max-width: 72rem; margin-inline: auto; padding-inline: 16px`); `.button` and
  `.button--primary` (accent background, `--wb-accent-fg` label, `--wb-accent-hover` on hover);
  `:focus-visible` outline in the accent; `.skip-link` visually hidden until focused;
  `img { max-width: 100%; height: auto }`; `code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace }`.

  `site/src/docs-links.ts`:

  ```ts
  /** Every docs page the landing site links to, as the slug of its page under docs-site/src/content/docs. */
  export const DOCS_LINKS = {
    home: '',
    installation: 'getting-started/installation',
    secrets: 'guides/secrets',
    runInCi: 'guides/run-in-ci',
    snapshotRegression: 'guides/snapshot-regression',
    sharedWorkspaces: 'guides/shared-workspaces',
    agentsMcp: 'guides/agents-mcp',
    codeSigningPolicy: 'help/code-signing-policy',
    projectFormat: 'reference/project-format',
  } as const;

  /** The absolute path of a docs page under the Pages base. */
  export function docsUrl(slug: string): string {
    return slug === '' ? '/wirebench/docs/' : `/wirebench/docs/${slug}/`;
  }
  ```

  `site/src/layouts/Base.astro` grows into the full frame:

  ```astro
  ---
  /** Every page's frame: head, skip link, nav, the page's content, footer. */
  import '../styles/tokens.css';
  import '../styles/site.css';
  import { docsUrl } from '../docs-links.ts';
  interface Props {
    title: string;
    description: string;
  }
  const { title, description } = Astro.props;
  const base = import.meta.env.BASE_URL; // "/wirebench/"
  ---

  <!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <meta name="description" content={description} />
      <link rel="icon" href={`${base}favicon.svg`} type="image/svg+xml" />
    </head>
    <body>
      <a class="skip-link" href="#main">Skip to content</a>
      <header class="column nav">
        <a class="wordmark" href={base}><img src={`${base}hero-mark.svg`} alt="" width="28" height="28" /> Wirebench</a>
        <nav aria-label="Site">
          <a href={`${base}features/`}>Features</a>
          <a href={`${base}download/`}>Download</a>
          <a href={docsUrl('')}>Docs</a>
          <a href="https://github.com/wirebench/wirebench">GitHub</a>
        </nav>
        <a class="button button--primary nav__download" href={`${base}download/`}>Download</a>
      </header>
      <main id="main" class="column"><slot /></main>
      <footer class="column">
        <a href={docsUrl('')}>Docs</a>
        <a href="https://github.com/wirebench/wirebench">GitHub</a>
        <a href="https://github.com/wirebench/wirebench/releases">Releases</a>
        <a href={docsUrl('help/code-signing-policy')}>Code-signing policy</a>
        <span>Apache-2.0</span>
      </footer>
    </body>
  </html>
  ```

  At `max-width: 40rem` the `<nav>` is hidden and `.nav__download` shown; above it the reverse. Copy
  `docs-site/public/favicon.svg` and `docs-site/src/assets/hero-mark.svg` into `site/public/`. Add a
  Vitest project `site` with `include: ['site/test/**/*.test.ts']` to `vitest.config.ts`.
  `site/test/docs-links.test.ts`: for every value of `DOCS_LINKS`, one of
  `docs-site/src/content/docs/<slug>.md`, `<slug>.mdx`, `<slug>/index.md`, `<slug>/index.mdx` exists
  (`''` means `index.mdx`); `docsUrl('guides/rest-client')` is `/wirebench/docs/guides/rest-client/`.
  - Verify: `pnpm test -- site/test`; `pnpm site:build`; `pnpm lint`. If typed linting of `site/**/*.ts`
    fails on Astro's generated types, stop and ask the owner before touching `eslint.config.js`.
  - Commit: `feat(site): base layout and the docs-link test`.

## Phase 3 — Content

- [ ] **T7. Release data.** `site/src/data/release.ts`:

  ```ts
  export interface Installer {
    readonly platform: 'macOS' | 'Windows' | 'Linux';
    readonly label: string;
    readonly file: string;
    readonly url: string;
    readonly bytes: number;
  }
  export interface Release {
    readonly version: string; // "2.2.1": the tag without its "v"
    readonly publishedAt: string; // ISO 8601 from the API
    readonly notesUrl: string; // the release's html_url
    readonly installers: readonly Installer[];
  }
  interface Asset {
    readonly name: string;
    readonly browser_download_url: string;
    readonly size: number;
  }
  export interface ApiRelease {
    readonly tag_name: string;
    readonly published_at: string;
    readonly html_url: string;
    readonly assets: readonly Asset[];
  }
  /** The installers the download page lists, in page order; `file` is the artifact name for a version. */
  export const INSTALLERS: readonly {
    readonly platform: Installer['platform'];
    readonly label: string;
    readonly file: (version: string) => string;
  }[] = [
    { platform: 'macOS', label: 'Universal .dmg', file: (v) => `Wirebench-${v}-mac-universal.dmg` },
    { platform: 'macOS', label: 'Apple silicon .dmg', file: (v) => `Wirebench-${v}-mac-arm64.dmg` },
    { platform: 'macOS', label: 'Intel .dmg', file: (v) => `Wirebench-${v}-mac-x64.dmg` },
    { platform: 'Windows', label: 'x64 setup .exe', file: (v) => `Wirebench-${v}-windows-x64-setup.exe` },
    { platform: 'Windows', label: 'arm64 setup .exe', file: (v) => `Wirebench-${v}-windows-arm64-setup.exe` },
    { platform: 'Windows', label: 'x64 .msi', file: (v) => `Wirebench-${v}-windows-x64.msi` },
    { platform: 'Windows', label: 'arm64 .msi', file: (v) => `Wirebench-${v}-windows-arm64.msi` },
    { platform: 'Linux', label: 'x86_64 .AppImage', file: (v) => `Wirebench-${v}-linux-x86_64.AppImage` },
    { platform: 'Linux', label: 'arm64 .AppImage', file: (v) => `Wirebench-${v}-linux-arm64.AppImage` },
    { platform: 'Linux', label: 'amd64 .deb', file: (v) => `wirebench_${v}_amd64.deb` },
    { platform: 'Linux', label: 'arm64 .deb', file: (v) => `wirebench_${v}_arm64.deb` },
    { platform: 'Linux', label: 'x86_64 .rpm', file: (v) => `wirebench-${v}.x86_64.rpm` },
    { platform: 'Linux', label: 'amd64 .snap', file: (v) => `wirebench_${v}_amd64.snap` },
  ];

  /** Maps an API release to the page's table. Throws, naming the file, when an installer is missing. */
  export function mapRelease(api: ApiRelease): Release {
    const version = api.tag_name.replace(/^v/, '');
    const byName = new Map(api.assets.map((asset) => [asset.name, asset]));
    const installers = INSTALLERS.map(({ platform, label, file }) => {
      const name = file(version);
      const asset = byName.get(name);
      if (asset === undefined) {
        throw new Error(`release ${api.tag_name} has no asset ${name}`);
      }
      return { platform, label, file: name, url: asset.browser_download_url, bytes: asset.size };
    });
    return { version, publishedAt: api.published_at, notesUrl: api.html_url, installers };
  }

  const LATEST = 'https://api.github.com/repos/wirebench/wirebench/releases/latest';

  /** The latest release from GitHub, or the fixture when WIREBENCH_SITE_OFFLINE=1. */
  export async function loadRelease(
    env: NodeJS.ProcessEnv = process.env,
    fetchFn: typeof fetch = fetch,
  ): Promise<Release> {
    if (env['WIREBENCH_SITE_OFFLINE'] === '1') {
      const { default: fixture } = await import('./release.fixture.json', { with: { type: 'json' } });
      return mapRelease(fixture as ApiRelease);
    }
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    const token = env['GITHUB_TOKEN'];
    if (token !== undefined && token !== '') {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const response = await fetchFn(LATEST, { headers });
    if (!response.ok) {
      throw new Error(`latest release request failed: ${String(response.status)}`);
    }
    return mapRelease((await response.json()) as ApiRelease);
  }
  ```

  Write `site/src/data/release.fixture.json` from

  ```bash
  gh api repos/wirebench/wirebench/releases/latest --jq '{tag_name,published_at,html_url,assets:[.assets[]|{name,browser_download_url,size}]}'
  ```

  Tests in `site/test/release.test.ts`: the fixture maps to 13 installers in `INSTALLERS` order with
  the fixture's URLs and sizes; a fixture copy without the rpm makes `mapRelease` throw with the file
  name in the message; `loadRelease({ WIREBENCH_SITE_OFFLINE: '1' }, stub)` never calls the stub; with
  a stub that records its headers, `Authorization` is present only when `GITHUB_TOKEN` is set; a stub
  returning `{ ok: false, status: 403 }` makes it throw with `403` in the message.
  - Verify: `pnpm test -- site/test/release`.
  - Commit: `feat(site): download links from the latest release, verified against a fixture`.

- [ ] **T8 + T9. Screenshots and the home page** (one commit, because the image gate reports a shot with
  no page as orphaned and a page with no shot as missing).

  **T8.** In `e2e/specs/docs-screenshots.spec.ts` add
  `const SITE_IMAGES_DIR = join(REPO_ROOT, 'site', 'public', 'images');` and extend `shoot`:

  ```ts
  async function shoot(page: Page, shot: string, options: { mask?: Locator[]; also?: string } = {}): Promise<void> {
    const mask = [...(options.mask ?? []), page.getByTestId('status-bar-last'), page.getByTestId('status-bar-save')];
    await captureWindow(page, join(IMAGES_DIR, `${shot}.png`), { mask, maxBytes: MAX_BYTES });
    if (options.also !== undefined) {
      await captureWindow(page, join(SITE_IMAGES_DIR, `${options.also}.png`), { mask, maxBytes: MAX_BYTES });
    }
  }
  ```

  Add `also` to three existing calls: `getting-started/response` → `'home/response'`,
  `rest-client/rest-response` → `'home/rest-response'`, `grpc/unary-response` → `'home/grpc-response'`.
  No new test cases. Produce the PNGs headless with `pnpm docs:screenshots` (never with visible
  windows while the owner works) or take them from the CI e2e artifact, and commit them.

  **T9.** Components and copy, all text from the spec's section 3:
  - `Hero.astro`: `<h1>One workbench for SOAP, REST and gRPC.</h1>`; the sentence "Import a WSDL, an
    OpenAPI document or a .proto set, get a request from the contract, send it, and read the
    response."; buttons `Download` (`${base}download/`, primary) and `Read the docs` (`docsUrl('')`);
    then `<img src="/wirebench/images/home/response.png" width="1280" height="800" alt="A SOAP request and its response in the Wirebench shell" />`.
    At `max-width: 40rem` the image sits in an `overflow: hidden` box with `width: 150%` so its left
    two thirds show.
  - `ProtocolTabs.astro`: `<div role="tablist" aria-label="Protocols">` with three
    `<button role="tab" id="tab-soap" aria-controls="panel-soap" aria-selected="true">` (then rest,
    grpc with `aria-selected="false"` and `tabindex="-1"`), and three `<section role="tabpanel">`, the
    second and third with `hidden`. Each panel: the screenshot (`home/response.png`,
    `home/rest-response.png`, `home/grpc-response.png`, `loading="lazy"`, width and height set) and a
    three-item `<ul>` with the spec's bullets. Inline `<script>`: on tab click, or ArrowLeft and
    ArrowRight on a focused tab, set `aria-selected` and `tabindex`, toggle `hidden`, move focus. One
    `<p>` under the tabs: "All three share one project, one set of environments, one history and one
    HTTP stack."
  - `FolderTree.astro`: `<pre>` with these lines from the docs' project format page, beside the three
    bullets (the third links to `docsUrl(DOCS_LINKS.secrets)`):

    ```
    my-service/
      wirebench.yaml
      environments/dev.yaml
      interfaces/<Interface>/
        interface.yaml
        operations/<Operation>/
          <Request>.request.yaml
          <Request>.xml
      apis/<Api>/
        api.yaml
        requests/<Request>.request.yaml
      sequences/<Sequence>.sequence.yaml
    ```

  - `FeatureCard.astro` with props `title`, `text`, `slug`, rendering `<h3>`, `<p>` and
    `<a href={docsUrl(slug)}>Read the guide</a>`; four cards: CLI and CI (`DOCS_LINKS.runInCi`),
    snapshot regression, shared workspaces, agents over MCP.
  - Download band: "Free and open source, Apache-2.0.", the Download button, "macOS · Windows · Linux".
  - `index.astro` composes Hero, ProtocolTabs, FolderTree, the four cards and the band, with `title`
    "Wirebench — one workbench for SOAP, REST and gRPC" and the hero sentence as `description`.
  - Verify: `pnpm site:build`; `pnpm check:docs-images` reports `site` with 3 images cited;
    `pnpm test -- site/test`; preview at 360px and 1280px in both schemes and with JavaScript off (the
    SOAP panel is visible, nothing overflows horizontally).
  - Commit: `feat(site): home page with screenshots from the e2e spec`.

- [ ] **T10. Features page.** `features.astro`: one `<section>` per area in the spec's section 4, each
  with `<h2>`, one paragraph, one screenshot from `site/public/images/features/` (width, height,
  `loading="lazy"`) and a "Read the guide" link. Extend the `also` calls in the screenshot spec:
  `soap-wsdl/wss-outgoing` → `features/wss-outgoing`, `rest-client/body-tab` → `features/body-tab`,
  `grpc/unary-response` keeps its home copy and also writes `features/grpc` (give `also` a
  `string | readonly string[]` type), `importers/curl-preview` → `features/curl-preview`,
  `environments/endpoint-override` → `features/endpoint-override`, `http-log/failed-send` →
  `features/failed-send`, `history/diff-view` → `features/diff-view`, `shared-workspaces/sync-panel` →
  `features/sync-panel`, `switching/postman-summary` → `features/postman-summary`. Add to `DOCS_LINKS`:
  `soapWsdl: 'guides/soap-wsdl'`, `restClient: 'guides/rest-client'`, `grpc: 'guides/grpc'`,
  `websocket: 'guides/websocket'`, `importers: 'guides/importers'`, `environments: 'guides/environments'`,
  `auth: 'guides/auth'`, `httpLog: 'guides/http-log'`, `sequences: 'guides/sequences'`,
  `webhooks: 'guides/webhooks'`. Sections without a dedicated shot (WebSocket and SSE, sequences and
  scripts, snapshot regression, webhooks, CLI and agents) use text only; a section never shows a shot
  of something else.
  - Verify: `pnpm site:build`; `pnpm check:docs-images`; `pnpm test -- site/test`.
  - Commit: `feat(site): features page`.

- [ ] **T11. Download page and 404.** `download.astro` runs `const release = await loadRelease();` in
  frontmatter and renders `DownloadTable.astro` with `release`: `<h1>Download Wirebench {release.version}</h1>`,
  the date (`new Date(release.publishedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })`)
  and a link to `release.notesUrl`; then one `<section data-platform="macOS|Windows|Linux">` per
  platform, each a `<table>` of label, file name (`<code>`) and size (`(bytes / 1_048_576).toFixed(1)` MB,
  computed in frontmatter). Inline `<script>`:

  ```js
  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? '';
  const match = /mac/i.test(platform) ? 'macOS' : /win/i.test(platform) ? 'Windows' : /linux/i.test(platform) ? 'Linux' : null;
  if (match) {
    const section = document.querySelector(`[data-platform="${match}"]`);
    const label = { macOS: 'Mac', Windows: 'PC', Linux: 'Linux machine' }[match];
    const note = document.createElement('p');
    note.textContent = `For your ${label}`;
    section.prepend(note);
    section.parentElement.prepend(section);
  }
  ```

  Below the table two lines linking `DOCS_LINKS.installation` ("first-launch prompts and where data
  lives") and `DOCS_LINKS.codeSigningPolicy`. `404.astro`: `<h1>Page not found</h1>` and links home and
  to the docs.
  - Verify: `WIREBENCH_SITE_OFFLINE=1 pnpm site:build` works without network; `pnpm site:build`
    fetches the real release; with JavaScript off the three sections stay in the fixed order; the
    page lists 13 rows.
  - Commit: `feat(site): download page from the latest release, and the 404 page`.

## Phase 4 — Finish

- [ ] **T12. Roadmap, README, success criteria.** In `docs/roadmap.md`'s Tooling entry add one sentence:
  the landing site (`site/`) is at the Pages root and the user guide under `/wirebench/docs/`, both
  built by `.github/workflows/site.yml`; spec `docs/specs/2026-10-01-wirebench-website-design.md`, plan
  `docs/plans/2026-10-01-wirebench-website-plan.md`. In `README.md`'s resources list add the landing site
  URL above the user guide. Tick the spec's success criteria that hold; the deploy criterion is ticked
  after T13.
  - Verify: `WIREBENCH_SKIP_PERF=1 pnpm check`.
  - Commit: `docs: roadmap and README point at the landing site`.

- [ ] **T13. Pull request.** Push `feat/website`; open the PR with a description about the change and no
  generated-by footer; wait for CI including the Site workflow's PR build; after the owner merges,
  confirm `https://wirebench.github.io/wirebench/` and `https://wirebench.github.io/wirebench/docs/`
  load, then tick the last criterion in the spec on a follow-up commit. Move the issue's board status as
  the owner's workflow requires.

## Self-review notes

- Spec §2 pages: T9, T10, T11. §3 home: T9. §4 features: T10. §5 download: T7, T11. §6 look: T4, T6,
  T9. §7 package and deploy: T1, T2, T3, T12. §8 screenshots and checks: T4, T5, T6, T8, T10.
- Names used across tasks: `docsUrl`, `DOCS_LINKS`, `loadRelease`, `mapRelease`, `INSTALLERS`,
  `Release`, `Installer`, `ApiRelease`, `SITE_PAIRS`, `SITES`, `parseMediaBlock`, `checkTokens(css, options)`,
  `shoot(page, shot, { mask, also })`, `SITE_IMAGES_DIR`.
- T8 and T9 share one commit by design; every other task is one commit.
