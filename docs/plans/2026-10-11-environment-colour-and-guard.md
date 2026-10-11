# Environment colour and a production guard — plan

Spec: [2026-10-11-environment-colour-and-guard-design.md](../specs/2026-10-11-environment-colour-and-guard-design.md) ·
issue #345. One commit per task. Each commit goes in only after
`NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 pnpm check` is green.

## Task 1: engine fields

- Project and workspace environments get the optional `color` and `protected` fields in the schema,
  the model, the loader and the serializer. `protected` is written only when it is true.
- Regenerate the published JSON Schemas with `pnpm schemas:project`.
- Tests:
  - A round trip keeps both fields.
  - `protected: false` is not written.
  - An unknown colour still loads.

## Task 2: CLI and MCP

- `wirebench run` warns on a protected environment, and `--refuse-protected` refuses it.
- MCP gates gain `refuseProtected`, and `checkProtected` uses it.
- The `send` op and the contract tool schemas gain `allowProtected`.
- Tests cover the args, a `run` integration test, and the op refusal.

## Task 3: desktop wire and guard

- Wire schemas gain both fields: the project and workspace environment wire types, their patches,
  and the mappers.
- Add `confirmProtected` to the send deps, with a native message box in `index.ts`.
- Add the guard in `sendReserved`.
- Sequences ask once.
- Multi-environment sends ask once per batch.
- Tests:
  - Declined and confirmed sends.
  - A send with no dep.
  - A sequence asks once.
  - A multi-environment batch gives partial results.
  - Workspace patches persist both fields.

## Task 4: desktop UI

- Add `environmentColor()` to resolve a palette name or hex value.
- The switcher shows the colour dot and the lock.
- The tab strip shows the border.
- The environment page gets the colour and Protected controls.
- Duplicating an environment copies both fields.
- Renderer tests cover each of these.

## Task 5: docs and changelog

- Update the `guides/environments.mdx` guide.
- Update the CLI reference for the new flags.
- Add a CHANGELOG entry under [Unreleased].
