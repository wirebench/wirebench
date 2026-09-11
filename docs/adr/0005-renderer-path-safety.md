# ADR-0005: Renderer paths are containment-checked or dialog-proven, never trusted

- Status: accepted
- Date: 2026-09-10 (recorded 2026-09-11; decision made in Task 36)
- Context: spec §4 (security baseline), §12; global constraint "renderer: no network/fs/secrets"

## Context

The renderer is sandboxed (`sandbox: true`, `contextIsolation: true`, `nodeIntegration:
false`, strict CSP, `app://` custom protocol) and reaches the system only through typed,
zod-validated IPC. But several real features are *about* files: opening an attachment,
resolving an inline `file:` reference in an envelope, loading a PKCS#12 keystore, writing a
Dump File. Each of those arrives as a string from the renderer.

If main opens whatever path it is handed, the sandbox buys nothing: a bug in the renderer
becomes "read any file this user can read". And the obvious fix — string prefix comparison
against the project folder — is defeated by `..`, by a symlink planted inside the project, and
on Windows by short names and alternate separators.

## Decision

Main never treats a renderer-supplied path as authority. A path is usable only if one of two
things is true:

1. **Containment.** The path, with `realpath` resolved through whatever prefix of it already
   exists, lies inside a folder the app owns — the project folder or its caches
   (`apps/desktop/src/main/path-containment.ts`). Resolving the existing prefix is what makes a
   symlink planted mid-path unable to escape the check, and it works for files that do not
   exist yet (a Dump File target) without creating anything.
2. **Dialog evidence.** The user drove a native OS dialog to that exact path during this
   session, and main remembers it (`apps/desktop/src/main/dialog-picks.ts`). The renderer can
   *ask* for a dialog; it cannot fabricate the answer.

The two halves are joined in one predicate (`path-access.ts`), so every feature asks the same
question and a fix to either half reaches all of them. The project folder that acts as the
containment root is itself dialog-proven: `project.open`/`project.create` take their folder
from the native folder picker run in main, so the *root* of every containment check is a path
the user chose rather than one the renderer named.

Importing a definition is bound by the same rule at both ends. `definition.import
{ kind: 'file' }` runs `allowsReadPath` before the engine opens anything, and once a document
is open the WSDL's own nested references are confined too: a file-rooted definition may only
reference files inside its folder, a remote one may never reference `file:` at all
(`packages/engine/src/wsdl/ref-policy.ts`). A dropped file is not a pick, so the import dialog
reads dropped bytes in the renderer and sends them as text. Names the user types become path
segments only through `slugify` (`packages/engine/src/project/paths.ts`), which strips
characters illegal on any supported OS, refuses Windows device names, and cannot produce a
traversal segment.

## Rationale

- **Capabilities, not paths.** "The user picked this file" and "this file is inside the
  project" are both facts main can verify; "the renderer says so" is not.
- **Symlinks are the interesting case**, and the only correct time to resolve them is against
  the real file system, not by string manipulation.
- **One predicate, not five.** The failure mode of per-feature checks is that the fifth one
  forgets a case; the shared implementation is why the fifth one cannot.

## Consequences

- Every new file-touching feature must route through `allowsReadPath`/the containment helpers.
  A feature that calls `fs` directly on renderer input is a bug, and review treats it as one.
- Dialog memory is per session: relaunching the app means picking an out-of-project keystore
  again. Accepted — the alternative is a persistent allow-list, which is a larger thing to get
  right.
- Containment costs a `realpath` per check. Irrelevant next to the I/O it guards.
- The `WIREBENCH_E2E_*` test hooks stub the *dialogs* (so e2e can drive a file picker); they
  do not bypass containment. See the test-hooks section of
  [`../security.md`](../security.md).
