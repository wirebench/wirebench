# Save granularity: per-tab save and per-tab dirty marks

Goal: `Mod+S` saves the active tab's item only; `Shift+Mod+S` saves everything; each editor tab
shows a dot while it has unsaved edits.

> **Status (2026-09-12, after the fact):** shipped as option C, on top of a main that had since
> made saving manual (`editor.autosave`, off by default). That changes the premise below — main
> now holds unsaved state of its own — but not the conclusion: main's `dirty` is per *project*,
> and a per-tab mark needs per-*request*, which is what the draft layer provides. The Save All
> chord landed on `Mod+Alt+S` rather than the `Shift+Mod+S` proposed here, because `Mod+S` went
> to the new per-item save.

## The blocker (as it stood when this was written)

Wirebench has no unsaved state to save. Today:

- Every edit goes straight to the main-process model via `project.mutate`
  (`apps/desktop/src/main/project-host.ts`), which sets one `dirty` flag **per project** and
  arms an autosave timer.
- `AUTOSAVE_DEBOUNCE_MS = 500`. Everything reaches disk half a second after you stop typing.
- `saveProject` (`packages/engine/src/project/save.ts`) is a whole-project *reconciler*: it
  derives the full desired file set from the model, writes only files whose content differs,
  and **deletes managed files on disk that the model no longer has**.

Two consequences:

1. A per-tab dot would light for ~500 ms and go out. There is no durable per-item dirty state
   for it to show.
2. "Save only this item" cannot be expressed against the reconciler. Writing one item while
   withholding another's pending edit means disk no longer matches the model, and the next
   reconcile would treat a withheld deletion as a file to remove.

Content-wise the save is *already* per-item — unchanged files are skipped — so the current
`Mod+S` ("Save All") costs nothing for untouched items. What is missing is not granularity in
the writer, it is **edits that persist unsaved long enough to be worth saving**.

So the feature needs a draft layer, and the real decision is how much of the app gets one.

## Options

**A. Keep autosave; make the shortcuts explicit flushes.** `Mod+S` flushes the active tab's
project, `Shift+Mod+S` flushes all. Per-tab dot shows the 500 ms window. ~half a day. Delivers
the bindings and the dot, but both are close to decorative: autosave writes everything moments
later either way, so "only the active tab" is never observably true.

**B. Full explicit-save.** Autosave off; all edits are drafts until saved. Matches the request
exactly, and is the largest change: every mutation path becomes draft-aware, closing a dirty
tab must prompt, a crash loses work that used to be safe, and external-change reconciliation
has to merge against drafts.

**C. Draft layer for tab-editable items only** *(recommended)*. Items you edit in a tab —
request envelope and fields, environment tables, project settings — become drafts held in the
renderer and committed on save. Everything else (imports, sends, history, keystores) keeps
autosaving as it does now. Per-tab dirty is real and durable; "save the active tab's item" has
a precise meaning; the blast radius stops at the editor surfaces.

## Tasks (option C)

1. **Draft store.** New `state/drafts.ts`: `Map<itemKey, patch>` keyed by tab identity
   (`requestId` / `environmentId` / `projectId`), plus `isDirty(itemKey)`. Renderer-only.
2. **Route tab edits through it.** The editor surfaces currently call `project.mutate`
   optimistically (`state/project.ts`); they instead write to the draft store, and reads merge
   `draft ?? model` so the UI shows edits immediately.
3. **Commit path.** `saveItem(itemKey)` replays that item's pending patches as ordinary
   `project.mutate` calls, then calls the existing `project.save({ projectId })`. No new
   main-process API and no change to the reconciler — the model is whole again before it writes.
4. **Send reads drafts.** `ProjectHost` builds the send input from the saved model; an unsaved
   envelope must still be what goes on the wire, so the send path takes the merged view. This is
   the one place where "unsaved" silently changes behaviour if missed.
5. **Per-tab dot.** `editor-area.tsx` renders a dot when `isDirty(tab)`; title-bar dot becomes
   "any tab dirty".
6. **Shortcuts.** `project.save` (currently labelled "Save All", `Mod+S`) moves to
   `Shift+Mod+S`; new `item.save` on `Mod+S` saves the active tab's item.
7. **Close guard.** Closing a dirty tab, or quitting with dirty tabs, prompts. Without this the
   change makes data loss possible where none exists today.
8. **Tests.** Draft merge/commit units; e2e for edit → dot → `Mod+S` → dot clears and siblings
   stay unsaved; a send with an unsaved envelope.

## Unresolved questions

1. **A, B or C?** The answer changes the size of this from half a day to a week.
2. Does autosave stay on for the draft items as a safety net (e.g. a crash-recovery draft cache
   on disk), or is unsaved genuinely unsaved until `Mod+S`?
3. What should closing a dirty tab do — prompt, silently keep the draft alive in the store, or
   discard?
4. Environments and project settings are edited in grids where every keystroke currently
   persists. Do those become explicit-save too, or stay autosaved and never show a dot?
5. `Shift+Mod+S` — "save all" across every open project, or only the active project's items?
