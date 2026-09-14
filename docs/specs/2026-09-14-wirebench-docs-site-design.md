# Spec: Documentation Site

- Status: **implemented** (2026-09-14, on `feat/docs-site`).
- Date: 2026-09-14
- Builds on: Astro Starlight, Scalar API reference, Pagefind search, Postman-inspired aesthetics, Wirebench terracotta design tokens (`#d97757`), ADR-0003 (project folder format), and clean-room implementation constraints.
- Plan: `docs/plans/2026-09-14-wirebench-docs-site-plan.md`.

## Assumptions

1. **Documentation site lives in a dedicated monorepo package.** Located at `docs-site/`, registered in `pnpm-workspace.yaml`, cleanly decoupled from Electron/engine code and internal engineering specifications in `docs/`.
2. **Postman-inspired documentation aesthetic.** Uses color-coded HTTP method badges (`GET`, `POST`, `PUT`, `DELETE`, `SOAP`), interactive endpoint bars, dark/light theme parity, and Wirebench craft terracotta accents (`#d97757`).
3. **Dual engine: Astro Starlight for guides, Scalar for OpenAPI explorer.** Starlight handles Markdown/MDX guides, tutorials, and reference documentation; Scalar powers the interactive API console at `/reference/` reading OpenAPI 3.0.3 definitions.
4. **Client-side zero-runtime search.** Powered by Pagefind directly integrated into Astro Starlight, indexing static HTML output without external server dependencies.
5. **Real application screenshots only.** No unrendered UI mockups or placeholders. All screenshots are captured directly from the live Wirebench Electron app via Playwright test runners into `docs-site/public/images/`.
6. **API Reference section skipped.** As explicitly instructed by the user, focus content creation and screenshot embeds entirely on user guides, tutorials, environments, and reference documentation.
7. **Clean-room compliance.** Documentation describes behaviour strictly on its own terms; zero occurrences of legacy tool competitor names or trademarks (`pnpm check:banned-terms`).

---

## 1. Objective

**What.** A comprehensive, production-ready documentation site for Wirebench:
- Getting Started walkthroughs (Introduction, Installation, 5-Minute Quickstart)
- Protocol user guides (REST Client, SOAP & WSDL)
- Configuration & collaboration guides (Environments & Properties, Git-Backed Shared Workspaces)
- Reference specifications (Keyboard Shortcut matrix, Project Folder Format v3)
- Scalar interactive API explorer mounted at `/reference/`
- Automated GitHub Actions deployment workflow for GitHub Pages

**Why.** Users transitioning to or adopting Wirebench require clear, visually illustrated guides demonstrating how to organize workspaces, import service definitions, compose requests, inspect responses, configure environments, and collaborate via Git.

**Who.** Integration engineers, QA specialists, backend developers, and enterprise platform teams adopting Wirebench.

---

## 2. Tech Stack & Architecture

| Component | Technology | Version | Purpose |
| :--- | :--- | :--- | :--- |
| **Framework** | Astro | `^7.3.2` | Core static site generator and asset pipeline |
| **Documentation Theme** | Starlight (`@astrojs/starlight`) | `^0.42.0` | Sidebar, content collections, search, dark/light mode |
| **Interactive Explorer** | Scalar (`@scalar/api-reference`) | `^1.43.1` | OpenAPI 3.0.3 interactive console |
| **Search Engine** | Pagefind | built-in | Static pre-indexed client search |
| **Design System** | Custom CSS | Vanilla CSS | Wirebench tokens (`--wb-accent: #d97757`), Postman method badges |
| **Package Manager** | pnpm | monorepo | Workspace integration (`pnpm docs:dev`, `pnpm docs:build`) |

---

## 3. Site Structure & Live Assets

