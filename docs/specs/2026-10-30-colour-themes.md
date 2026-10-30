# Wirebench: colour themes — design

Date: 2026-10-30 · Status: approved · Branch: not started.

- Builds on: the dark/light/system theme (`renderer/lib/theme.ts`, `<html data-theme>`), the
  design tokens (`renderer/styles/tokens.css`), the Monaco themes (`renderer/editor/themes.ts`),
  Settings → Appearance (`features/preferences/sections/appearance-section.tsx`) and the token
  contrast gate (`scripts/contrast-check.ts`).
- Source palette: five colours sampled from a grasshopper photo — slate violet `#5A5A8D`, burnt
  orange-red `#B53D1D`, mid brown `#684A36`, sand `#B5947E`, espresso `#452C24`.
- Previewed on 2026-10-30 as three directions — Field kit, Sandstone, Dusk — each in light and dark.
- Owner rulings (2026-10-30, one popup):
  1. **Default stays the default** for new installs; the three themes are opt-in.
  2. **The palette is stored in the preferences document**, beside the mode.
  3. **Dusk keeps its violet chrome**, with the four chrome tokens.
  4. **Names stay**: Field kit, Sandstone, Dusk.

## 1. Objective

Wirebench has one look: a warm near-black ramp with a single terracotta accent, in dark or light.
People who sit in the app all day want to pick a look they like. This change adds **three colour
themes** next to today's, each with a light and a dark mode, chosen in Settings or the command
palette and applied at once without a restart.

Success means:

- A user can pick Default, Field kit, Sandstone or Dusk, and separately Dark, Light or System.
- The whole window follows: chrome, editors (Monaco), terminals, method badges, status colours.
- The first frame after launch already has the chosen theme (no flash of Default).
- Every theme × mode passes the same contrast gate today's two palettes pass.

## 2. Model: two independent choices

Today `ui.theme` is a **mode**: `dark | light | system`. Themes add a second axis, the **palette**.
They stay separate so `system` keeps following the OS for every palette.

| Setting      | Values                                      | Default   |
| ------------ | ------------------------------------------- | --------- |
| `ui.theme`   | `dark`, `light`, `system` (unchanged)       | `dark`    |
| `ui.palette` | `default`, `field-kit`, `sandstone`, `dusk` | `default` |

The DOM carries both: `<html data-theme="dark" data-palette="sandstone">`. `default` sets no
`data-palette` attribute, so today's CSS keeps working untouched.

## 3. The three palettes

Each palette gives every colour token in `tokens.css` a value in both modes. Spacing, radius, type,
geometry and layers are not palette tokens and never change. The values below are the starting
point from the preview; the contrast gate (§7) has the final word, and a value it rejects is
adjusted, not the gate.

### 3.1 Field kit — espresso and orange

Dark is the native mode: warm brown surfaces, the orange-red as the one accent, violet for method
tags and keys. Light mode is a pale sand canvas that keeps the orange accent.

| Token                 | Dark      | Light     |
| --------------------- | --------- | --------- |
| `--wb-bg-sunken`      | `#1F1511` | `#EFE4D9` |
| `--wb-bg-base`        | `#2A1C17` | `#F7F0E8` |
| `--wb-bg-raised`      | `#452C24` | `#FFFBF7` |
| `--wb-bg-overlay`     | `#4E332A` | `#FFFFFF` |
| `--wb-bg-hover`       | `#563A2E` | `#EDE1D5` |
| `--wb-bg-active`      | `#684A36` | `#E2D2C3` |
| `--wb-bg-selected`    | `#5A2C1C` | `#F6DCD0` |
| `--wb-fg-default`     | `#F1E6DC` | `#452C24` |
| `--wb-fg-muted`       | `#CDB6A4` | `#684A36` |
| `--wb-fg-subtle`      | `#B5947E` | `#7A5C48` |
| `--wb-border-default` | `#4A3329` | `#E2D2C3` |
| `--wb-accent-default` | `#D2552F` | `#B53D1D` |
| `--wb-accent-hover`   | `#E06A44` | `#962F14` |
| `--wb-accent-surface` | `#3A1C12` | `#FBE9E1` |
| `--wb-fg-on-accent`   | `#FFF4EE` | `#FFFFFF` |
| `--wb-status-info`    | `#A9A9D6` | `#5A5A8D` |

