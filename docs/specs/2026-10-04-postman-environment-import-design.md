# Spec: Postman environment, globals and collection variable import

**Date:** 2026-10-04
**Status:** draft (under review)
**Scope:** the first item of [#64](https://github.com/wirebench/wirebench/issues/64): Postman
environment exports, globals exports, and the collection and folder variables the collection
importer drops today. HAR 1.2, `.http` files and OpenCollection YAML stay on #64 for later slices.

Builds on `docs/specs/2026-09-14-postman-collection-import-design.md` (the collection importer this
extends) and `docs/specs/2026-09-12-wirebench-layout-and-environments-design.md` (environments and
property scopes).

## 1. Objective

**What.** Let someone who is moving to Wirebench bring their variables along with their requests:

- A Postman **environment export** (`*.postman_environment.json`) becomes a Wirebench **workspace
  environment**.
- A Postman **globals export** (`*.postman_globals.json`) merges into Wirebench's **Globals** scope.
- A collection's **collection-level and folder-level variables** become **project properties** of
  the project the collection is imported into.

**Why.** The collection importer already rewrites `{{name}}` to `${name}`, but nothing defines
those names afterwards. Today the switching guide tells people to recreate every environment and
collection variable by hand
(`docs-site/src/content/docs/switching/postman.mdx`, the rows for collection variables and for
environment and globals exports). Re-typing values is where a migration stalls.

**User stories.**

- I export my "Staging" environment and import it with **Import…**. A workspace environment named
  "Staging" appears with every variable, and the ones I had disabled are still disabled.
- My environment holds an API token marked secret. After import, its value is in Wirebench's secret
  store, and the environment shows `${secret:staging_apiToken}` instead of the token itself.
- I import my globals. Variables I already had in Globals keep their values, and the summary lists
  the ones it skipped.
- I import a collection whose requests use `{{tenant}}`, defined as a collection variable. The
  requests send without my defining `tenant` myself.

## 2. Decisions (owner, 2026-10-04)

| Question | Decision |
| --- | --- |
| Which sources | Environment exports, globals exports and collection variables, all in this slice |
| Where an environment lands | A workspace environment, with no project picker |
| Secret values | `type: "secret"` values go into the secret store; the property becomes `${secret:name}` |
| Environment name clash | The import gets a numbered name ("Staging 2"), noted in the report |

Clashes on single names, in Globals and in project properties, follow the legacy SOAP project
importer: the existing value is kept and the report notes the skipped name.

## 3. Input formats

An environment export:

```json
{
  "id": "…",
  "name": "Staging",
  "values": [
    { "key": "baseUrl", "value": "https://staging.example.com", "type": "default", "enabled": true },
    { "key": "apiToken", "value": "…", "type": "secret", "enabled": true }
  ],
  "_postman_variable_scope": "environment",
  "_postman_exported_at": "…",
  "_postman_exported_using": "…"
}
```

A globals export has the same shape, with `"_postman_variable_scope": "globals"`.

- `type` is `default`, `secret`, or the older `text` (read as `default`). A missing `type` is
  `default`; any other value is read as `default` and noted in the report.
- `enabled` defaults to `true` when missing.
- `value` is a string. A number or boolean is turned into a string; any other value is skipped
  and reported.
- A `values[]` entry with no `key`, or an empty one, is skipped and reported.
- Two entries with the same `key`: the first one wins, and the report notes the duplicate.

## 4. Detection

`packages/engine/src/import-detect.ts` gains two kinds, checked **before** the collection check:

| Kind | Content rule (definite) | File-name rule (probable) |
| --- | --- | --- |
| `postman-environment` | a `values` array and `_postman_variable_scope === "environment"` | ends with `.postman_environment.json` |
| `postman-globals` | a `values` array and `_postman_variable_scope === "globals"` | ends with `.postman_globals.json` |

A JSON object with `values[]` and `name` but no `_postman_variable_scope` is detected as a
`postman-environment` with `probable` confidence (some tools that write the format omit the field).

## 5. Engine

New module `packages/engine/src/rest/postman/variables.ts`, exported from the `postman` index.
It is **pure**: no file access, no secret store, no workspace. It turns text into a plan that the
desktop main process applies.

```ts
type PostmanVariableScope = 'environment' | 'globals';

interface ImportedVariable {
  readonly name: string;
  /** `{{x}}` already rewritten to `${x}`. Empty for a secret; its value is in `secretValue`. */
  readonly value: string;
  readonly enabled: boolean;
  readonly secret: boolean;
  /** Only for `secret: true`. Never written to disk by the engine. */
  readonly secretValue?: string;
}

interface ParsedPostmanVariables {
  readonly scope: PostmanVariableScope;
  readonly name: string;            // "Globals" for a globals export with no name
  readonly variables: readonly ImportedVariable[];
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
}

function parsePostmanVariablesText(text: string): ParsedPostmanVariables;  // throws PostmanError
```

`ParsedPostmanVariables` holds no Postman-specific types, so a later OpenCollection environment
importer can produce the same plan and reuse the desktop side unchanged.

**Value rewriting.** `{{x}}` inside a value is rewritten to `${x}` with the collection importer's
existing helper. Postman's dynamic variables (`{{$guid}}`, `{{$timestamp}}`, …) are left as written,
and the report lists each variable that contains one, since Wirebench does not expand them.

**Credential hint.** For a variable that is **not** typed `secret` but whose name contains `token`,
`password`, `secret`, `apikey` or `api_key` (case-insensitive), the report adds one warning listing
those names, suggesting they be marked Secret. Their values are imported as they are.

**Limits and errors.** All are `PostmanError` codes:

- `postman-too-large`: the 50 MB input limit the collection importer already has.
- `postman-invalid-json`: the text is not JSON.
- `postman-not-variables`: the JSON is not an environment or globals export.
- `postman-data-dump`: a bulk data dump, a zip archive or a JSON with top-level `collections` and
  `environments` arrays. It is refused with a message telling the user to export the environments
  one by one.

The file-reading entry point mirrors `importPostmanCollection`:
`importPostmanVariables(source: PostmanSource): Promise<ParsedPostmanVariables>`.

### 5.1 Collection variables

`apiFromPostmanCollection` (`map.ts`) gains a `projectProperties` output: every collection-level
variable except the one used as the base URL (`baseUrl` or `base_url`), then every folder-level
variable in depth-first order. The rules:

- `{{x}}` in values is rewritten to `${x}`.
- `disabled: true` puts the name in the project's `disabledProperties`.
- Several definitions of the same name: the first wins, and the report notes the rest by folder
  name.
- The existing warning "Collection and folder variables were not imported…" is removed.

## 6. Desktop

### 6.1 Main process

Two new IPC channels in `apps/desktop/src/shared/ipc.ts`, handled in
`apps/desktop/src/main/ipc/api.ts`:

- `api.importPostmanEnvironment`, with the source (`file` or `text`) in the request.
- `api.importPostmanGlobals`, with the same request shape.

A file source goes through `checkedImportSource`, like `api.importPostman`.

**Environment apply.**

1. Pick the name: the export's name, or `"<name> 2"`, `"<name> 3"`, … if a workspace environment
   already has that name (compared case-insensitively). Slug from the chosen name.
2. For each secret variable, pick a store name: `<envSlug>_<variable>`, with every character
   outside `[A-Za-z0-9_]` replaced by `_` and a leading `_` added if it starts with a digit. If the
   secret store already has that name, append `_2`, `_3`, …. An existing secret is **never
   overwritten**. Write the value with the secret store's `set`, and set the property to
   `${secret:<storeName>}`.
3. A secret variable whose value is empty gets no store entry: its property is `${secret:<storeName>}`
   and the report lists it as needing a value.
4. Add the environment to the workspace (properties, `disabledProperties`, no endpoints), save the
   workspace, and **do not** change which environment is active.
5. If saving the workspace fails, delete the secrets this import wrote and rethrow, so a failed
   import leaves nothing behind.

**Globals apply.** Merge into the Globals store (`main/global-properties.ts`).

- A name that already exists keeps its value and is listed in the report.
- New disabled variables join the store's `disabled` list.
- Secrets follow the same steps as for an environment, with `globals` in place of `<envSlug>`.

**Collection variables apply.** The existing `api.importPostman` handler merges `projectProperties`
into the target project:

- New names are added.
- An existing name keeps its value and is reported.
- Disabled names join `disabledProperties`.

A collection imported into a new project gets all of them.

**Response summary**, shared by both new channels:

```ts
{
  name: string;                 // the environment's final name, or "Globals"
  renamedFrom?: string;         // set when a clash forced a numbered name
  variables: number;
  secretsStored: number;
  skipped: readonly string[];   // names kept at their existing value (globals)
  warnings: readonly string[];
  notes: readonly string[];
}
```

The collection import summary gains a `projectProperties` count and the skipped names.

### 6.2 Renderer

The one **Import…** dialog (`features/explorer/import-dialog.tsx`):

- Lists two more formats: **Postman environment** and **Postman globals**. Auto-detect picks them
  from content or file name.
- For both formats, shows the File and Paste tabs and **hides the project picker**.
- Shows the summary in the dialog's existing summary layout: counts, then **Things to look at**
  (warnings) and **Notes**, with **Copy report**.

New command-palette entries: **Import Postman Environment…** and **Import Postman Globals…**, each
opening the dialog on that format. After an environment import, the Environments view lists the new
environment. The renderer never sees a secret value: the main process reads and stores it.

## 7. Docs

- `docs-site/src/content/docs/switching/postman.mdx`: the rows for collection variables and for
  environment and globals exports describe the new mapping, and the steps no longer say to
  recreate variables by hand.
- `docs-site/src/content/docs/guides/importers.mdx`: a Postman environments and globals section
  with the clash and secret rules.
- `docs-site/src/content/docs/reference/commands.md`: the two new commands.
- `CHANGELOG.md`: one entry.

## 8. Files

```text
packages/engine/src/rest/postman/variables.ts         new: parse + map, pure
packages/engine/src/rest/postman/import.ts            importPostmanVariables
packages/engine/src/rest/postman/map.ts               projectProperties output
packages/engine/src/rest/postman/index.ts             exports
packages/engine/src/import-detect.ts                  two new kinds
packages/engine/src/errors.ts                         new PostmanError codes
packages/engine/test/unit/rest/postman/variables.test.ts
packages/engine/test/unit/rest/postman/map.test.ts    collection variables cases
packages/engine/test/unit/import-detect.test.ts       new kinds
fixtures/postman/crafted/environment/staging.postman_environment.json
fixtures/postman/crafted/environment/workspace.postman_globals.json
apps/desktop/src/shared/ipc.ts                        two channels
apps/desktop/src/shared/wire-types.ts                 request and summary schemas
apps/desktop/src/shared/commands.ts                   two commands
apps/desktop/src/main/ipc/api.ts                      handlers
apps/desktop/src/main/postman-variables-apply.ts      new: apply plan to workspace, globals, secrets
apps/desktop/test/postman-variables-apply.test.ts
apps/desktop/src/renderer/features/explorer/import-dialog.tsx
apps/desktop/test/renderer/import-dialog.test.tsx     new formats
e2e/specs/postman-import.spec.ts                      environment import case
```

## 9. Testing

**Engine, unit.**

- Parsing the environment and globals fixtures: names, values, enabled flags, secret flags.
- `text` read as `default`; a missing `enabled` read as `true`.
- Number and boolean values turned into strings; object values skipped and reported.
- Duplicate keys: the first wins and the duplicate is noted.
- `{{x}}` rewritten to `${x}`; dynamic variables left as written and reported.
- The credential-name warning.
- Every new error code, including the data dump.
- Detection: both kinds by content and by file name, the probable case without
  `_postman_variable_scope`, and a collection still detected as a collection.
- Collection variables: base URL excluded, folder order, first definition wins, disabled names.

**Main, unit** (temp folder, in-memory secret store):

- Environment name clash numbering.
- Secret store name sanitizing and clash numbering, with an existing secret left untouched.
- An empty secret gets no store entry.
- Globals merge keeps existing values.
- Rollback of written secrets when the workspace save fails.

**Renderer, unit.** The dialog offers both new formats, hides the project picker for them, calls
the right channel, and renders the summary.

**e2e.** Import the crafted environment through **Import…**; the Environments view lists it, and a
secret variable shows as a secret reference.

**Gates.** `WIREBENCH_SKIP_PERF=1 pnpm check` before each commit, and `pnpm check:banned-terms`.

## 10. Boundaries

- **Always:**
  - Keep the engine pure and the renderer free of secret values and file access.
  - Never overwrite an existing environment, global, project property or secret.
  - Report every value that did not come across as it was.
- **Never:**
  - Activate the imported environment.
  - Write a secret value into a project or workspace file.
  - Add a third-party dependency.

## 11. Out of scope

- Postman's per-variable "current value" versus "initial value". The export carries one `value`,
  which becomes the committed value.
- Bulk data dumps (refused, §5).
- Exporting Wirebench environments to Postman format.
- HAR 1.2, `.http` files and OpenCollection YAML (the rest of #64).

## 12. Success criteria

- [ ] An environment export imports as a workspace environment with variables, disabled flags and
      secrets, through file or paste.
- [ ] A globals export merges into Globals without changing an existing value.
- [ ] Collection and folder variables arrive as project properties.
- [ ] No secret value lands in a project or workspace file; no existing secret is overwritten.
- [ ] Every name clash, skipped value and unsupported item is in the report.
- [ ] The switching guide no longer tells people to recreate variables by hand.
- [ ] `WIREBENCH_SKIP_PERF=1 pnpm check` passes.
