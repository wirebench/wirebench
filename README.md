# Wirebench

Wirebench is an open-source desktop SOAP/WSDL workbench with a modern IDE shell, built on Electron, TypeScript, and
React. It focuses on exploring WSDL/XSD contracts and sending SOAP requests (with WS-Security, MTOM, and WS-I
validation support); REST support is planned for a later phase.

## Development

```
pnpm install                       # bootstrap workspace (Node 24, pnpm 9)
pnpm dev                           # electron-vite dev: main/preload/renderer with HMR
pnpm build                         # pnpm typecheck && electron-vite build (all workspaces)
pnpm package                       # electron-builder --dir (unpacked app for the current OS)
pnpm package:mac | package:win | package:linux
pnpm test                          # vitest run
pnpm lint                          # eslint . --max-warnings 0 && prettier --check .
pnpm typecheck                     # tsc -b
pnpm check                         # lint + typecheck + test ← the pre-commit and CI gate
pnpm test:e2e                      # Playwright against the built Electron app
pnpm bench                         # vitest benchmarks over the engine's budgeted scenarios
```

### Performance budgets

`pnpm check` includes the engine's performance gate (`packages/engine/test/perf/budgets.test.ts`), and `pnpm test:e2e`
includes the app's (`e2e/specs/perf.spec.ts`). Both take the median of several samples and allow generous headroom, so
they catch a real regression rather than a busy machine — but on a slow or heavily loaded one they can still be noise.
Set `WIREBENCH_SKIP_PERF=1` to skip both:

```
WIREBENCH_SKIP_PERF=1 pnpm check
```

`pnpm bench` reports the same scenarios as trend numbers instead of pass/fail. The budgets themselves live in one map,
`packages/engine/test/bench/budgets.ts`.

## Keyboard shortcuts

Every action in Wirebench is a command with an id, and every shortcut is that command's binding — the command palette
(`⌘K` / `Ctrl+K`) lists them all. `Mod` is `⌘` on macOS and `Ctrl` elsewhere.

| Command                 | Shortcut      |
| ----------------------- | ------------- |
| Show All Commands       | `Mod+K`       |
| Toggle Sidebar          | `Mod+B`       |
| Toggle Console          | `Mod+J`       |
| Toggle Details Panel    | `Mod+Alt+B`   |
| Show Explorer           | `Mod+Shift+E` |
| Show Search             | `Mod+Shift+S` |
| Show History            | `Mod+Shift+Y` |
| Show Settings           | `Mod+,`       |
| Import WSDL…            | `Mod+I`       |
| Open Project…           | `Mod+O`       |
| New Project             | `Mod+Shift+N` |
| Toggle Light/Dark Theme | —             |

`Mod+Shift+F` is deliberately unassigned here: it is reserved for Format XML.

## Packaging

`pnpm package` (or `package:mac` / `package:win` / `package:linux`) builds an installable app
into `apps/desktop/release/`. Releases are cut by pushing a `v*` tag; see
[`docs/release.md`](docs/release.md) for the signing secrets, the Electron fuse table and how
the opt-in update check behaves.

## Status

Early scaffolding stage. See the design spec at
[`docs/specs/2026-09-09-wirebench-v1-explore-and-send-design.md`](docs/specs/2026-09-09-wirebench-v1-explore-and-send-design.md)
for the full plan.