### 3.2 Sandstone — tan and violet

Light is the native mode: tan surfaces, espresso text, violet as the accent. The orange-red is kept
for errors and warnings, so the loudest colour only appears when something needs attention. Dark
mode is a warm charcoal with the violet and orange lifted to stay readable.

| Token                 | Dark      | Light     |
| --------------------- | --------- | --------- |
| `--wb-bg-sunken`      | `#161210` | `#EFE3D8` |
| `--wb-bg-base`        | `#1C1714` | `#FBF7F3` |
| `--wb-bg-raised`      | `#2A221D` | `#FFFFFF` |
| `--wb-bg-overlay`     | `#2F2621` | `#FFFFFF` |
| `--wb-bg-hover`       | `#332A24` | `#F2E8DF` |
| `--wb-bg-active`      | `#3D322A` | `#E0CCBB` |
| `--wb-bg-selected`    | `#2E2B45` | `#E4E4F2` |
| `--wb-fg-default`     | `#EFE3D8` | `#452C24` |
| `--wb-fg-muted`       | `#C9B3A2` | `#684A36` |
| `--wb-fg-subtle`      | `#B5947E` | `#7A5C48` |
| `--wb-border-default` | `#3D322A` | `#DCC8B8` |
| `--wb-accent-default` | `#8A8AC4` | `#5A5A8D` |
| `--wb-accent-hover`   | `#A0A0D4` | `#47476F` |
| `--wb-accent-surface` | `#26253A` | `#ECECF6` |
| `--wb-fg-on-accent`   | `#14131F` | `#FFFFFF` |
| `--wb-status-danger`  | `#E58A68` | `#B53D1D` |
| `--wb-status-warning` | `#D9A86A` | `#8E5A14` |

### 3.3 Dusk — violet chrome, orange action

The chrome (activity bar, sidebar, title bar) is violet; the work area is a neutral light or dark
canvas; the orange-red is the accent. This is the most branded of the three because violet is
always on screen.

It needs tokens the others do not: a **chrome surface** for the activity bar, sidebar and title
bar. Today those use `--wb-bg-sunken`/`--wb-bg-raised`. This change adds `--wb-bg-chrome`,
`--wb-bg-chrome-selected`, `--wb-fg-chrome` and `--wb-fg-chrome-muted`, aliased to the existing
values in every other palette so nothing else moves.

| Token                     | Dark      | Light     |
| ------------------------- | --------- | --------- |
| `--wb-bg-chrome`          | `#26263D` | `#3D3D63` |
| `--wb-bg-chrome-selected` | `#5A5A8D` | `#5A5A8D` |
| `--wb-fg-chrome`          | `#E1E0F2` | `#E6E5F3` |
| `--wb-fg-chrome-muted`    | `#A9A8CC` | `#A9A8CC` |
| `--wb-bg-sunken`          | `#141218` | `#EFE8E0` |
| `--wb-bg-base`            | `#1A1820` | `#F7F4F0` |
| `--wb-bg-raised`          | `#24212A` | `#FFFFFF` |
| `--wb-bg-overlay`         | `#2A2731` | `#FFFFFF` |
| `--wb-bg-hover`           | `#2C2833` | `#EFE8E0` |
| `--wb-bg-active`          | `#34303C` | `#E2D9CF` |
| `--wb-bg-selected`        | `#3A2E26` | `#EADFD4` |
| `--wb-fg-default`         | `#ECE6E0` | `#452C24` |
| `--wb-fg-muted`           | `#C9BDB2` | `#684A36` |
| `--wb-border-default`     | `#34303C` | `#E2D9CF` |
| `--wb-accent-default`     | `#D2552F` | `#B53D1D` |
| `--wb-accent-hover`       | `#E06A44` | `#962F14` |
| `--wb-accent-surface`     | `#3A1C12` | `#FBE9E1` |
| `--wb-fg-on-accent`       | `#FFFFFF` | `#FFFFFF` |

### 3.4 Tokens a palette does not list

