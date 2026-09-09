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
```

## Status

Early scaffolding stage. See the design spec at
[`docs/specs/2026-09-09-wirebench-v1-explore-and-send-design.md`](docs/specs/2026-09-09-wirebench-v1-explore-and-send-design.md)
for the full plan.
