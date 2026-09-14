# Implementation Plan: Complete Wirebench Documentation Site with Images

## Overview
Transform the starter documentation into a comprehensive, production-ready user manual for Wirebench by enriching all guides, tutorials, and reference documentation with the 7 authentic Electron application screenshots captured from the live app, following clean-room standards and skipping the API Reference section.

## Architecture Decisions
- **Framework & Theming**: Maintain Astro Starlight with Wirebench terracotta tokens (`#d97757`) and Postman-style method badges.
- **Images Delivery**: Serve screenshots statically from `public/images/` with descriptive alt tags, responsive framing, and captions.
- **Scope Boundary**: Strictly skip the API Reference / Scalar endpoint reference as directed.
- **Verification**: Ensure static compilation (`pnpm docs:build`) generates the Pagefind search index across all pages with zero 404s, and verify clean-room compliance (`pnpm check:banned-terms`).

## Task List

### Phase 1: Getting Started & Tutorials
- [ ] Task 1: Complete 5-Minute Quickstart with 4 real screenshots (`getting-started/quickstart.md`)
- [ ] Task 2: Complete Introduction & Installation guides with screenshots (`getting-started/index.md`, `getting-started/installation.md`)

### Checkpoint: Getting Started
- [ ] Quickstart flow renders step-by-step with `workspace-picker.png`, `import-wsdl.png`, `request-editor.png`, and `response.png`
- [ ] Installation instructions cover macOS Gatekeeper, Windows silent NSIS install, and Linux AppImage

### Phase 2: Protocol Guides (REST & SOAP)
- [ ] Task 3: Complete REST Client Guide with `rest-response.png` (`guides/rest-client.md`)
- [ ] Task 4: Complete SOAP & WSDL Guide with `import-wsdl.png`, `request-editor.png`, `response.png` (`guides/soap-wsdl.md`)

### Checkpoint: Core Protocols
- [ ] REST guide details query table, path variables `{id}`, multipart bodies, and status inspector
- [ ] SOAP guide details WSDL import, schema exploration, XML envelope generation, WS-Security keystores, and MTOM/SwA

### Phase 3: Environments & Team Collaboration
- [ ] Task 5: Complete Environments & Property Expansion Guide (`guides/environments.md`)
- [ ] Task 6: Complete Shared Workspaces Guide with `sync-panel.png` and `conflict-resolver.png` (`guides/workspaces.md`)

### Checkpoint: Environments & Workspaces
- [ ] Environment guide documents property precedence (`${#Env#x}` > `${#Project#x}` > `${#Workspace#x}`) and masked secrets
- [ ] Workspaces guide documents Git synchronization, ahead/behind status, and 3-way visual conflict resolution

### Phase 4: Reference & Quality Gate
- [ ] Task 7: Complete Keyboard Shortcuts & Project Format (v3) Reference (`reference/shortcuts.md`, `reference/project-format.md`)
- [ ] Task 8: Full Build, Pagefind Search indexing, and Clean-Room Banned Terms scan

### Checkpoint: Complete
- [ ] All 10 documentation pages verified live
- [ ] All 7 screenshots loading with correct aspect ratio
- [ ] `pnpm docs:build` completes with zero errors
- [ ] `pnpm check:banned-terms` passes across all files

## Risks and Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| Heavy PNG screenshots slowing page load | Low | Images are already optimized under 140 KB with Retina 1280x800 scaling |
| Inadvertent competitor naming | High | Strict check against `scripts/check-banned-terms.ts` |
| Broken anchor links or image 404s | Med | Starlight route validator and static build check |
