# Contributing to Wirebench

## Setup

- Node 24 (see `.nvmrc`)
- pnpm 9 (`corepack enable`)
- `pnpm install`
- `pnpm dev` — electron-vite with HMR for the renderer

The workspace is a pnpm monorepo: `packages/engine` (`@wirebench/engine`, the protocol library),
`apps/desktop` (the Electron app), `e2e` (Playwright against the built app), `scripts` (build and
maintenance tooling), `fixtures` (WSDL/XSD test material), `docs`.

## The gate

`pnpm check` must be green before every commit, and it is what CI runs on macOS, Windows and Linux:

```
pnpm check        # lint + typecheck + wsi:docs --check + contrast:check + check:doc-paths + test + test:perf
```

The end-to-end suite is separate and needs a build first:

```
pnpm build && pnpm test:e2e
```

Other commands worth knowing:

| Command                            | What it does                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:coverage`               | Engine coverage; the build fails below 85% lines/branches/functions/statements                                                  |
| `pnpm test:e2e`                    | Playwright drives the **built** app (and, in `packaged.spec.ts`, the packaged one)                                              |
| `pnpm test:interop`                | Live public SOAP services (sets `WIREBENCH_NETWORK_TESTS=1` itself); excluded from `pnpm test`/`pnpm check`, runs nightly in CI |
| `pnpm test:wss-xmlsec`             | Cross-checks generated signatures/encryption with `xmlsec1` (`brew install libxmlsec1` / `apt install xmlsec1`)                 |
| `pnpm bench`                       | The performance scenarios as trend numbers rather than pass/fail                                                                |
| `WIREBENCH_SKIP_PERF=1 pnpm check` | Skips the performance gates on a loaded machine                                                                                 |

### E2E test hooks

The e2e suite drives the real app, so a few things a browser cannot do — native file dialogs, the
profile directory, a self-signed test certificate — are answered by environment variables the app
honours: `WIREBENCH_E2E`, `WIREBENCH_USER_DATA_DIR`, `WIREBENCH_E2E_DIALOG_FOLDER`,
`WIREBENCH_E2E_DIALOG_SAVE`, `WIREBENCH_E2E_OPEN_PATH`, `WIREBENCH_E2E_SAVE_PATH`,
`WIREBENCH_E2E_FILE_DIALOG_PATH`, `WIREBENCH_E2E_EXTRA_CA_FILE`, `WIREBENCH_E2E_DEBUG_CONSOLE`.

Prefer `e2e/helpers/launch-app.ts` over setting them by hand. They are honoured by the packaged
binary too, deliberately — the reasoning, and what they explicitly do _not_ bypass, is in
[`docs/security.md`](docs/security.md#test-hooks-in-the-shipped-binary).

## How work is planned

This repository follows spec-driven development. A change of any size starts from the design spec
and the implementation plan:

- `docs/specs/` — dated design specs; §13 of the v1 spec is the success-criteria list
- `docs/plans/` — dated implementation plans, one numbered task per unit of work
- `docs/success-criteria.md` — each criterion mapped to the tests that prove it
- `docs/adr/` — architecture decision records; add one when a decision constrains future work

If you change something an ADR describes, update the ADR (or add a superseding one) in the same
pull request.

## Code style

- TypeScript `strict`, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. No `any`.
- Named exports only; files are kebab-case; `import type` for types; `readonly` model fields.
- Prettier: 2 spaces, single quotes, semicolons, 120 columns, trailing commas. `pnpm lint:fix`.
- JSDoc on every exported engine function. Comments explain **why**, not what.
- `packages/engine` imports nothing from Electron, the DOM or React — this is lint-enforced — and
  every I/O entry point takes an `AbortSignal`.
- Errors are `WirebenchError` subclasses with a stable `code`.
- The renderer never touches the network, the filesystem or secrets; everything goes through a
  typed IPC channel with a zod schema pair (`apps/desktop/src/shared/ipc.ts`).
- Secrets live in `safeStorage` and are referenced by `secretRef` — never in project files or logs.

## Testing

`packages/engine` is developed test-first: write a failing test, implement the minimal code to pass
it, then refactor. Golden fixtures must be deterministic (inject the clock and id generator). No
test touches the network except `packages/engine/test/interop`.

## Commit style

[Conventional Commits](https://www.conventionalcommits.org/) — `feat(engine): parse WSDL imports`,
`fix(renderer): correct send button state`. One logical change per commit.

Do not add `Co-Authored-By` trailers to commit messages.

## License and provenance

Wirebench is [Apache-2.0](LICENSE). By contributing you agree your contribution is licensed the
same way.

**Never copy SoapUI or ReadyAPI source code.** They are EUPL-licensed, which is incompatible with
this project. Wirebench is implemented from public specifications (WSDL 1.1, XML Schema, SOAP 1.1
and 1.2, WS-Security, WS-Addressing, WS-I Basic Profile) and from SoapUI's user-facing
documentation — behaviour may match, implementation may not be derived. If you have read SoapUI
source recently, say so in the pull request.

## Security

Please do not file a public issue for an unpublished vulnerability; see the reporting note at the
end of [`docs/security.md`](docs/security.md).
