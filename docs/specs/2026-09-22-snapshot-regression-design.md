# Snapshot regression — design

Issue: #34. Roadmap item 5.

## Goal

Save a known-good ("golden") response next to a request. On every later send, show what changed, compared by meaning rather than byte for byte. Paths the request marks as volatile, such as timestamps and generated ids, are left out of the comparison.

## Scope

- SOAP and REST requests with a text response body. gRPC and WebSocket come later.
- A semantic diff for XML and JSON. Any other text is compared exactly.
- Ignore rules, stored with the golden and committed with it.

Not in scope: CLI or test-runner snapshots, snapshots of headers or status, binary bodies, and bulk update.

## Storage

Each request gets one sidecar file in its own folder, `<slug>.golden.yaml`:

```yaml
contentType: application/json
savedAt: 2026-09-22T10:00:00.000Z
ignore:
  - /meta/timestamp
  - //requestId
body: |
  {"id": 1, "meta": {"timestamp": "…"}}
```

**Why a sidecar and not a request field.** The project schema drops unknown keys, so any new field in `*.request.yaml` has to bump `formatVersion` (ADR-0003). A sidecar sits outside the project model:
- Save only deletes files it manages, so an older build leaves the sidecar alone.
- No format bump is needed.
- The golden diffs cleanly in git.

**No name collisions.** A request manages `<slug>.request.yaml`, `<slug>.xml`, `<slug>.body.<ext>` and `<slug>.msg-*`. None of them can be named `<slug>.golden.yaml`: a request whose slug is `x.golden` owns `x.golden.request.yaml`, never `x.golden.yaml`.

**Known limitation.** Renaming or moving a request leaves its golden behind. The Snapshot tab then shows "No snapshot saved" and the user saves it again. The docs say so.

**Unsaved requests.** A project that has never been saved, or a request not yet written to disk, shows "Save the project to keep a snapshot beside this request."

## Semantic diff

The diff lives in a new pure engine module, `@wirebench/engine/snapshot`, which the renderer uses.

```ts
type SnapshotFormat = 'json' | 'xml' | 'text';
interface SnapshotChange { kind: 'added' | 'removed' | 'changed'; path: string; expected?: string; actual?: string }
interface SnapshotDiff { format: SnapshotFormat; changes: SnapshotChange[]; ignored: number; error?: string }
function detectSnapshotFormat(body: string, contentType?: string): SnapshotFormat;
function diffSnapshot(golden: string, actual: string, options: { format: SnapshotFormat; ignore: readonly string[] }): SnapshotDiff;
function matchesIgnoreRule(path: string, rule: string): boolean;
function parseIgnoreRules(text: string): string[]; // one per line; skips blanks and '#' comments
```

**JSON**
- Objects are compared by key; key order doesn't matter.
- Arrays are compared by index. Extra tail items are `added`; missing ones are `removed`.
- Numbers are compared by value, so `1.0` equals `1`.
- A type change is one `changed`.
- Paths are JSON Pointers, with `~0`/`~1` escaping.

**XML**
- Both sides are parsed with `parseXml`.
- Elements and attributes are compared by namespace URI plus local name, so prefixes don't matter.
- These are ignored: `xmlns` declarations, attribute order, comments, processing instructions, and whitespace-only text.
- Text is trimmed before comparing.
- Children are paired in order within each (namespace, local name) group. An earlier inserted sibling with a different name therefore doesn't shift the rest.
- Path segments are local names. `[n]` (1-based) is added when a name repeats among siblings. Attributes are written `@name`.

**Text**
- Line endings are normalised, then the bodies are compared exactly.
- Any difference is one `changed` at `/`.

**Parse failure.** If either side fails to parse, the diff falls back to text and sets `error`.

**Format detection**
- A content type containing `json` means JSON; one containing `xml` means XML.
- Otherwise the trimmed body decides: `{` or `[` means JSON, `<` means XML, anything else is text.
- The content type recorded with the golden takes priority.

The `expected` and `actual` values are truncated to 200 characters. An element value is shown as `<name>`.

## Ignore rules

A rule is a slash path made of the same segments as diff paths:
- A `*` segment matches any one segment.
- A leading `//` means "at any depth".
- A rule also matches every descendant of the path it names.
- A segment without `[n]` matches any index.

## User interface

A **Snapshot** tab is added to both the SOAP and REST response panes.

| State | What the tab shows |
|---|---|
| No response | "Send the request to compare its response." |
| Unsaved | "Save the project to keep a snapshot beside this request." |
| No golden | "No snapshot saved." and **Save as snapshot** |
| Matches | "Matches the snapshot", plus "(N ignored)" when some changes were ignored |
| Differs | "N differences" and a table of kind, path and expected → actual. Each row has an **Ignore** button that appends its path to the rules. |

The tab also has:
- **Update snapshot**, which asks for confirmation first.
- **Compare side by side**, which opens the History diff tab.
- **Delete snapshot**.
- An **Ignore rules** textarea that saves on blur. Saving rewrites only `ignore`.

When either body is larger than 2 MB, the tab shows "Too large to compare semantically" instead of a diff.

## Main process and IPC

| Channel | Request | Response |
|---|---|---|
| `snapshot.read` | `{ requestId }` | `{ status: 'unsaved' \| 'none' } \| { status: 'present', snapshot: { contentType?, savedAt, ignore, body } }` |
| `snapshot.write` | `{ requestId, body, contentType?, ignore }` | `{ savedAt }` |
| `snapshot.setIgnore` | `{ requestId, ignore }` | `{ savedAt }` |
| `snapshot.remove` | `{ requestId }` | `{ removed: boolean }` |

**Snapshot store.** A new `main/snapshot-store.ts` resolves each sidecar path with a new engine helper, `requestFileLocation(project, requestId): { dir: string; slug: string } | undefined`. The helper returns a path relative to the project root, for SOAP and REST requests. The store then:
- checks that the path stays inside the project folder;
- checks that the request's `*.request.yaml` exists on disk;
- writes atomically: to a temp file, then rename;
- validates reads with zod. A malformed sidecar reads as `none` and logs a warning.

**Shared files.** Changes here are additive only:
- `project-host.ts` gains one accessor.
- `wire-types.ts` gains the schemas.

## Testing

- **Engine unit tests:** JSON and XML semantic cases, the text fallback, ignore matching, format detection, and `requestFileLocation`.
- **Main tests:** the store against a temp project folder, covering unsaved, containment and malformed cases.
- **Renderer tests:** each state of the Snapshot tab, the Ignore button, and save/update.
- **e2e:** one Playwright test for REST: save a snapshot, send again for a changed response, and see one difference. CI runs it.

## Documentation

- A new guide, `docs-site/src/content/docs/guides/snapshot-regression.mdx`, with a sidebar entry.
- A note on the sidecar in `reference/project-format.md`.
- A CHANGELOG entry under Unreleased/Added.
