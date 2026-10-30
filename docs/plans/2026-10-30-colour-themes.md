# Colour themes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Six selectable colour themes — Field kit, Sandstone, Dusk, Seed, Pith, Rind — beside Default, each in dark and light. The
theme is a second setting (`ui.palette`) next to the mode (`ui.theme`), applied to the whole window at once and on
the first frame after launch.

**Architecture:** One pull request, eleven tasks, one commit each.

- **Tasks 1–3** add the setting and carry it to the DOM: preferences, the UI mirror, `data-palette` before first
  paint.
- **Tasks 4–6** add the colours: the contrast gate first (so every palette lands gated), then the six palettes in
  `tokens.css`, then the chrome tokens Dusk and Rind need.
- **Tasks 7–8** make the editors and terminals follow.
- **Tasks 9–10** let the user choose: Settings → Appearance cards, the command-palette picker, the status bar label.
- **Task 11** adds the e2e, the user docs and the CHANGELOG entry.

**Tech Stack:** TypeScript (ESM), React 19, Zustand, zod, Tailwind 4 (`@theme` aliases in `tailwind.css`), Monaco,
xterm.js, vitest, Playwright.

**Spec:** `docs/specs/2026-10-30-colour-themes.md` (owner rulings in its header).

## Global Constraints

- **Default does not move.** With `ui.palette` absent or `default`, `<html>` has no `data-palette`, and every
  computed colour is what it is on main today. Task 6's comparison and Task 11's e2e both check it.
- **Colours live in `tokens.css` only.** Monaco palettes (Task 7) are the one other place, and they already are today;
  a unit test keeps them equal to the CSS values.
- **The contrast gate decides values.** A spec value that fails `pnpm contrast:check` is changed in `tokens.css` (and
  Monaco) and the spec table is updated in the same commit; the gate is never loosened.
- **No preferences format bump.** `ui.palette` is optional on read and filled by `mergePreferences`, so an old file
  loads as `default`. An older app opening a newer file must not fail: check the zod `ui` object is not `.strict()`
  (Task 1); if it is, stop and ask.
- **The UI mirror version bumps** (`UI_STORAGE_VERSION` 4 → 5), reading a version-4 blob as `palette: 'default'`.
- **Gates:** `WIREBENCH_SKIP_PERF=1 pnpm check` before every commit; `pnpm test:perf` before the push. e2e runs
  headless (`pnpm build && xvfb-run -a pnpm test:e2e`, or CI) — no local Electron windows.
- **Wording:** user-facing copy says "colour theme" and "mode"; never name a product that inspired a theme
  (`pnpm check:banned-terms`).

## Review Focus

- Cascade order in `tokens.css`: a palette's light block restates every token its dark block sets (spec §4).
- First paint: `data-palette` is set in `applyInitialTheme`, before `createRoot`.
- Escape in the picker restores the palette that was active, including after several previews.
- Accent vs danger (spec §3.8): pinker danger in Field kit and Dusk, amber danger and yellow warning in Seed, Pith
  and Rind; every danger surface carries an icon or a word.

---

### Task 1: `ui.palette` in preferences

**Files:**

- Modify: `packages/core/src/project/preferences.ts` (type at ~182, defaults at ~367, zod at ~577),
  `packages/wire/src/wire-base.ts` (~2048), `apps/desktop/src/renderer/state/preferences-defaults.ts`
- Test: `packages/core/test/unit/project/preferences*.test.ts`, `apps/desktop/test/preferences-defaults.test.ts`

**Interfaces:**

- `export const PALETTES = ['default', 'field-kit', 'sandstone', 'dusk', 'seed', 'pith', 'rind'] as const;`
  `export type Palette = (typeof PALETTES)[number];` — exported from `@wirebench/wire/wire-base` so core, main and
  renderer share one list.
- `ui.palette: Palette` in the preferences type, default `'default'`; `z.enum(PALETTES).optional()` on read.

