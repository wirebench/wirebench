# Plan: Documentation Site

Spec: `docs/specs/2026-09-14-wirebench-docs-site-design.md`
Executors: one commit set per task, Conventional Commits, clean-room compliance (`pnpm check:banned-terms`), `pnpm docs:build` green.

**Goal:** Create a complete, production-grade documentation site for Wirebench using Astro Starlight, Scalar, and Pagefind, styled with Postman-inspired aesthetics and Wirebench terracotta design tokens, embedding authentic Electron application screenshots captured via Playwright.

**Architecture:** A standalone package `@wirebench/docs-site` in `docs-site/` within the pnpm monorepo workspace. Astro Starlight delivers Markdown/MDX guides and reference documentation; Scalar renders the interactive API explorer at `/reference/`; Pagefind builds zero-runtime client-side search during static compilation.

## Global Constraints

- Site lives strictly within `docs-site/` package; core Electron and engine code remain untouched.
- Clean-room compliance: zero references to competitor tools or legacy trademarks (`pnpm check:banned-terms`).
- Authentic screenshots only: captured from running application via Playwright test runners into `docs-site/public/images/`.
- Interactive API Reference: Scalar explorer remains mounted at `/reference/` without further expansion (per "skip API Reference").
- CI/CD: Automated GitHub Pages deployment configured in `.github/workflows/docs.yml`.

---

## Progress

All phases completed and verified against the live application and static build output.

| Wave | Description | Tasks | State |
| :--- | :--- | :--- | :--- |
| **W0: Scaffold** | Monorepo integration, Astro Starlight setup, Scalar, design tokens | T1–T3 | done |
| **W1: Screenshots** | Playwright capture harness, 7 live application screenshots | T4 | done |
| **W2: Getting Started** | Quickstart (4 screenshots), Introduction, Installation | T5, T6 | done |
| **W3: Guides** | REST client, SOAP/WSDL, Environments, Shared Workspaces | T7–T10 | done |
| **W4: Reference** | Keyboard Shortcuts matrix, Project Format (v3) specification | T11, T12 | done |
| **W5: Verification** | Static build, Pagefind indexing, clean-room banned terms scan, CI workflow | T13, T14 | done |

---

## Task Breakdown

### W0: Site Scaffolding & Design System
- [x] **T1**: Create `docs-site/package.json`, `astro.config.mjs`, `tsconfig.json`, and `src/content.config.ts`.
- [x] **T2**: Add `docs-site` to `pnpm-workspace.yaml` and root scripts (`docs:dev`, `docs:build`, `docs:preview`) in `package.json`.
- [x] **T3**: Implement Postman method badges, terracotta accents (`#d97757`), and custom components (`MethodBadge.astro`, `Endpoint.astro`, `Shortcut.astro`).

### W1: Screenshot Acquisition
- [x] **T4**: Run Playwright test suite with `WIREBENCH_SCREENSHOTS=1` to capture:
  - `workspace-picker.png`
  - `import-wsdl.png`
  - `request-editor.png`
  - `response.png`
  - `rest-response.png`
  - `sync-panel.png`
  - `conflict-resolver.png`

### W2: Getting Started & Quickstart
- [x] **T5**: Author `getting-started/quickstart.md` using Starlight `<Steps>` with all 4 workflow screenshots.
- [x] **T6**: Author `getting-started/index.md` (architecture & protocol support table) and `getting-started/installation.md` (macOS, Windows silent install, Linux AppImage).

### W3: Protocol & Collaboration Guides
- [x] **T7**: Author `guides/rest-client.md` with query params, path variables `{id}`, multipart bodies, and `rest-response.png`.
- [x] **T8**: Author `guides/soap-wsdl.md` with WSDL import, XML envelope editing, WS-Security keystores, and MTOM attachments.
- [x] **T9**: Author `guides/environments.md` with `${#Env#x}` property expansion, precedence hierarchy, and encrypted secrets.
- [x] **T10**: Author `guides/workspaces.md` with Git-backed workspaces, sync status (`sync-panel.png`), and visual conflict resolution (`conflict-resolver.png`).

### W4: Reference Documentation
- [x] **T11**: Author `reference/shortcuts.md` with full keyboard shortcut matrix using `<Shortcut>` chips.
- [x] **T12**: Author `reference/project-format.md` detailing filesystem project format (v3) and Git collaboration.

### W5: Verification & Deployment
- [x] **T13**: Create `.github/workflows/docs.yml` for automated GitHub Pages deployment on push to `main`.
- [x] **T14**: Verify full static build (`pnpm docs:build`), Pagefind index generation, and clean-room check (`pnpm check:banned-terms`).
