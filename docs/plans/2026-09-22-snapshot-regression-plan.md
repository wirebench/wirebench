# Snapshot regression — plan

- **Spec:** `docs/specs/2026-09-22-snapshot-regression-design.md` (issue #34).
- **Gate before every commit:** `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`.
- **Commits:** one per task, authored by Mohammed Naami <m.naami@outlook.com>, with no trailers.

## Task 1 — Engine: semantic diff module

**Files**
- Add `packages/engine/src/snapshot/{index,format,ignore,json-diff,xml-diff,diff}.ts`.
- In `packages/engine/package.json`, add a `./snapshot` subpath export shaped like `./json` and `./xml`. Also update any tsconfig or vite alias that lists subpaths.
- Tests: `packages/engine/test/unit/snapshot/{format,ignore,json-diff,xml-diff,diff}.test.ts`.

**Interfaces:** exactly as in the spec's "Semantic diff" section:
- `SnapshotFormat`, `SnapshotChange`, `SnapshotDiff`
- `detectSnapshotFormat`, `diffSnapshot`, `matchesIgnoreRule`, `parseIgnoreRules`

**Tests**
- JSON:
  - Key order is ignored.
  - `1.0` equals `1`.
  - Extra items at the end of an array show as added, missing ones as removed.
  - A change of type is reported as a change.
  - Pointer escaping works.
- XML:
  - A different prefix bound to the same namespace is not a difference.
  - Attribute order, comments and whitespace are ignored.
  - Repeated siblings get `[n]`.
  - A sibling with a different name inserted earlier does not shift the others.
  - A changed attribute value is reported.
  - The same local name in a different namespace counts as a change.
- A parse error falls back to text diffing and sets `error`.
- Ignore rules:
  - `*` and `//` both match.
  - A rule on an ancestor covers its descendants.
  - A rule with no index matches `[n]`.
  - Comments and blank lines are skipped.
  - The `ignored` count is reported.
- Values are truncated at 200 characters.

## Task 2 — Engine: `requestFileLocation`

**Files**
- Add `packages/engine/src/project/request-location.ts` and export it the way its neighbours are exported.
- Test: `packages/engine/test/unit/project/request-location.test.ts`.

**Interface:** `requestFileLocation(project: Project, requestId: string): { dir: string; slug: string } | undefined`
- `dir` is POSIX and relative to the project root.
- Invariant: `${dir}/${slug}.request.yaml` is a key of `projectFiles(project)`.

**Tests**
- A SOAP request.
- A REST request at the root.
- A REST request in nested folders.
- An unknown id returns `undefined`.
- gRPC and WebSocket ids return `undefined`.

## Task 3 — Main: snapshot store and IPC

**Files**
- Add `apps/desktop/src/main/snapshot-store.ts` and `apps/desktop/src/main/ipc/snapshot.ts`.
- Additive changes only:
  - `shared/wire-types.ts`: the schemas.
  - `shared/ipc.ts`: a `snapshot` channel group.
  - `main/index.ts`: register the handlers.
  - `main/project-host.ts`: one small accessor that returns `{ project, dir } | undefined` for an open, saved project. Skip this if an equivalent already exists.
- Test: `apps/desktop/test/snapshot-store.test.ts`.

**Interface:** the channels `snapshot.read`, `snapshot.write`, `snapshot.setIgnore` and `snapshot.remove`, as in the spec.

**Behaviour**
- Check path containment with the existing `path-containment.ts`.
- Write atomically: write a temp file, then rename it.
- Require the request's YAML to exist on disk.
- Parse the file with zod. A malformed file reads as `none` and logs a warning.

**Tests**
- Write then read round-trips.
- `setIgnore` keeps the body.
- `remove` works.
- An unsaved project reads as `unsaved`.
- A request whose YAML is missing reads as `unsaved`.
- A malformed file reads as `none`.
- The body is written as a YAML block scalar.

## Task 4 — Renderer: Snapshot tab

**Files**
- Add:
  - `renderer/features/snapshot/snapshot-panel.tsx`.
  - `renderer/state/snapshots.ts`: caches the golden per request id and wraps `ipc().snapshot.*`.
- Update:
  - SOAP: add `'snapshot'` to `ResponseViewType` in `state/editors.ts`, and add the view and its branch in `features/request-editor/response-pane.tsx`.
  - REST: add a `TABS` entry and its branch in `features/rest-editor/response/response-pane.tsx`.
- Test: `apps/desktop/test/renderer/snapshot-panel.test.tsx`.

**Interface:** `<SnapshotPanel requestId body contentType />`
- "Compare side by side" reuses the History diff-tab opener.
- Confirmation uses the app's existing confirm pattern.

**Tests**
- Every state listed in the spec's table renders.
- Ignore appends a rule and saves it.
- Save and Update call IPC.
- A response over 2 MB shows the "too large" message.

## Task 5 — e2e, docs, changelog

**Files**
- Add `e2e/snapshot-regression.spec.ts`: REST against the existing e2e mock. Save a snapshot, then assert one difference after the response changes. CI runs it, not local runs.
- Add `docs-site/src/content/docs/guides/snapshot-regression.mdx`, and a sidebar entry in `docs-site/astro.config.mjs`.
- Update `docs-site/src/content/docs/reference/project-format.md` with the sidecar.
- Update `CHANGELOG.md` under Unreleased/Added.

**Tests:** `pnpm check`, which includes banned terms.