- [ ] Write failing tests: a document without `palette` merges to `'default'`; `'sandstone'` round-trips through
      save and load; an unknown value (`'neon'`) falls back to `'default'` the way an unknown `theme` does today.
- [ ] Confirm the read schema's `ui` object accepts unknown keys (forward compatibility, see constraints).
- [ ] Add the field, the defaults and the wire enum.
- [ ] If the preferences JSON schema is published (`pnpm schemas:project`), run `tsc -b` first, then regenerate it.
- [ ] Run `pnpm check`, commit.

### Task 2: the UI mirror carries the palette

**Files:**

- Modify: `apps/desktop/src/renderer/state/ui-state.ts` (`ThemePreference` ~82, state ~144, defaults ~180,
  `readUi` ~429, `UI_STORAGE_VERSION` ~170), `apps/desktop/src/renderer/state/ui.ts` (the mirror from preferences)
- Test: `apps/desktop/test/renderer/ui-state*.test.ts`

**Interfaces:**

- `UiState.palette: Palette`; `UI_STORAGE_VERSION = 5`; `readUi` reads a version-4 blob with `palette: 'default'`.
- The ui store mirrors `preferences.ui.palette` the same way it mirrors `ui.theme`.

- [ ] Write failing tests: a version-4 blob reads `default`; a version-5 blob with `dusk` reads `dusk`; a bad value
      reads `default`; a preferences update to `sandstone` reaches the ui store.
- [ ] Implement.
- [ ] Run `pnpm check`, commit.

### Task 3: `data-palette` on the document

**Files:**

- Modify: `apps/desktop/src/renderer/lib/theme.ts`, the root component that calls `useTheme`
- Test: `apps/desktop/test/renderer/theme.test.tsx`

**Interfaces:**

- `applyPalette(palette: Palette): void` — sets `document.documentElement.dataset.palette`, or deletes it for
  `default`.
- `applyInitialTheme(preference?, palette = readUi().palette)` also applies the palette, before React mounts.
- `useTheme(preference, palette)` keeps both attributes in step.
- `usePalette(): Palette` reads the ui store.

- [ ] Write failing tests: `applyInitialTheme` with a stored `sandstone` sets `data-palette="sandstone"`;
      `default` leaves no attribute; switching from `dusk` to `default` removes it; the mode still resolves as
      before.
- [ ] Implement.
- [ ] Run `pnpm check`, commit.

### Task 4: the contrast gate checks every palette

**Files:**

- Modify: `scripts/contrast-check.ts`, `scripts/contrast-check.test.ts`

**Interfaces:**

- The theme loop becomes palette × mode: for each palette, resolve the cascade the browser applies — `:root`, then
  `[data-theme='light']` in light, then `[data-palette='p']`, then `[data-palette='p'][data-theme='light']` in light.
- A missing palette block is not an error yet (palettes land in Task 5); a palette whose light block lacks a token its
  dark block sets is an error ("leaks dark value into light").
- Output names the palette: `sandstone/light: --wb-fg-subtle on --wb-bg-raised 4.1:1 < 4.5`.

- [ ] Write failing tests over a small inline CSS fixture: cascade resolution per palette and mode; the leak check;
      the failure message format.
- [ ] Implement. `pnpm contrast:check` still passes on today's `tokens.css` (Default only).
- [ ] Run `pnpm check`, commit.

### Task 5: the six palettes in `tokens.css`

**Files:**

- Modify: `apps/desktop/src/renderer/styles/tokens.css`, `docs/specs/2026-10-30-colour-themes.md` (only if the gate
  moves a value)
- Test: `scripts/contrast-check.test.ts` (which palettes exist)

- [ ] Add `[data-palette='field-kit']`, `[data-palette='field-kit'][data-theme='light']` and the same for
      `sandstone`, `dusk`, `seed`, `pith` and `rind`, with spec §3.1–§3.6's values, Dusk and Rind without their
      chrome tokens (Task 6).
