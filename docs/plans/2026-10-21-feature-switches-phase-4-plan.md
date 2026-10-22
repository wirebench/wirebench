# Wirebench: feature switches, user-facing — plan

Date: 2026-10-21 · Spec: `docs/specs/2026-10-21-feature-switches-phase-4.md` · Issue #735 (phase 4
of #184) · ADR-0029.

One pull request, one commit per task, `WIREBENCH_SKIP_PERF=1 pnpm check` green before each commit,
`pnpm test:perf` before the push. Tasks 1–3 are engine and server and have no desktop dependency;
4–7 are the desktop; 8 the CLI and MCP; 9 the docs.

## Task 1 — descriptors and resolution (engine)

- `packages/engine/src/protocol/features.ts`: `FeatureState`, `resolveFeatures(descriptors, { policy, preference })`
  returning `{ switches, states }`; precedence policy > preference > default, then `requires`;
  unknown ids ignored; policy never enables.
- `packages/engine/src/protocols.ts`: `BUILTIN_FEATURES` (scripts, sequences, webhooks, server-sync,
  team-secrets, mcp-server) and `createBuiltinRegistry` registers them all; `SCRIPTS_FEATURE` stays
  exported. `mcp`'s title becomes "MCP requests".
- `packages/engine/src/protocol/index.ts` and `index.ts` export the new names; `FeatureState` is `@internal`.
- Tests: `test/unit/protocol/features.test.ts` (precedence, requires, unknown, policy-never-enables).

## Task 2 — sequences and webhooks enforced (engine)

- `sequence/run.ts`: `runSequence` throws `feature-disabled` for `sequences` when its registry has it off.
- `run/run.ts`: a selected webhook item is refused with `feature-disabled` for `webhooks` before its
  script, the way `scriptsRefusal` works; a `--sequence` step shares `runSequence`'s refusal.
- `rest/module.ts` project files: `load` reads the load context's registry; `webhooks` off → no read,
  one placeholder `{ kind: 'rest', dir: 'webhooks', reason: 'feature-disabled', name: 'Webhooks' }`;
  `managed` unchanged so the folder is never saved over.
- Tests: `test/integration/run/webhooks-feature.test.ts`, `sequences-feature.test.ts`; the phase 3
  byte-for-byte test gains a `webhooks` case.

## Task 3 — preference section (engine) and team policy (server)

- `project/preferences.ts`: `features: Record<string, boolean>` section, default `{}`, in the schema,
  the defaults, `mergePreferences` and `resetPreferences`.
- `server-api/teams.ts`: `featureIdSchema`, `disabledFeatures` on `teamWorkspaceSchema` (default `[]`)
  and `teamWorkspaceUpdateRequestSchema` (optional, max 32, dedup); `server-api/sync.ts`: on the head.
- `packages/server/migrations/teams-access/0017_feature-policy.sql`: the column.
- `teams/repo.ts`: read and update the column; `teams/routes/workspaces.ts`: PATCH by workspace admin,
  audit `workspace.features_changed`, announce; `sync` head route carries it.
- Tests: server contract tests for PATCH (role, validation, audit, list), sync head; engine schema tests.

## Task 4 — start-up from the preference (desktop main)

- `main/features/startup.ts` replaces `main/kinds/enabled-kinds.ts`: `startupFeatures(preferences, env, isPackaged)`
  → `{ registry, states, enabledKinds, enabledFeatures }`; `WIREBENCH_FEATURES` laid over the file's
  section only when unpackaged; `WIREBENCH_KINDS` gone (`ipc/app.ts`, `index.ts`, e2e launch helpers).
- `shared/ipc.ts`: `app.features` channel answering the states plus the open workspace's policy and
  name; `app.kinds` answers for the open workspace; `shared/wire-base.ts`: `features` section in the
  preferences wire, `'features'` in the section enums, the feature state wire.
- `main/project-mutations.ts`: `requireFeatureEnabled(id)` beside `requireKindEnabled`; the
  sequence, script-run and webhook mutations call it. `ipc/sync.ts`, `ipc/team.ts`,
  `ipc/team-secrets.ts`: refuse with `feature-disabled` when `server-sync` / `team-secrets` is off.
- Tests: `test/features-startup.test.ts`; existing `kind-*` tests moved to the new helper.

## Task 5 — policy on the shared workspace (desktop main)

- `sync/server-state.ts` keeps `disabledFeatures` from the head; `sync/server-backend.ts` stores it on
  fetch and flags a change; `workspace-service.ts` exposes `featurePolicy()` for the open workspace and
  builds the project host's registry from preference + policy; `SyncStatusWire` gains
  `policyChanged?: true` and the Sync panel shows the reopen line.
- `app.kinds` / `app.features` re-answered on workspace open; the renderer refreshes `enabledKinds`
  and `enabledFeatures` from the workspace-opened event.
- Tests: `test/workspace-feature-policy.test.ts` (policy reaches the host, a local workspace has none,
  change flagged).

## Task 6 — Features section and policy editor (desktop renderer)

- `features/preferences/settings-model.ts`: section `features` under General, stored, searchable.
- `features/preferences/sections/features-section.tsx`: three groups, rows with badge, toggle,
  reason line, restart line, per-row reset; reads `app.features` through a small store.
- `features/team/workspaces-tab.tsx`: the Features popover per workspace, saved through
  `team.updateWorkspace` with the merged list.
- Import picker and drop handler filter by `enabledKinds`; sequence/webhook/script-run commands
  gated by `enabledFeatures` in `register-shell-commands.ts` and the kind command registrations.
- Tests: `test/renderer/features-section.test.tsx`, `workspaces-tab` policy test, import picker test.

## Task 7 — e2e

- `e2e/specs/feature-switches.spec.ts`: launch with `WIREBENCH_FEATURES=grpc=off`; Settings row off
  with "Requires"/reason text absent, explorer placeholder, no gRPC palette command; toggle on →
  "Applies after restart"; preferences file holds `features: { grpc: true }`.

## Task 8 — CLI flag, variable, ops and MCP

- `args.ts`: `--features` on every verb; `features.ts`: `parseFeatureSwitches(flag, env, warn)`;
  `commands/*`: build `createBuiltinRegistry(switches)` and pass it to `loadProject`, `runRequests`,
  `runSequence`; `OpsBase.registry`.
- `ops/context.ts`: `Op.feature?`; `generate` and `validate` declare `soap`; `import` refuses a format of
  an off kind; `mcp/server.ts`: `tools/list` omits, `tools/call` refuses with `feature-disabled`;
  `commands/mcp.ts`: `mcp-server` off → exit 2.
- Tests: `test/unit/features.test.ts`, `mcp/server` list/call tests, `run --sequence` refusal,
  `wirebench mcp` start refusal.

## Task 9 — docs and changelog

- `docs-site/src/content/docs/guides/feature-switches.mdx`, `site/src/docs-links.ts` entry,
  `docs/security.md` section, `docs/cli.md` global options, `docs/architecture/overview.md`,
  `CHANGELOG.md` Unreleased; the Phase 4 boxes in #184 ticked when the PR is up.
