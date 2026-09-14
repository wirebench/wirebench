# Spec: Complete Wirebench Documentation Site with Live Screenshots

## Objective
Provide comprehensive, production-grade documentation for the Wirebench desktop workbench, embedding real screenshots captured from the live application to guide users step-by-step through core workflows (SOAP, REST, Environments, Shared Workspaces, and Shortcuts), while explicitly skipping the API Reference section as directed.

## Tech Stack
- **Framework**: Astro 7.3 + Astro Starlight 0.42
- **Search**: Pagefind (built-in client-side indexing)
- **Formatting**: MDX, Starlight components (`<Steps>`, `<Tabs>`, `<CardGrid>`, `<Card>`, `<Badge>`), and custom Postman-styled components (`<Endpoint>`, `<MethodBadge>`, `<Shortcut>`)
- **Assets**: High-resolution screenshots captured via Playwright Electron runner (`docs-site/public/images/*.png`)

## Commands
- **Dev**: `pnpm docs:dev` (runs local server at http://localhost:4321)
- **Build**: `pnpm docs:build` (compiles static site and Pagefind search index)
- **Preview**: `pnpm docs:preview` (locally previews production build)
- **Quality**: `pnpm check:banned-terms` (verifies clean-room compliance)

## Project Structure & Image Assets
```text
docs-site/
├── public/
│   └── images/
│       ├── workspace-picker.png     # Workspace creation and picker dialog
│       ├── import-wsdl.png          # WSDL URL/file import modal
│       ├── request-editor.png       # Generated SOAP XML envelope editor & toolbar
│       ├── response.png             # SOAP response inspector with status & latency
│       ├── rest-response.png        # REST request builder & JSON response viewer
│       ├── sync-panel.png           # Git-backed workspace sync panel & history
│       └── conflict-resolver.png    # 3-way visual merge conflict resolution tool
└── src/content/docs/
    ├── index.mdx                    # Homepage with Postman hero & feature cards
    ├── getting-started/
    │   ├── index.md                 # Overview, core tenets & protocol support table
    │   ├── installation.md          # OS install guides (macOS unsigned, Windows, Linux)
    │   └── quickstart.md            # 5-Minute Walkthrough with embedded screenshots
    ├── guides/
    │   ├── rest-client.md           # REST Client guide with rest-response.png
    │   ├── soap-wsdl.md             # SOAP/WSDL guide with import & editor screenshots
    │   ├── environments.md          # Property expansion syntax ${#Env#x} & scopes
    │   └── workspaces.md            # Git-backed shared workspaces with sync screenshots
    └── reference/
        ├── shortcuts.md             # Complete keyboard shortcut matrix
        └── project-format.md        # Filesystem project format (v3) specification
```

## Content Mapping with Live Screenshots
1. **Quickstart (`getting-started/quickstart.md`)**:
   - Step 1: Open/create workspace → Embed `workspace-picker.png`
   - Step 2: Import WSDL → Embed `import-wsdl.png`
   - Step 3: Edit request envelope → Embed `request-editor.png`
   - Step 4: Inspect execution response → Embed `response.png`
2. **REST Client Guide (`guides/rest-client.md`)**:
   - Query parameters, path variables, and body formatting
   - Executing request and inspecting JSON response → Embed `rest-response.png`
3. **SOAP & WSDL Guide (`guides/soap-wsdl.md`)**:
   - WSDL contract parsing → Embed `import-wsdl.png`
   - Schema navigation & envelope editor → Embed `request-editor.png`
   - Response analysis & header inspector → Embed `response.png`
4. **Shared Workspaces Guide (`guides/workspaces.md`)**:
   - Connecting remote Git repositories & branch tracking → Embed `sync-panel.png`
   - Resolving simultaneous edits & 3-way visual merge → Embed `conflict-resolver.png`
5. **Environments & Properties Guide (`guides/environments.md`)**:
   - Property expansion hierarchy (`${#Env#var}`, `${#Project#var}`, `${#Workspace#var}`)
   - Encrypted secrets management and variable enabling/disabling
6. **Reference Pages (`reference/shortcuts.md`, `reference/project-format.md`)**:
   - Complete shortcut list with `<Shortcut>` chips
   - File format specification for Git version control

## Boundaries
- **Always**:
  - Use real, crisp screenshots from `public/images/`.
  - Maintain clean-room compliance: zero occurrences of legacy tool competitor names or trademarks.
  - Verify static build and Pagefind search index with `pnpm docs:build`.
- **Ask first**:
  - Modifying top-level site routing or adding new external npm packages.
- **Never**:
  - Touch or expand the API Reference section (as explicitly instructed: "skip API Reference").
  - Commit stale mockups or broken image paths.

## Success Criteria
- [ ] All 10 documentation pages contain comprehensive, production-ready documentation (no stubs).
- [ ] All 7 live application screenshots are embedded with descriptive captions and responsive styling.
- [ ] `pnpm docs:build` completes with zero errors, generating static HTML and Pagefind search index.
- [ ] `pnpm check:banned-terms` passes across all files.
- [ ] Dev server serves all pages and images cleanly at `http://localhost:4321`.
