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

`pnpm check` must be green before every commit. CI runs it on Linux; macOS and Windows run the
OS-sensitive part, `pnpm check:tests` (typecheck + tests + perf gates):

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

## Adding a protocol

A protocol is one module behind the `ProtocolModule` interface
([ADR-0017](docs/adr/0017-a-protocol-is-a-module-behind-one-interface.md)). Adding one to the engine
changes its own folder and one line of `packages/engine/src/protocols.ts`; if a change needs any other
core file to know the protocol's name, the interface is missing something, and that is worth an issue
before the code.

This covers the engine, which is what `wirebench run` uses. The desktop app does not read the registry
yet (issue #184, phases 2 and 3): a new protocol's editor, IPC channels and wire types are separate
work, and until then the app does not show its containers.

The checklist, with `packages/engine/test/helpers/echo-protocol.ts` as the smallest complete example:

1. **A folder**, `packages/engine/src/<name>/`, holding the model and a file per facet. Leave a facet
   out when the protocol has none: no `run.ts` means its requests cannot be run, no `scripting.ts`
   means they cannot have scripts.
   - `files.ts`: the zod schemas of the container file and the request files.
   - `storage.ts`: a `ProtocolStorage`. `load` reads one container directory and pushes problems that
     do not stop the load; `files` returns every file a container is written as, deterministically;
     `managed` lists the files a save may delete. A kind with no list of its own on `Project` keeps
     its containers in `Project.extraContainers[kind]`.
   - `run.ts`: a `ProtocolRun`. `groups` lists what a run can send, in explorer order; `send` prepares,
     runs the scripts it is handed, and sends, in whatever order the protocol needs; `secretNeeds`
     names every secret its auth, keystores and signing read. Cache a contract with `scope.memo`
     under the key `<kind>:<container id>:<what>`.
   - `scripting.ts`: a `ProtocolScripting`. `inspect` describes a request snapshot (its destination,
     what a script may not change, its header pairs, its single-line values, every text in which a
     `${secret:…}` would be expanded). The rules of ADR-0016 are applied in core from that
     description; a module never implements one.
   - `module.ts`: `defineProtocol({ kind, feature, storage, run, scripting })`.
2. **The feature descriptor.** `feature.id` equals `kind`. Give it a `title`, `default`, `stage`
   (`experimental` for a protocol that should ship off) and the features it `requires`.
3. **Register it**: add the module to `BUILTIN_PROTOCOLS` in `packages/engine/src/protocols.ts`, and
   its selection, exchange and snapshot types to the unions declared there. Add what a host needs to
   `packages/engine/src/index.ts`.
4. **The dependency rules.** A protocol's folders import core and themselves, never another
   protocol's; core imports no protocol. Add the new folder to `GROUP_FOLDERS` in
   `scripts/engine-import-graph.mjs`. `pnpm check:engine-layers`, which `pnpm check` runs, fails on an
   import that breaks either rule (`scripts/engine-layers.test.ts` proves it bites). It is the only
   enforcement: there is no lint rule, so an editor does not flag a wrong import, and you learn of one
   from `pnpm check`. If two protocols need the same code, it moves into core (`http/`, `json/`,
   `xml/`), in its own commit.
5. **The tests every module needs:**
   - a round trip: a project holding its containers loads, and saves back byte-identical;
   - the order of `getSecret`, token fetch and contract load inside `send`, pinned as
     `packages/engine/test/unit/run/send-order.test.ts` pins the built-in ones;
   - each of the five script rules refused through its `inspect`, added to
     `packages/engine/test/unit/script/rules-per-protocol.test.ts`;
   - its secret needs, against a request that uses every kind of secret it supports;
   - a project that holds its containers, loaded with the feature switched off: a placeholder and a
     `container-unsupported` problem, a save that leaves the folder byte-identical, and the container
     back when the switch is on again.
6. **Errors** are `WirebenchError` subclasses with a stable `code`; a new code goes in `docs/cli.md`.
7. **Exports** are tagged `@internal` until a plugin API exists. Do not describe the module interface
   as stable in any document.

## Commit style

[Conventional Commits](https://www.conventionalcommits.org/) — `feat(engine): parse WSDL imports`,
`fix(renderer): correct send button state`. One logical change per commit.

Do not add `Co-Authored-By` trailers to commit messages.

## License and provenance

Wirebench is [Apache-2.0](LICENSE). By contributing you agree your contribution is licensed the
same way.

**Clean-room implementation: do not copy code from other SOAP tools.** Many of them are under
copyleft licences incompatible with Apache-2.0. Wirebench is implemented from public
specifications (WSDL 1.1, XML Schema, SOAP 1.1 and 1.2, WS-Security, WS-Addressing, WS-I Basic
Profile) and from published, user-facing documentation — behaviour may match, implementation may
not be derived. If you have recently read the source of another SOAP tool, say so in the pull
request.

## Security

Please do not file a public issue for an unpublished vulnerability; see the reporting note at the
end of [`docs/security.md`](docs/security.md).
