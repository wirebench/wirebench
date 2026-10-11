# Variables in the editor — design

Issue #340 · milestone 5.1 · 2026-10-11

## Problem

Every request uses variables, but the editor gives little help with them. Today:

- The URL bar colours `${…}`.
- **Get Data…** in the SOAP Form view inserts a reference.

Nothing completes a name as you type it, says what a reference resolves to, or marks a misspelt
name where it is written. An unresolved name shows up only in Problems, after a send for REST, gRPC
and WebSocket. And turning a value you are looking at into a variable means a trip to the
Environments page.

## What exists

- **The reference grammar** lives in `packages/engine/src/project/properties.ts`:
  - `${name}`, the shorthand, resolves through the chain Env → Project → Workspace → Global.
  - `${#Scope#name}` names a scope explicitly.
  - `${secret:name}` reads a secret.
  - `$${` escapes a literal `${`.

  The scanner (`tokenize`) is private, and nothing in it is reachable from the renderer. #333
  (PR #384) adds `${$name}` / `${#Dynamic#name}`, plus a Monaco completion for generator names
  after `${$`.
- **Main builds a send's scopes** with the engine's `scopesFor(runContext)`. The run context comes
  from `ProjectRouter.runContextFor(requestId)`. Several things are applied there:
  - current values;
  - the active workspace environment, merged with the linked project's environment;
  - disabled names;
  - globals.
- **The renderer holds every committed variable map**: project, workspace, globals and environments.
  It never holds a secret's value. A secret variable's value is a `${secret:name}` token, and the
  plaintext lives in the keychain, where only main reads it.
- **Fields use three kinds of widget:**
  - The URL is `PropertyHighlightInput`, an `<input>` over a coloured mirror.
  - Params, headers, form fields and metadata are `KvTable` cells, which are textareas.
  - Auth fields are plain `<input>`s in `auth-fields.tsx`.

  Bodies, the SOAP envelope, gRPC and WebSocket messages, and responses all use Monaco through
  `CodeEditor`. Monaco providers are process-global. Each existing provider opts models in with a map
  keyed by model URI (`json-completion.ts`, `script-language.ts`).

## Decisions (owner, 2026-10-11)

1. **A secret is always masked.** If a variable's value reaches a `${secret:…}` token or a
   `${#System#…}` variable, the hover shows `••••••` and the secret's name. **Show secrets** does not
   change this. No new channel returns a secret value.
2. **An unresolved name is underlined where it is written.** In Monaco it gets a squiggle (a marker).
   In the URL bar, KV cells and auth inputs it gets a wavy underline in the mirror behind the text.
   KV cells and auth inputs get the same mirror the URL bar has.
3. **Completion inserts the shorthand, or the explicit form when shadowed.** The entry the chain
   resolves to inserts `${name}`. An entry hidden by a nearer scope inserts `${#Project#name}` (and
   so on). Secrets insert `${secret:name}`, and generators insert `${$name}`.
4. **Set as variable replaces the selection** in a request field or body with the reference (rule 3).
   In a read-only response it only creates the variable. The scopes offered are the active
   environment, the project, the workspace and globals.

## Design

### One list of what is in scope: `variables.list`

The new channel `variables.list({ requestId }) → { entries, secretNames }` is answered by main from
`runContextFor` and `scopesFor`. These are the same scopes a send expands against, so the editor
cannot disagree with the wire.

```ts
VariableEntryWire = {
  name: string;
  scope: 'Env' | 'Project' | 'Workspace' | 'Global' | 'System';
  value?: string;      // its own references expanded; absent when masked
  masked: boolean;     // decision 1
  secretName?: string; // the secret a masked value reads
  shadowed: boolean;   // a nearer scope defines the same name
  edit?: EditTarget;   // where the hover's Edit link goes
}
EditTarget = { kind: 'environment'; id } | { kind: 'project'; projectId } | { kind: 'workspace' } | { kind: 'globals' }
```

- **Expansion.** A value is expanded with `expand()` against the request's scopes, with no secrets
  supplied. The value is masked if the raw text contains `${secret:`, or if the expansion used
  `System` or `Secret`.
- **System entries** are sent by name only, always masked, with no edit target. They exist so that
  `${#System#HOME}` is not marked unresolved. Completion offers them only after `${#System#`.
- **`secretNames`** are the secret names the request may read. They let `${secret:` complete, and let
  a misspelt secret be marked. They never carry values.
- **An Env entry's edit target** is decided in this order:
  1. the linked project environment, if it defines the name;
  2. otherwise the workspace environment;
  3. outside a workspace, the project's own active environment.
- **Current values** are laid over the committed values, as a send does.

In the renderer, `useRequestVariables(requestId)` fetches the list. It fetches again when the project,
workspace, globals, current-values or secrets stores change.

### Finding references

`propertyReferences(text)` lives in a new pure module, `project/references.ts`, apart from
`properties.ts` so it does not collide with #333's edits there. It is re-exported through the
browser-safe `@wirebench/engine/rest` entry, because the renderer's ESLint allow-list is protected.

It returns every `${…}` with:

- its `start` and `end`;
- its form: `shorthand | scoped | secret | dynamic | malformed`;
- its scope and name.

It follows `tokenize` exactly: the `$${` escape, nested braces, and an unterminated `${` treated as
malformed. A test checks its spans against `expand()`'s `unresolved` offsets.

The renderer's pure `classifyReference(ref, list)` returns one of:

- `{ entry }`: resolved;
- `{ generator }`: a #333 dynamic value;
- `'unresolved'`;
- `'unknown'`: Sequence (known only during a run), a nested or computed name, or the list not yet
  loaded. These are never marked.

### Monaco

`editor/variable-assist-monaco.ts` registers a completion provider and a hover provider for `xml`,
`json` and `plaintext`, once per process. Both look up the model's URI in a map.

A request or response editor joins the map from its `onMount` with
`attachVariableAssist(editor, monaco, source)`. Models outside the map get nothing. The same call:

- **Sets markers.** They go under the owner `wirebench-variables`, with warning severity and the
  message `Unresolved variable "name"`. They are recomputed on content change (debounced) and when
  the list changes.
- **Adds a "Set as variable…" action** to Monaco's context menu, shown when text is selected. The
  SOAP request pane turns off Monaco's menu, so its Radix `RequestContextMenu` gets the same item,
  reading the selection from the active request editor.

**Completion** triggers on `{`, `#` and `:`, and only directly after an open `${`. It recognises
these prefixes:

| Prefix | Lists |
| --- | --- |
| `${na` | names |
| `${#` | scope names |
| `${#Env#na` | names in that scope |
| `${secret:na` | secret names |

`${$` and `${#Dynamic#` are left to #333's provider, so the generators are not listed twice. Each
item shows its scope as `detail`, and its value (or `••••••`) as documentation.

**The hover** shows:

- the name and scope;
- the value, masked per decision 1;
- an **Edit** link, a `command:` URI for a command registered once that opens the edit target's tab.

An unresolved reference's hover says it is unresolved.

### Plain fields

`VariableAssistContext` carries `{ variables, onSetAsVariable }`. Each kind's request editor
provides it. `KvTable`, `PropertyHighlightInput` and the auth inputs read it. Without it they behave
exactly as today, which covers the Environments tables and the webhook dialog.

With the context, a field gets four things.

- **Mirror.** References are coloured as the URL bar does now. An unresolved one is drawn with
  `underline decoration-wavy decoration-status-error`, plus `data-unresolved`.
- **Completion.** A listbox popup opens under the field when the text before the caret ends in an
  open-reference prefix. It follows the combobox pattern:
  - `aria-autocomplete="list"` and `aria-activedescendant`;
  - ↑/↓ to move, Enter or Tab to accept, Escape to close.

  While the popup is open, Escape closes the popup instead of reverting the cell, and Enter accepts
  instead of committing.
- **Hover.** A card appears when the pointer is over a reference. The input lies above a
  `pointer-events: none` mirror, so the hit test compares the pointer against each reference span's
  `getClientRects()`. That also works for wrapped textarea lines. The card has the same content as
  the Monaco hover.
- **Set as variable…** is a button in the field's selection menu (right-click on selected text).

### Set as variable dialog

`SetVariableDialog` is a Radix dialog with these fields:

- **Name** — must be a valid property name. A name already in the chosen scope needs **Replace
  existing**.
- **Scope** — the active environment (when there is one), the project, the workspace (inside a
  workspace) and globals. The default is the environment, or else the project.
- **Value** — the selection, read-only.

**Create** writes through the actions the Environments page and project tab already use:

| Scope | Action |
| --- | --- |
| Workspace environment | `queueEnvironmentPatch` |
| Project environment | `updateEnvironment` |
| Project | `setProjectProperty` |
| Workspace | `mutate({ kind: 'set-workspace-property' })` |
| Globals | `useGlobalsStore.set` |

The dialog then returns the reference to insert, per rule 3, given the list plus the new entry. The
caller replaces the selection: `executeEdits` in Monaco, or a value splice that is committed at once
in a field.

### Kinds covered

| Kind | Fields |
| --- | --- |
| REST | URL, params, headers, form fields, auth, raw body, response body |
| SOAP | envelope, headers, auth, response |
| gRPC | message, metadata |
| WebSocket | URL, saved messages, headers |

Each editor wraps its tabs in `<VariableAssistProvider requestId>`.

## Out of scope

- Scripts, which have their own `vars` completion.
- Mock responses.
- The Environments tables.
- The SOAP Form view inputs (Get Data… already serves them).
- The WebSocket composer.
- Writing a current value from Set as variable.
- Revealing secrets.
- Scrolling the Environments page to the edited row.

## Testing

- **Engine:** `propertyReferences` unit tests, including span parity with `expand()`.
- **Main:** `variables.list` over environments, current values, a secret-backed variable, a shadowed
  name and a workspace-linked environment. The test seeds a secret and asserts its plaintext appears
  nowhere in the answer.
- **Renderer, pure:** completion context and items, classification, and the insert-form rule.
- **Renderer, jsdom:**
  - `KvTable` and the URL bar with the provider: the underline, the popup's keyboard flow, and the
    masked hover card.
  - The Monaco providers and markers, through the fake.
  - `SetVariableDialog`: the scope list, validation, store calls and the returned reference.
- **e2e (CI):** type `${` in a REST header and pick a name; hover shows a masked secret; a misspelt
  name in the body gets a marker; Set as variable on a response creates a Globals entry.