- [ ] Apply spec §3.8: pinker `--wb-status-danger` in Field kit and Dusk; amber danger and yellow warning in Seed,
      Pith and Rind (already in their tables). Grep danger surfaces (`status-danger`,
      `text-danger`, `bg-danger`) and list any that show colour only; add an icon or word to each, or note in the PR
      that there are none.
- [ ] Run `pnpm contrast:check`; fix failing values in `tokens.css`, and update the spec tables to match.
- [ ] Extend the header comment in `tokens.css` to say palettes exist and how the blocks cascade.
- [ ] Run `pnpm check`, commit.

### Task 6: chrome tokens, Dusk's violet chrome and Rind's maroon chrome

**Files:**

- Modify: `apps/desktop/src/renderer/styles/tokens.css`, `apps/desktop/src/renderer/styles/tailwind.css`,
  `apps/desktop/src/renderer/shell/activity-bar.tsx`, `shell/sidebar.tsx`, `shell/title-bar.tsx`,
  `scripts/contrast-check.ts`
- Test: `apps/desktop/test/renderer/shell/*.test.tsx` (class names), `scripts/contrast-check.test.ts`

**Interfaces:**

- `--wb-bg-chrome`, `--wb-bg-chrome-selected`, `--wb-fg-chrome`, `--wb-fg-chrome-muted` in `:root` and
  `[data-theme='light']`, aliased to the tokens those three elements use today (the activity bar is
  `bg-surface-sunken`), so Default renders identically.
- Tailwind aliases `bg-surface-chrome`, `bg-surface-chrome-selected`, `text-chrome`, `text-chrome-muted`.
- Dusk's and Rind's blocks set real values (spec §3.3, §3.6).
- Contrast pairs: chrome fg and muted on chrome bg; chrome fg on chrome-selected (text); focus ring on chrome (ui).

- [ ] Write a failing test that the activity bar, sidebar and title bar use the chrome classes.
- [ ] Record the tokens each of the three elements paints today, and alias the chrome tokens to exactly those, so
      Default is unchanged in dark and light.
- [ ] Add the Dusk and Rind values and the contrast pairs; `pnpm contrast:check` passes.
- [ ] Run `pnpm check`, commit.

### Task 7: Monaco follows the palette

**Files:**

- Modify: `apps/desktop/src/renderer/editor/themes.ts`, `editor/monaco.ts`, `editor/code-editor.tsx`,
  `editor/diff-xml-editor.tsx`
- Test: `apps/desktop/test/renderer/editor/themes.test.ts`

**Interfaces:**

- `MONACO_THEMES` becomes `Record<Palette, Record<'dark' | 'light', string>>`, names `wirebench-<palette>-<mode>`
  (Default keeps `wirebench-dark` / `wirebench-light`).
- `THEME_DEFINITIONS` holds all fourteen, built with the existing `buildTheme` from one palette record each.
- `monacoThemeName(mode, palette)`.

