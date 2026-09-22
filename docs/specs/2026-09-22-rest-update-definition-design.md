# Update Definition for a REST API — design

Issue: #47 · Date: 2026-09-22 · Status: approved to build (owner: "go", 2026-09-22)

## Objective

Re-import a changed OpenAPI document into an existing REST API without losing what the user edited,
and show, before anything changes, a per-operation report of what the new document adds, removes and
changes. It completes the pattern the WSDL and AsyncAPI imports already have.

## Decisions

1. **Mirror the AsyncAPI update (#100)**, the closest analogue: re-map both the old (cached) and new
   documents with the importer's pure `apiFromDocument`, and let a generated field follow the new
   document **only while it still equals what the old document generated**. No generated snapshots
   are stored; the old cache is the record.
2. **Operation identity** is `method + path` as written in the document (the #45 `contract` link).
   A path renamed in the document is a removal plus an addition — no guessing by operationId.
3. **Never deletes.** A request whose operation is gone gets `orphaned: true`; an operation that
   returns clears it. Requests with no `contract` link are left alone (they are the user's).
4. **Preview, then apply, guarded by a fingerprint** of every document the preview read; apply
   re-reads the source and refuses with `definition-changed` if it differs (reuse `fingerprintOf`).
5. **Where a request's fields follow the contract:** URL (path template), path/query/header parameter
   rows (per row, keyed by `in + name`: a row still at its old generated value follows; a new row is
   appended; a row the new document dropped is kept only if edited, else removed; user-added rows are
   untouched), body (content type and sample, only while untouched), auth (only while untouched).
   One thing an **edited** row still follows: a parameter the new document made required turns its
   row on, so the request stays sendable as the document now demands. Only the box changes — the
   user's value is kept — and a row the user added by hand is left alone, since the document never
   generated it. In practice this is a query parameter: a path row is always on and a header row
   never is, so neither can make that crossing.
   API level: base URL / servers and API auth follow while untouched; the API's `definition.version`
   is updated.
6. **After apply:** the definition cache is rewritten (when the API caches its definition), the #45
   parsed-document memo (`openApiDocuments`) is dropped for that API, and the project is saved with
   reason `update-definition`; if the save fails, the in-memory project is rolled back (WSDL rule).

## Behaviour

- **Plan** `RestUpdatePlan = { added: RestOpRef[]; removed: RestOpRef[]; changed: { op: RestOpRef; reasons: RestChangeReason[] }[]; api: RestApiChangeReason[] }`
  with `RestOpRef = { method; path; summary? }` and
  `RestChangeReason = 'parameters' | 'request-body' | 'responses' | 'security' | 'servers'`,
  `RestApiChangeReason = 'servers' | 'security' | 'version'`.
- **Apply result** `{ api; requestsAdded; requestsOrphaned; requestsRestored; requestsRewritten; rowsAdded; rowsRemoved }`.
  New operations get one request each, placed in the folder of their first tag (created if missing)
  or the API root, named as the importer names them.
- **Entry points:** the REST API's context menu and overview get "Update Definition…", enabled when the
  API cached its definition (`definition.cache`) — a recorded source alone is not enough, because the
  update compares against the cached document and would otherwise dead-end. The dialog mirrors the AsyncAPI one: Added / Removed / Changed lists
  with reasons, an "already matches its source" empty state, Apply disabled and "Preview again" shown
  on `definition-changed`, a toast with counts after apply.
- A source may be the original URL/file or a new one chosen in the dialog (same path-access check as
  import).

## Success criteria

- SC-1: an untouched request follows a changed parameter, body sample and path template.
- SC-2: an edited parameter value, body and auth are kept; user-added parameter rows are kept; an
  edited row whose parameter became required is turned on, keeping its value.
- SC-3: a removed operation's request is orphaned and kept; restoring the operation clears the flag.
- SC-4: a new operation gets one request in its tag folder.
- SC-5: the plan lists exactly what apply does (same added/removed/changed sets).
- SC-6: a source changed between preview and apply is refused with `definition-changed`.
- SC-7: after apply, #45 response checks use the new response schemas (memo dropped).
- SC-8: a failed save leaves the project as it was.

## Boundaries

- No new dependency; no project format version bump.
- Never name another product (`pnpm check:banned-terms`).