A token not in a palette's table keeps the value it has for that mode in Default. That covers the
method badges, environment colours, success/info where unlisted, `--wb-fg-faint`,
`--wb-border-strong`, `--wb-accent-muted` and the overlay shadow. Implementation may restate any of
them per palette if the contrast gate or a visual check calls for it.

### 3.5 Accent next to danger

In Field kit and Dusk the accent is an orange-red, close to the danger red. Danger must stay
recognisable without colour alone: danger states already carry an icon or a word (`500`, "Failed",
the Problems count). This change checks every danger surface does, and in those two palettes moves
`--wb-status-danger` towards a pinker red (`#E0685F` dark / `#B02A3A` light) so the two do not read
as the same colour side by side.

## 4. CSS structure

`tokens.css` keeps its two blocks and gains two blocks per palette:

```css
:root { /* Default dark, unchanged */ }
[data-theme='light'] { /* Default light, unchanged */ }

[data-palette='field-kit'] { /* Field kit dark */ }
[data-palette='field-kit'][data-theme='light'] { /* Field kit light */ }
/* … sandstone, dusk the same way */
```

`[data-palette='x'][data-theme='light']` outranks `[data-theme='light']` by specificity, so a
palette's light block wins over Default light. A palette's **dark** block has the same specificity
as `[data-theme='light']` but only applies in dark mode, where that block is absent, so it wins
over `:root`. A palette's light block must restate every token its dark block sets, otherwise the
dark value leaks into light mode (`[data-palette='x']` still matches in light); the contrast gate
parses blocks the way the browser cascades them and catches a leak.

The "nothing outside this file may hard-code a colour" rule stays.

## 5. Where the theme is read

| Place                       | Change                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `wire-base.ts` preferences  | `ui.palette: z.enum([...])`, optional on read, defaulted by the merge in `core/project/preferences.ts`. |
| `ui-state.ts`               | The local mirror stores `palette` beside `theme` so the first paint knows it. Bump `UI_STORAGE_VERSION`; an older blob reads as `default`. |
| `lib/theme.ts`              | `applyInitialTheme` and `useTheme` also set `data-palette`; a `usePalette()` hook for code that needs the name. |
| Monaco (`editor/themes.ts`) | One Monaco theme per palette × mode (`wirebench-sandstone-light`…), built by the existing `buildTheme` from that palette's colours; `monacoThemeName(mode, palette)`. |
| Terminals                   | Already restyle on a `data-theme` change; the observer also watches `data-palette`.                    |
| Status bar indicator        | Unchanged action (cycles mode). Its tooltip names the palette too: "Sandstone · Dark".                 |
| HTML reports, CLI, site     | Out of scope; they keep their own fixed palettes.                                                      |

## 6. Choosing a theme

**Settings → Appearance → Theme** becomes two settings:

- **Colour theme** — four cards in a row, each showing its name and five swatches, drawn in the
  current mode. The selected card has the accent ring. Clicking applies at once.
- **Mode** — the existing Dark / Light / System control, unchanged.

**Command palette:** a new command `view.choosePalette`, "Theme: choose colour theme…", opens a
quick pick of the four; moving through the list previews each, Escape restores the one that was
active, Enter keeps the highlighted one. `view.toggleTheme` keeps cycling the mode.

Both write through `usePreferencesStore().update({ ui: { palette } })`, like `cycleTheme`, so there
is one code path.

## 7. Testing

- **Contrast gate:** `scripts/contrast-check.ts` runs its `PAIRS` list for every palette × mode
  (8 combinations instead of 2). The chrome tokens get their own pairs (chrome text on chrome
  surface, chrome text on selected chrome). The gate stays part of `pnpm check`.
- **Unit:** theme resolution sets both attributes; an old UI blob reads `default`; preferences
  without `palette` merge to `default`; `monacoThemeName` covers all eight names.
- **Renderer:** the Appearance cards select and write the palette; the palette quick pick previews
  and restores on Escape.
- **e2e:** pick Sandstone + Light in Settings, relaunch, and check the first frame's
  `data-palette` and a sampled background colour; switch mode with the status bar and check
  Monaco's theme name follows.

## 8. Out of scope

- User-made themes or importing a theme file.
- A per-project or per-workspace theme.
- Theming the HTML reports, the CLI output or the website.
- Changing Default's colours.