- [ ] Write failing tests: fourteen names, all distinct; Default's names unchanged; each palette record's `bgBase`,
      `fgDefault` and `accent` equal the values in `tokens.css` for that palette and mode (parse with the contrast
      script's `parseBlock`).
- [ ] Implement; both editors pass `usePalette()`.
- [ ] Run `pnpm check`, commit.

### Task 8: terminals follow the palette

**Files:**

- Modify: `apps/desktop/src/renderer/features/ssh/terminal-tab.tsx` (~626),
  `features/ssh/local-terminal-tab.tsx` (~176)
- Test: the two tabs' existing tests

- [ ] Write a failing test: with the terminal following the app theme, changing `data-palette` alone restyles it.
- [ ] Add `'data-palette'` to both observers' `attributeFilter`.
- [ ] Run `pnpm check`, commit.

### Task 9: Settings → Appearance theme cards

**Files:**

- Create: `apps/desktop/src/renderer/features/preferences/components/palette-cards.tsx`
- Modify: `features/preferences/sections/appearance-section.tsx`, `apps/desktop/src/renderer/lib/theme.ts`
  (`PALETTE_LABEL`)
- Test: `apps/desktop/test/renderer/features/preferences/appearance-section.test.tsx`

**Interfaces:**

- `PALETTE_LABEL: Record<Palette, string>` — Default, Field kit, Sandstone, Dusk, Seed, Pith, Rind.
- `PaletteCards({ value, onChange })`: a `radiogroup` of seven cards in a wrapping grid; arrow keys move; each card is a `radio` with the
  name and five swatch dots. The swatches are painted by `var(--wb-…)` inside a wrapper carrying that card's
  `data-palette` (and the current `data-theme`), so they come from `tokens.css` and follow the current mode.
  `data-testid="preferences-palette-<id>"`.
- The section's Theme group: "Colour theme" (`setting="ui.palette"`, the cards) above "Mode" (the existing enum,
  relabelled; `setting="ui.theme"` unchanged).

- [ ] Write failing tests: seven radios with the right names; the current one `aria-checked`; clicking Sandstone calls
      `update({ ui: { palette: 'sandstone' } })`; arrow keys move selection; the settings search finds "colour
      theme".
- [ ] Implement with the existing settings-grid styling; no new colours.
- [ ] Run `pnpm check`, commit.

### Task 10: the command-palette picker and the status bar label

**Files:**

- Modify: `packages/wire/src/commands.ts`, `packages/wire/src/command-catalog.ts`,
  `apps/desktop/src/renderer/commands/register-view-commands.ts`, `shell/command-palette.tsx` (a `palette` mode),
  `lib/theme-actions.ts`, `shell/status-bar.tsx`
- Test: `apps/desktop/test/renderer/shell/command-palette*.test.tsx`, `status-bar*.test.tsx`

**Interfaces:**

- Command `view.choosePalette`, title "Theme: choose colour theme…", no default shortcut.
- `PaletteMode` gains `'palette'`: seven entries, the current one marked. Moving the highlight calls
  `applyPalette(id)` (preview only, no write); Enter calls `choosePalette(id)` (writes preferences); closing without
  Enter re-applies the stored palette.
- `choosePalette(palette)` in `theme-actions.ts`, beside `cycleTheme`.
- Status bar title and `aria-label`: "Theme: Sandstone · Dark. Cycle mode"; Default shows the mode alone, as today.

- [ ] Write failing tests: the command opens the picker; arrowing to Dusk sets `data-palette="dusk"` without
      writing preferences; Escape after two previews restores the original; Enter writes; the status bar label.
- [ ] Implement.
- [ ] Regenerate the commands reference (`pnpm docs:commands`, which writes
      `docs-site/src/content/docs/reference/commands.md`); `pnpm check` runs it with `--check`.
- [ ] Run `pnpm check`, commit.

### Task 11: e2e, docs, CHANGELOG

**Files:**

- Modify: `e2e/specs/preferences.spec.ts`, `docs-site/src/content/docs/guides/preferences.mdx`,
  `CHANGELOG.md` (`[Unreleased]` → Added)
- Test: the e2e itself

- [ ] e2e: open Settings → Appearance, pick Sandstone and Light; `<html>` has `data-palette="sandstone"` and
      `data-theme="light"`, and `body`'s background is Sandstone light's `--wb-bg-base`; relaunch, and the same
      holds on the first check after the window shows; switch mode from the status bar and Monaco's theme name
      follows; pick Default and `data-palette` is gone.
- [ ] Docs: a short "Colour themes" section — the seven themes, mode is separate, the picker command.
- [ ] CHANGELOG: one Added line.
- [ ] `pnpm build && xvfb-run -a pnpm test:e2e -- preferences` headless, or leave to CI.
- [ ] Run `pnpm check` and `pnpm test:perf`, commit, push, open the PR.
