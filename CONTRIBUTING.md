# Contributing to Wirebench

## Setup

- Node 24 (see `.nvmrc`)
- pnpm 9
- `pnpm install`
- `pnpm check` before opening a PR (lint + typecheck + test, must be green)

## Commit style

This project uses [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat(engine): parse WSDL imports`,
`fix(renderer): correct send button state`). One logical change per commit.

Do not add `Co-Authored-By` trailers to commit messages.

## Testing

`packages/engine` is developed test-first (TDD): write a failing test, implement the minimal code to pass it, then
refactor. Engine code must stay free of Electron/DOM/React imports (lint-enforced) and every I/O function must accept
an `AbortSignal`.