```text
docs-site/
├── public/
│   ├── favicon.svg
│   ├── images/
│   │   ├── workspace-picker.png     # Workspace selection and creation modal
│   │   ├── import-wsdl.png          # WSDL URL/file import modal
│   │   ├── request-editor.png       # Generated SOAP XML envelope editor & toolbar
│   │   ├── response.png             # SOAP response inspector with status & latency
│   │   ├── rest-response.png        # REST request builder & JSON response viewer
│   │   ├── sync-panel.png           # Git-backed workspace sync panel & history
│   │   └── conflict-resolver.png    # 3-way visual merge conflict resolution tool
│   └── specs/
│       └── wirebench-api.json       # OpenAPI 3.0.3 specification for Scalar
└── src/
    ├── assets/
    │   └── hero-mark.svg            # Terracotta SVG brand mark
    ├── components/
    │   ├── Endpoint.astro           # Postman-style interactive endpoint bar
    │   ├── MethodBadge.astro        # Colored HTTP method badge (GET/POST/SOAP)
    │   └── Shortcut.astro           # Monospace <kbd> keybinding chip
    ├── content.config.ts            # Astro 5 content layer loader
    ├── content/docs/
    │   ├── index.mdx                # Postman-style landing page with hero & cards
    │   ├── getting-started/
    │   │   ├── index.md             # Overview, core tenets & protocol support table
    │   │   ├── installation.md      # OS install guides (macOS, Windows, Linux)
    │   │   └── quickstart.md        # 5-Minute Quickstart with 4 embedded screenshots
    │   ├── guides/
    │   │   ├── rest-client.md       # REST Client guide with rest-response.png
    │   │   ├── soap-wsdl.md         # SOAP/WSDL guide with import & editor screenshots
    │   │   ├── environments.md      # Property expansion syntax ${#Env#x} & scopes
    │   │   └── workspaces.md        # Git-backed shared workspaces with sync screenshots
    │   └── reference/
    │       ├── shortcuts.md         # Complete keyboard shortcut matrix
    │       └── project-format.md    # Filesystem project format (v3) specification
    ├── pages/
    │   └── reference/index.astro    # Scalar interactive API console
    └── styles/
        └── custom.css               # Postman aesthetics & Wirebench design tokens
```

---

## 4. Content Mapping with Screenshots

1. **Quickstart (`getting-started/quickstart.md`)**:
   - Step 1: Open or create a workspace → Embed `workspace-picker.png`
   - Step 2: Import a WSDL contract → Embed `import-wsdl.png`
   - Step 3: Compose and edit request envelope → Embed `request-editor.png`
   - Step 4: Execute and inspect response → Embed `response.png`
2. **REST Client Guide (`guides/rest-client.md`)**:
   - Query parameters, path variables (`{id}`), and body formatting
   - Executing request and inspecting JSON response → Embed `rest-response.png`
3. **SOAP & WSDL Guide (`guides/soap-wsdl.md`)**:
   - Contract parsing and schema navigation → Embed `import-wsdl.png`
   - Envelope editor and operations tree → Embed `request-editor.png`
   - Response analysis and header inspector → Embed `response.png`
4. **Shared Workspaces Guide (`guides/workspaces.md`)**:
   - Remote Git repository connection and sync status → Embed `sync-panel.png`
   - 3-way visual merge conflict resolution → Embed `conflict-resolver.png`
5. **Environments & Properties Guide (`guides/environments.md`)**:
   - Scope hierarchy (`${#Env#x}` > `${#Project#x}` > `${#Workspace#x}`)
   - Encrypted secrets management, variable toggles, and export protection
6. **Reference Pages (`reference/shortcuts.md`, `reference/project-format.md`)**:
   - Full keyboard navigation matrix with `<Shortcut>` chips
   - Filesystem project format (v3) specification for Git version control

---

## 5. Clean-Room Compliance & Boundaries

- **Always**:
  - Use authentic application screenshots captured via Playwright in `docs-site/public/images/`.
  - Maintain clean-room compliance: zero occurrences of legacy competitor names or trademarks.
  - Verify static build and Pagefind search index with `pnpm docs:build`.
- **Ask first**:
  - Modifying top-level site routing or adding new external npm packages.
- **Never**:
  - Expand the API Reference section (as explicitly instructed: "skip API Reference").
  - Commit unrendered mockups or placeholders.

---

## 6. Success Criteria

- [x] All 10 documentation pages contain comprehensive, production-ready documentation (no stubs).
- [x] All 7 live application screenshots are embedded with descriptive captions and responsive styling.
- [x] `pnpm docs:build` completes with zero errors, generating static HTML and Pagefind search index.
- [x] `pnpm check:banned-terms` passes across all files.
- [x] Dev server serves all pages and images cleanly at `http://localhost:4321`.
