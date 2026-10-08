# Plan: mock services in the desktop

Spec: [`docs/specs/2026-10-08-mock-services-design.md`](../specs/2026-10-08-mock-services-design.md) §Desktop (PR 2)
Issue: [#59](https://github.com/wirebench/wirebench/issues/59). The engine half is #329, and this PR closes the issue.

**Goal:** a project's mocks appear in the explorer. A mock is generated from an interface or API, edited in a tab
(settings, operations, responses, bodies, match conditions, scenarios and the dispatch script), started and
stopped, and its requests are shown in a log.

**Architecture:**
- **Main process:**
  - `project-mock-mutations.ts` holds the `*-mock` project changes. Each edit is checked with the engine's own
    file parsers (`validateMock`), as sequences are.
  - `mock-runner.ts` keeps one running server per mock. It restarts a mock when its project changes, and stops
    every mock when its project closes or the app quits.
  - The IPC is `mock.start`, `mock.stop` and `mock.reset`, with the events `mock.exchange` and `mock.state`.
- **Renderer:**
  - The project store gains `mocks` and `mockLists`.
  - The explorer gets a Mocks group, a *New Mock…* dialog and a mock menu.
  - `features/mock/` holds the tab, and a store keeps the running state and the log.

## Global constraints

- **Gate:** `WIREBENCH_SKIP_PERF=1 pnpm check` before every commit, and `pnpm test:perf` before the push.
- **No local Electron windows.** CI runs e2e.
- **Commits:** one per task, made as Mohammed Naami, with no trailers.
- **Renderer imports:** only types from `shared/wire-types.ts`.
- **Product names:** never name another product.

## Decisions taken here

- **The dispatch script is edited as TypeScript with syntax colouring only.** Type checking against the
  dispatch API needs a new target in the script host. That host is keyed by request and phase. The checking is
  a follow-up issue.
- **The Record button for #60 is not in this PR.** The recorder is not on main yet; whichever of the two lands
  second adds the button to the mock tab.
- **The preference lives in a new `mocks` section,** `mocks.listenOnAllInterfaces`, off by default.

## Tasks

### Task 1: Engine — `validateMock` and the preference

- [ ] `mock/file.ts` `validateMock(mock)`: render every file through `mockFiles` and parse each one back with its
  own parser. A failure throws the parser's `mock-file-invalid`.
- [ ] `project/preferences.ts`: a `mocks: { listenOnAllInterfaces: false }` section, with its schema and its
  merge.
- [ ] Tests, gate, commit `feat(engine): validate a mock as its files would load (#59)`.

### Task 2: Desktop — wire, mutations, store, watch

- [ ] `wire-types.ts`:
  - `mockWireSchema`, with operations and responses;
  - the changes `add-mock`, `update-mock`, `update-mock-operation`, `add-mock-response`, `update-mock-response`,
    `remove-mock-response`, `move-mock-response`, `remove-mock` and `duplicate-mock`;
  - `projectWireSchema.mocks`.
- [ ] `project-mock-mutations.ts`: the changes plus `toMockWire`. Generation goes through a `generateMock`
  dependency, which the project host implements with the engine's `generateMock` over the project folder.
- [ ] Renderer `state/project.ts`: `mocks`, `mockLists` and the actions.
- [ ] `project-watch.ts` manages `mocks/`.
- [ ] Update `wire-defaults.ts` and the test fixtures.
- [ ] Gate, commit `feat(desktop): mocks in the project model (#59)`.

### Task 3: Desktop — the runner and its IPC

- [ ] `main/mock-runner.ts`: `start`, `stop` and `reset`. It sends state and exchange events. It restarts a
  running mock after a change to its project, and stops a mock when its project closes or the app quits. The
  host comes from the preference.
- [ ] `ipc.ts` channels and events, `ipc/mock.ts`, and the wiring in `index.ts`.
- [ ] Update the preload and API mock tests.
- [ ] Gate, commit `feat(desktop): start and stop mocks (#59)`.

### Task 4: Desktop — explorer and commands

- [ ] The Mocks group after Sequences, with its rows and a running badge.
- [ ] *New Mock…* on the project, the interface and the API menus. It opens a dialog for the name, and for the
  binding when the WSDL has several.
- [ ] The mock menu: Open, Start/Stop, Rename…, Duplicate and Delete.
- [ ] Commands, and regenerate `commands.md`.
- [ ] Gate, commit `feat(desktop): mocks in the explorer (#59)`.

### Task 5: Desktop — the mock tab

- [ ] The header: name, port, path, validation, Start/Stop, the URL with Copy, and Reset state.
- [ ] The operations list, and the selected operation's dispatch, default and responses (add, duplicate,
  remove, reorder).
- [ ] The response editor: status, delay, headers, scenario, match conditions and the body.
- [ ] The script editor for `dispatch.ts`.
- [ ] The request log, with a detail view and Clear.
- [ ] The Preferences section, and its warning in the tab.
- [ ] Gate, commit `feat(desktop): the mock tab (#59)`.

### Task 6: e2e and docs

- [ ] e2e `mocks.spec.ts`: generate a mock from a REST API, start it, send to it and see the row in the log.
- [ ] `guides/mock-services.mdx`, a sidebar entry, success-criteria rows and a CHANGELOG entry.
- [ ] Open the follow-up issue for typed dispatch scripts.
- [ ] Gate, commit `docs: mock services guide (#59)`.
