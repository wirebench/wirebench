# Unsaved changes across sessions — design

Status: implemented · 2026-09-13

## Problem

Saving is manual by default, but two exits bypass that choice today:

- **Quit** (`before-quit` → `WorkspaceService.saveAll('quit')`) and **workspace close/switch**
  (`WorkspaceService.close()` → `saveAll('close')`, plus `ProjectHost.closeInternal` saving a
  dirty project) write every unsaved project change to the project files without asking.
- **Request-tab edits are lost** on both exits. They live only in the renderer's drafts store
  (`editRequest` → `stageRequest`) until the user saves; nothing sends them to main before it
  writes, and nothing persists them. The only close-time hook (`pagehide`) records open tabs.

So a quit both writes changes the user did not save *and* loses the edits they were looking at.

## Decisions (from the user)

1. Nothing is written to the project files on **quit** or on **workspace close/switch**. Only
   Save (⌘S / Save All) or autosave writes.
2. **Everything** unsaved is kept: request-tab drafts *and* changes main already holds
   (properties, auth, endpoints, settings, renames, imports-in-progress edits…). On the next
   open of that workspace they come back still marked unsaved.
3. If a project changed on disk in between, unsaved changes are **restored on top** of the new
   files, with a notice. Changes whose request (or other file) no longer exists are dropped and
   listed in the notice.
4. Unsaved changes also **survive a crash or force-quit**: the recovery record is kept current
   while the app runs, not only written on a clean exit.

## Design

### What is stored

One recovery record per workspace, under
`<userData>/workspaces/<workspaceId>/unsaved/`:

- `<projectId>.json` for each project that was dirty at close:
  `{ version: 1, savedAt, baseline, unsaved }`, where both `baseline` and `unsaved` are
  `relative path -> file content` maps produced by the engine's `projectFiles()`:
  - `baseline` — the files as they were on disk when the model was last in sync (at open, or at
    the last save). The host already tracks `lastWritten` after a save; it now also records the
    serialised files at open.
  - `unsaved` — `projectFiles(model)` of the in-memory model at close.
- `drafts.json`: `{ version: 1, requests: { [requestId]: RequestPatchWire } }` — the renderer's
  staged request patches.

A snapshot of files (rather than a replay log of `ProjectChange`s) is deliberate: not every way
a project becomes dirty goes through `mutate` (`addAttachmentBytes`, `applyDefinitionUpdate`),
and the project format is already one file per request, interface and environment, which is the
natural unit to merge. Content-addressed side files (attachments, definition caches) are already
on disk when the model references them and are only pruned by a save, so they survive.

Records are written atomically (temp file + rename), like `workspace-state.json`. A missing,
corrupt or unknown-version record reads as "nothing to restore" — it must never stop a
workspace from opening.

### Closing (quit or switch)

- `ProjectHost.close({ keepUnsaved: true })` skips the save and returns
  `{ baseline, unsaved }` when dirty. `reload()` keeps its "take what is on disk" meaning.
- `WorkspaceService.close()` no longer calls `saveAll('close')`; it collects each dirty host's
  record and writes it, plus the drafts it was given, then closes hosts as before. A clean
  project's stale record (if any) is removed.
- **Quit:** `before-quit` pauses the quit, emits `workspace.flushDrafts` to the window, and waits
  (≤ 2 s) for the renderer to answer through the new `workspace.stashDrafts` channel. Then it
  calls `workspaceService.close()` and lets the app exit. No reply in time → close anyway; the
  main-side changes are still kept.
- **Switch/close from the UI:** the renderer calls `workspace.stashDrafts` with its drafts right
  before `workspace.open` / `workspace.close`, in the same place it already saves the outgoing
  workspace's tabs.

### Keeping the record current (crash survival)

- Main: whenever a host changes while dirty (`onChanged` after a mutation, attachment add,
  definition update), `WorkspaceService` schedules that project's record write, debounced
  (2 s, trailing; coalesced per project). Writes go to the `unsaved/` folder only, never the
  project folder, and are serialised per project so an older snapshot never lands after a newer
  one.
- Renderer: whenever the drafts store changes, it calls `workspace.stashDrafts` debounced (1 s),
  and immediately before a switch/close and on `workspace.flushDrafts`.
- Cleared: a successful save of a project deletes its record (and removes its requests from
  `drafts.json` once the renderer clears those drafts); reload and remove-from-workspace delete
  it; a record whose project is no longer dirty is deleted instead of rewritten.
- Launch after a crash is identical to launch after a clean quit: `open` finds the records and
  restores them. At worst the last ~2 s of edits before a crash are missing.

### Opening

After each project's host opens (`openEntry`), `WorkspaceService` reads that project's record:

- **Per-file three-way merge** of `baseline` (B), current disk (D, `projectFiles` of the freshly
  loaded project) and `unsaved` (U). Comparison ignores the manifest's `writtenBy`, which every
  save rewrites.
  - U = B → take D (only disk changed, or nothing changed).
  - D = B → take U (only the unsaved side changed).
  - both changed, file present in D → take U (**restored on top**) and list it as a conflict.
  - file removed from D but changed in U → **drop** it and list it (a request deleted on disk).
  - file added only in U → take U; added only in D → take D.
- The merged map is parsed with `loadProject(dir, { fs: overlay })`, an `FsLike` that serves the
  merged managed files from memory and everything else from the real folder. The host adopts it
  with `dirty = true` and `baseline = D`, so a later Save writes exactly the restored state.
- If the merged files do not parse, the record is kept aside as `<projectId>.failed.json`, the
  project opens from disk, and the notice says the unsaved changes could not be restored.
- The record is deleted once applied; it is written again at the next close if still dirty.

Drafts: `workspace.open`'s reply (and the launch-time `workspace.snapshot`) carries
`restoredDrafts` and a `restoreNotice`. The renderer stages each draft whose request still
exists into the drafts store before re-opening tabs — `layerEdits` already lays drafts over every
snapshot — and drops the rest into the notice. `drafts.json` is deleted once handed over.

### The notice

Shown once after a workspace opens with anything restored: "Restored unsaved changes in
*Project*". If any file conflicted or was dropped, it names them ("changed on disk: …; removed on
disk, dropped: …"). No notice when nothing was restored.

### What does not change

- Save, Save All and autosave write exactly as today; a successful save leaves nothing to
  restore for that project.
- Reload ("take what is on disk") discards unsaved changes and removes the record.
- Removing a project from the workspace discards its record.

## Testing

- Unit (main): merge table cases; `close` writes records and does not touch project files;
  `open` restores dirty state, drops/flags per the table, survives a corrupt record;
  `workspace-service.test.ts` "saves a dirty host on close" becomes "keeps a dirty host unsaved
  on close".
- Unit (renderer): drafts are stashed before switch/close and on `workspace.flushDrafts`;
  restored drafts are staged and show the unsaved dot; the notice renders.
- Unit: debounced record write after a change; record removed after save/reload/remove.
- e2e: kill the app process (no clean quit) after an unsaved edit, relaunch → restored.
- e2e: edit a request and a property without saving, quit, relaunch → both still shown unsaved,
  project files unchanged on disk; same across a workspace switch; edit a request, change its
  file on disk while closed → restored with a notice; delete it on disk → dropped with a notice.

## Docs

CHANGELOG (Changed: quitting and switching workspaces no longer write unsaved changes; they come
back on the next open), and the `before-quit` comment in `main/index.ts`.
