# Plan: SSH area, slice 1 (hosts and terminal)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Spec:** `docs/specs/2026-10-08-ssh-area-design.md` (issue #316). The plan argues from the spec; read both.

**Goal:** A switchable "area module" seam in the desktop app, and the first area built on it: a `hosts.yaml`
model with group inheritance, a Hosts view, and an interactive SSH terminal tab whose credentials never leave
the main process.

**Architecture:** Five pull requests, each a working app. PR 1 turns the five existing sidebar views into
`AreaModule`s composed from one list and adds the `WIREBENCH_AREAS` switch. PR 2 adds `packages/ssh` (pure
model: schema, inheritance, provenance) and the Hosts view reading and writing `hosts.yaml` through main. PR 3
adds sessions over `ssh2`, known hosts and the connect/write/resize/close channels. PR 4 adds the xterm tab,
palette and quick-open entries and the e2e. PR 5 is docs and the ADR.

**Tech Stack:** TypeScript (ESM, Node ≥ 24), Electron 44, React + zustand + immer, zod 4, vitest (root
`vitest.config.ts` projects), Playwright `_electron` e2e, `ssh2` (main only), `@xterm/xterm` +
`@xterm/addon-fit` (renderer only).

## Global constraints (from the spec and `CLAUDE.md`)

- `WIREBENCH_SKIP_PERF=1 pnpm check` green before every commit; `pnpm test:perf` before a push. e2e runs in
  CI (`pnpm build && xvfb-run -a pnpm test:e2e`), never as Electron windows on the owner's machine; local
  checks run headless under `nice`.
- Never name the product that inspired this feature anywhere; `pnpm check:banned-terms` enforces it.
- Commit messages: no `Co-Authored-By`, no `Claude-Session` trailer. Author is Mohammed Naami.
- Credentials never cross the IPC bridge: no channel or event carries a secret value, a private key or a
  passphrase. `ssh.listHosts` answers secret _names_.
- `packages/ssh` imports neither `@wirebench/engine` nor Electron; `packages/engine` never imports
  `@wirebench/ssh`.
- Every `hosts.yaml` credential is a `${secret:NAME}` token, `NAME` matching the engine's
  `SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/`. Ids match `/^[a-z0-9][a-z0-9-]*$/`. Unknown keys are
  refused (`z.strictObject`). `version` is `1`.
- A new command id needs a `COMMAND_CATALOG` entry and a handler, or `test/renderer/command-registry.test.ts`
  fails. `pnpm docs:commands` regenerates the command docs after any catalog change.
- New runtime dependencies are pinned exact; `pnpm licenses:third-party` regenerates
  `THIRD-PARTY-LICENSES.md`, which is committed.
- Spec amendments found while planning (Task 1 records them in the spec):
  - **A1.** There is no local desktop audit trail; `DesktopAuditEvent` is a strict server-bound union. S1
    records nothing to audit; a follow-up adds a `desktop.ssh_session` action with the server.
  - **A2.** The desktop discards workspace-level `WorkspaceProblem`s, so `hosts.yaml` is owned by a desktop
    `HostsService` (not `loadWorkspace`); its problems come back on `ssh.listHosts` and show in the Hosts
    view and the Problems tab under a new `'hosts'` source.
  - **A3.** The host form is a Radix dialog (the `SecretSourcesDialog` pattern), not the Code slide-over.
  - **A4.** `scripts/engine-import-graph.mjs` scans only `packages/engine/src`; the layer rule for
    `packages/ssh` is a test in `scripts/engine-layers.test.ts`.

## File structure

| Path                                                                   | Responsibility                                                    |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `apps/desktop/src/shared/area-module.ts`                               | `AreaModule` contract, `AreaId`, `AREAS`, `enabledAreaIds()`      |
| `apps/desktop/src/shared/areas/{explorer,environments,search,history,wss,ssh}.ts` | One shared half per area (id, feature, rail, copy)     |
| `apps/desktop/src/renderer/areas/index.ts`                             | `AreaId → { View, registerCommands }` plus the icon map           |
| `apps/desktop/src/main/areas.ts`                                       | Parses `WIREBENCH_AREAS`, registers main halves of enabled areas  |
| `apps/desktop/src/main/areas/ssh.ts`                                   | Main half of the ssh area: its channels                            |
| `apps/desktop/src/main/hosts-service.ts`                               | Reads/writes `<tree>/hosts.yaml`, caches the parsed model          |
| `apps/desktop/src/main/ssh-service.ts`                                 | Sessions, ownership, known-hosts file, secrets resolved at connect |
| `apps/desktop/src/shared/ssh-wire.ts`                                  | zod wire schemas shared by `ipc.ts` and the renderer               |
| `packages/ssh/src/{index,errors,model,resolve,known-hosts,session}.ts` | Pure model + ssh2 session; no Electron, no engine                  |
| `packages/ssh/test/helpers/ssh-fixture.ts`                             | In-process ssh2 server for tests (also exported for e2e)           |
| `apps/desktop/src/renderer/features/ssh/*`                             | Hosts store/view/dialog, trust prompt, terminal tab, paste guard   |
| `e2e/specs/ssh-terminal.spec.ts`                                       | End-to-end proof                                                   |

---

## PR 1 — Area seam

### Task 1: Record the spec amendments

**Files:**

- Modify: `docs/specs/2026-10-08-ssh-area-design.md` (insert before `## Docs`)

- [ ] **Step 1: Insert the amendments**

```markdown
## Amendments (2026-10-08, with the plan)

- **A1. No audit entries in S1.** The desktop has no local activity log; `DesktopAuditEvent`
  (`packages/engine/src/server-api/audit.ts`) is a strict union the server validates. A `desktop.ssh_session`
  action is a follow-up with the server. D4 step 4 and the audit success criterion move to it.
- **A2. `hosts.yaml` is owned by the desktop's `HostsService`.** `loadWorkspace` is untouched; the service
  reads and writes `<tree>/hosts.yaml` with `writeFileAtomic`. Parse problems come back on `ssh.listHosts`
  and show in the Hosts view and the Problems tab (source `hosts`).
- **A3. The host form is a dialog** (`@radix-ui/react-dialog`, as `SecretSourcesDialog`), not the slide-over.
- **A4. The layer rule is a test.** `scripts/engine-layers.test.ts` checks that nothing under
  `packages/engine/src` imports `@wirebench/ssh`, and nothing under `packages/ssh/src` imports
  `@wirebench/engine` or `electron`.
```

- [ ] **Step 2: Format and commit**

```bash
npx prettier --write docs/specs/2026-10-08-ssh-area-design.md && nice pnpm check:docs
git add docs/specs/2026-10-08-ssh-area-design.md
git commit -m "docs: amend the SSH area design with what the plan found"
```

### Task 2: The `AreaModule` contract and the five existing areas (shared halves)

**Files:**

- Create: `apps/desktop/src/shared/area-module.ts`
- Create: `apps/desktop/src/shared/areas/explorer.ts`, `environments.ts`, `search.ts`, `history.ts`, `wss.ts`
- Test: `apps/desktop/test/renderer/area-module.test.ts`

**Interfaces:**

- Produces: `AreaModule`, `AreaId`, `AREAS`, `areaById(id)`, `enabledAreaIds(switches)`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/renderer/area-module.test.ts
import { describe, expect, it } from 'vitest';
import { AREAS, areaById, enabledAreaIds } from '../../src/shared/area-module.js';

describe('area modules', () => {
  it('lists the five existing areas in rail order', () => {
    expect(AREAS.map((area) => area.id)).toEqual(['explorer', 'environments', 'search', 'history', 'wss']);
    const orders = AREAS.map((area) => area.rail.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it('every area has a title, a rail label and a show command', () => {
    for (const area of AREAS) {
      expect(area.feature.id).toBe(area.id);
      expect(area.copy.title.length).toBeGreaterThan(0);
      expect(area.rail.command.startsWith('view.show')).toBe(true);
    }
  });

  it('a switch turns an area off; unknown switches are ignored', () => {
    expect(enabledAreaIds({ wss: false })).toEqual(['explorer', 'environments', 'search', 'history']);
    expect(enabledAreaIds({ nope: false })).toEqual(AREAS.map((a) => a.id));
    expect(enabledAreaIds({})).toEqual(AREAS.map((a) => a.id));
  });

  it('areaById finds an area and rejects an unknown id', () => {
    expect(areaById('history').rail.label).toBe('History');
    expect(() => areaById('nope' as never)).toThrow(/unknown area/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/area-module.test.ts`
Expected: FAIL — cannot resolve `../../src/shared/area-module.js`.

- [ ] **Step 3: Write the contract and the five halves**

```ts
// apps/desktop/src/shared/area-module.ts
import { createFeatureSet } from '@wirebench/engine';
import type { FeatureDescriptor } from '@wirebench/engine';
import type { CommandId } from './commands.js';
import { explorerArea } from './areas/explorer.js';
import { environmentsArea } from './areas/environments.js';
import { searchArea } from './areas/search.js';
import { historyArea } from './areas/history.js';
import { wssArea } from './areas/wss.js';

/** The words the sidebar header and empty state show. Was `VIEWS` in `shell/sidebar.tsx`. */
export interface AreaCopy {
  readonly title: string;
  readonly headline: string;
  readonly body: string;
}

/**
 * One desktop area: a rail item, a sidebar view, commands and (optionally) IPC channels. This half is
 * process-neutral; the renderer and main halves are looked up by `id` (`renderer/areas/index.ts`,
 * `main/areas.ts`).
 *
 * @internal Composed statically in `AREAS`; not yet a plugin API (ADR-0017).
 */
export interface AreaModule<Id extends string = string> {
  readonly id: Id;
  /** Reused from the engine so switches and `whyDisabled()` behave the same everywhere. */
  readonly feature: FeatureDescriptor;
  readonly rail: {
    readonly label: string;
    /** Lucide icon name; the renderer maps it to the component so `shared/` stays free of React. */
    readonly icon: 'FolderTree' | 'Braces' | 'Search' | 'History' | 'ShieldCheck' | 'TerminalSquare';
    /** The command that shows the view; its shortcut labels the rail item. */
    readonly command: CommandId;
    readonly order: number;
    readonly testId?: string;
  };
  readonly copy: AreaCopy;
}

export const AREAS = [explorerArea, environmentsArea, searchArea, historyArea, wssArea] as const;

export type AreaId = (typeof AREAS)[number]['id'];

export function areaById(id: AreaId): AreaModule<AreaId> {
  const area = AREAS.find((candidate) => candidate.id === id);
  if (!area) throw new Error(`unknown area: ${String(id)}`);
  return area;
}

/** The ids left on after `switches` (`{ ssh: false }`) are applied, in rail order. */
export function enabledAreaIds(switches: Readonly<Record<string, boolean>>): readonly AreaId[] {
  const features = createFeatureSet(
    AREAS.map((area) => area.feature),
    switches,
  );
  return AREAS.filter((area) => features.isEnabled(area.id)).map((area) => area.id);
}
```

One file per area. Copy each `VIEWS` entry from `apps/desktop/src/renderer/shell/sidebar.tsx:17-43` into
`copy` verbatim; rail values come from `activity-bar.tsx:18-30`. Orders: explorer 10, environments 20,
search 30, history 40, wss 50. `environments` keeps `testId: 'activity-environments'`.

```ts
// apps/desktop/src/shared/areas/history.ts (the other four have the same shape)
import type { AreaModule } from '../area-module.js';

export const historyArea = {
  id: 'history',
  feature: { id: 'history', title: 'History', default: true, stage: 'stable', requires: [] },
  rail: { label: 'History', icon: 'History', command: 'view.showHistory', order: 40 },
  copy: { title: 'History', headline: '<VIEWS.history.headline>', body: '<VIEWS.history.body>' },
} as const satisfies AreaModule<'history'>;
```

- [ ] **Step 4: Run the test**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/area-module.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/area-module.ts apps/desktop/src/shared/areas apps/desktop/test/renderer/area-module.test.ts
git commit -m "desktop: describe each sidebar area as an AreaModule"
```

### Task 3: The shell composes from `AREAS`

**Files:**

- Create: `apps/desktop/src/renderer/areas/index.ts`
- Modify: `apps/desktop/src/renderer/shell/activity-bar.tsx` (delete `ActivityItem`/`ITEMS`),
  `apps/desktop/src/renderer/shell/sidebar.tsx` (delete `VIEWS` and the ternary chain),
  `apps/desktop/src/renderer/state/ui-state.ts:2` and `:208`
- Test: `apps/desktop/test/renderer/sidebar-areas.test.tsx`

**Interfaces:**

- Consumes: `AREAS`, `AreaId`, `areaById` (Task 2).
- Produces: `RENDERER_AREAS: Readonly<Record<AreaId, RendererArea>>` with
  `RendererArea = { readonly View: ComponentType; readonly registerCommands?: () => void }`, and
  `AREA_ICONS: Readonly<Record<AreaModule['rail']['icon'], LucideIcon>>`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/test/renderer/sidebar-areas.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AREAS } from '../../src/shared/area-module.js';
import { RENDERER_AREAS } from '../../src/renderer/areas/index.js';

vi.mock('../../src/renderer/features/explorer/explorer-view.js', () => ({ ExplorerView: () => <p>explorer-view</p> }));

describe('renderer areas', () => {
  it('has a renderer half for every shared area', () => {
    for (const area of AREAS) expect(RENDERER_AREAS[area.id].View).toBeTypeOf('function');
  });

  it('renders the explorer view for the explorer area', () => {
    const View = RENDERER_AREAS.explorer.View;
    render(<View />);
    expect(screen.getByText('explorer-view')).toBeInTheDocument();
  });
});
```

Use the import path `sidebar.tsx` really uses for `ExplorerView` in the `vi.mock` (read its imports).

- [ ] **Step 2: Run it to see it fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/sidebar-areas.test.tsx`
Expected: FAIL — cannot resolve `renderer/areas/index.js`.

- [ ] **Step 3: Write the map and rewire the shell**

```ts
// apps/desktop/src/renderer/areas/index.ts
import type { ComponentType } from 'react';
import { Braces, FolderTree, History, Search, ShieldCheck, TerminalSquare } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AreaId, AreaModule } from '../../shared/area-module.js';
// copy the five view imports from shell/sidebar.tsx verbatim

export interface RendererArea {
  readonly View: ComponentType;
  /** Commands the area owns beyond `view.show*`; called by `registerShellCommands` for enabled areas. */
  readonly registerCommands?: () => void;
}

export const AREA_ICONS: Readonly<Record<AreaModule['rail']['icon'], LucideIcon>> = {
  FolderTree, Braces, Search, History, ShieldCheck, TerminalSquare,
};

export const RENDERER_AREAS: Readonly<Record<AreaId, RendererArea>> = {
  explorer: { View: ExplorerView },
  environments: { View: EnvironmentsView },
  search: { View: SearchView },
  history: { View: HistoryView },
  wss: { View: WssSection },
};
```

`ui-state.ts`:

```ts
import { AREAS } from '../../shared/area-module.js';
import type { AreaId } from '../../shared/area-module.js';
export type SidebarView = AreaId;                                   // replaces line 2
const SIDEBAR_VIEWS: readonly SidebarView[] = AREAS.map((area) => area.id); // replaces line 208
```

`activity-bar.tsx`: keep the existing button markup; replace the `ITEMS.map` with

```tsx
{AREAS.map((area) => (
  <ActivityButton
    key={area.id}
    label={area.rail.label}
    icon={AREA_ICONS[area.rail.icon]}
    shortcut={shortcutFor(area.rail.command, platform)}
    active={sidebar.visible && sidebar.view === area.id}
    onClick={() => showSidebarView(area.id)}
    testId={area.rail.testId}
  />
))}
```

(`ActivityButton` is whatever the file's per-item element is called; if items are inline JSX, keep them
inline.) Task 4 filters this list by the enabled set.

`sidebar.tsx`: replace `VIEWS` and the chain with

```tsx
const area = areaById(view);
const View = RENDERER_AREAS[view].View;
// header shows area.copy.title; body renders <View />. The empty-state branch that showed copy.headline/body is gone:
// every view renders a component.
```

- [ ] **Step 4: Run tests and typecheck**

Run: `nice pnpm vitest run --project desktop && nice pnpm --filter @wirebench/desktop typecheck`
Expected: PASS; `Record<SidebarView, …>` maps elsewhere still compile because the union's members are
unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/areas apps/desktop/src/renderer/shell apps/desktop/src/renderer/state/ui-state.ts apps/desktop/test/renderer/sidebar-areas.test.tsx
git commit -m "desktop: compose the activity bar and sidebar from AREAS"
```

### Task 4: The switch: `WIREBENCH_AREAS`, `app.areas`, and the renderer honours it

**Files:**

- Create: `apps/desktop/src/main/areas.ts`
- Modify: `apps/desktop/src/shared/ipc.ts` (`app` group gains `areas`), `apps/desktop/src/main/ipc/app.ts`,
  `apps/desktop/src/main/index.ts` (compute `enabledAreas`, pass to `registerAppChannels`),
  `apps/desktop/src/renderer/state/ui-state.ts` + `ui.ts` (`enabledAreas`, `setEnabledAreas`),
  `apps/desktop/src/renderer/shell/app-shell.tsx`, `apps/desktop/src/renderer/shell/activity-bar.tsx`,
  `apps/desktop/src/renderer/commands/register-shell-commands.ts`
- Test: `apps/desktop/test/areas-switch.test.ts`; extend `apps/desktop/test/ipc-app.test.ts`

**Interfaces:**

- Produces: `parseAreaSwitches(env: string | undefined): Record<string, boolean>`,
  `enabledAreasFromEnv(env?: NodeJS.ProcessEnv): readonly AreaId[]`,
  `channels.app.areas: undefined → { enabled: string[] }`, `useUiStore().enabledAreas: readonly AreaId[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/test/areas-switch.test.ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { enabledAreasFromEnv, parseAreaSwitches } from '../src/main/areas.js';

describe('WIREBENCH_AREAS', () => {
  it('parses id=off and id=on pairs, ignoring blanks and case', () => {
    expect(parseAreaSwitches('ssh=off, wss=OFF ,history=on')).toEqual({ ssh: false, wss: false, history: true });
  });
  it('is empty when unset or malformed', () => {
    expect(parseAreaSwitches(undefined)).toEqual({});
    expect(parseAreaSwitches('ssh')).toEqual({});
    expect(parseAreaSwitches('ssh=maybe')).toEqual({});
  });
  it('enabledAreasFromEnv drops the switched-off area', () => {
    expect(enabledAreasFromEnv({ WIREBENCH_AREAS: 'wss=off' })).toEqual(['explorer', 'environments', 'search', 'history']);
  });
});
```

In `apps/desktop/test/ipc-app.test.ts`, using the file's handler-capture helpers, add:

```ts
it('app.areas answers the enabled area ids', async () => {
  registerAppChannels({ ...deps, enabledAreas: ['explorer', 'history'] });
  expect(await invoke('app.areas', undefined)).toEqual({ ok: true, value: { enabled: ['explorer', 'history'] } });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/areas-switch.test.ts apps/desktop/test/ipc-app.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/areas.ts
import { enabledAreaIds } from '../shared/area-module.js';
import type { AreaId } from '../shared/area-module.js';

/** `WIREBENCH_AREAS="ssh=off,wss=off"`. Anything that is not `<id>=on|off` is ignored. */
export function parseAreaSwitches(env: string | undefined): Record<string, boolean> {
  const switches: Record<string, boolean> = {};
  for (const pair of (env ?? '').split(',')) {
    const [id, state] = pair.split('=').map((part) => part.trim().toLowerCase());
    if (!id || (state !== 'on' && state !== 'off')) continue;
    switches[id] = state === 'on';
  }
  return switches;
}

export function enabledAreasFromEnv(env: NodeJS.ProcessEnv = process.env): readonly AreaId[] {
  return enabledAreaIds(parseAreaSwitches(env['WIREBENCH_AREAS']));
}
```

`shared/ipc.ts`, in the `app` group: `areas: defineChannel('app.areas', z.undefined(), z.object({ enabled: z.array(z.string()) })),`.
`main/ipc/app.ts`: deps gain `enabledAreas: readonly AreaId[]`; register
`registerHandler(channels.app.areas, () => Promise.resolve({ enabled: [...enabledAreas] }))`.
`main/index.ts`: `const enabledAreas = enabledAreasFromEnv();` near the other start-up state; pass it to
`registerAppChannels`.

Renderer: `UiSnapshot.enabledAreas: readonly AreaId[]` (default `AREAS.map((a) => a.id)`), store action
`setEnabledAreas(ids)`. `activity-bar.tsx` filters: `AREAS.filter((a) => enabledAreas.includes(a.id))`.
`register-shell-commands.ts`, after the existing calls:

```ts
for (const id of useUiStore.getState().enabledAreas) RENDERER_AREAS[id].registerCommands?.();
```

`app-shell.tsx`: the effect that calls `registerShellCommands(openPalette)` (line ~299) becomes

```ts
useEffect(() => {
  let cancelled = false;
  registerShellCommands(openPalette);
  void ipc().app.areas(undefined).then((result) => {
    if (cancelled || !result.ok) return;
    useUiStore.getState().setEnabledAreas(result.value.enabled as AreaId[]);
    registerShellCommands(openPalette); // resetCommands() at its top makes re-registration safe
    void syncAppMenu();
  });
  return () => { cancelled = true; };
}, [openPalette]);
```

- [ ] **Step 4: Run tests, typecheck, check**

Run: `nice pnpm vitest run --project desktop && WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: PASS. The e2e suite is unchanged; CI proves the refactor (PR 1 adds no feature).

- [ ] **Step 5: Commit and open PR 1**

```bash
git add -A apps/desktop
git commit -m "desktop: WIREBENCH_AREAS switches an area off end to end"
```

PR title: `desktop: sidebar areas are modules behind one contract (#316, 1/5)`. Body: what changed, "no
behaviour change", the switch, link to the spec. Board: #316 → **In review** when the PR opens, back to
**In progress** when PR 2 starts.

---

## PR 2 — `packages/ssh` model and the Hosts view

### Task 5: Scaffold `packages/ssh`

**Files:**

- Create: `packages/ssh/package.json`, `packages/ssh/tsconfig.json`, `packages/ssh/tsconfig.test.json`,
  `packages/ssh/src/index.ts`, `packages/ssh/README.md`
- Modify: `tsconfig.json` (references), `vitest.config.ts` (projects `ssh-unit`, `ssh-integration`),
  `scripts/third-party-licenses.ts` (`OWN_PACKAGES` line 61 and the roots list lines 258-266),
  `scripts/engine-layers.test.ts` (A4 rule)
- Test: `scripts/engine-layers.test.ts`, `packages/ssh/test/unit/index.test.ts`

- [ ] **Step 1: Write the failing layer test**

Append to `scripts/engine-layers.test.ts` (reuse its file-walking helper if it has one; otherwise add
`listSourceFiles(dir)` with `readdirSync(dir, { recursive: true })` filtered to `.ts`):

```ts
it('the engine and packages/ssh never import each other, and ssh never imports electron', () => {
  const engineFiles = listSourceFiles('packages/engine/src');
  const sshFiles = listSourceFiles('packages/ssh/src');
  expect(sshFiles.length).toBeGreaterThan(0);
  expect(engineFiles.filter((f) => readFileSync(f, 'utf8').includes("from '@wirebench/ssh"))).toEqual([]);
  expect(sshFiles.filter((f) => /from '(@wirebench\/engine|electron)/.test(readFileSync(f, 'utf8')))).toEqual([]);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `nice pnpm vitest run --project scripts scripts/engine-layers.test.ts`
Expected: FAIL — `sshFiles.length` is 0.

- [ ] **Step 3: Create the package**

```json
{
  "name": "@wirebench/ssh",
  "version": "0.0.0",
  "private": true,
  "license": "Apache-2.0",
  "type": "module",
  "engines": { "node": ">=24" },
  "exports": {
    ".": { "development": "./src/index.ts", "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./test-helpers": { "development": "./test/helpers/index.ts", "types": "./dist-test/helpers/index.d.ts", "default": "./dist-test/helpers/index.js" }
  },
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run --root ../.. --project ssh-unit --project ssh-integration",
    "typecheck": "tsc -b"
  },
  "dependencies": { "ssh2": "<newest 1.x>", "yaml": "<engine's pin>", "zod": "<engine's pin>" },
  "devDependencies": { "@types/ssh2": "<matching>" }
}
```

Fill the pins from `npm view ssh2 version`, `npm view @types/ssh2 version` and `packages/engine/package.json`.
Copy `packages/cli/tsconfig.json` and `tsconfig.test.json`, adjusting paths; look at how the engine's
`./test-helpers` export is built (`packages/engine/package.json` + its tsconfig) and mirror it. `src/index.ts`
is `export {};` with a one-line comment until Task 6. `test/helpers/index.ts` is `export {};` until Task 10.

Root `tsconfig.json`: add `{ "path": "packages/ssh" }` and `{ "path": "packages/ssh/tsconfig.test.json" }`.
`vitest.config.ts`: add `ssh-unit` (`packages/ssh/test/unit/**/*.test.ts`) and `ssh-integration`
(`packages/ssh/test/integration/**/*.test.ts`) by copying the `cli-unit`/`cli-integration` entries.
`scripts/third-party-licenses.ts`: add `'@wirebench/ssh'` to `OWN_PACKAGES`; add `packages/ssh`
`dependencies` to the roots list in the shape of the engine entry.

```ts
// packages/ssh/test/unit/index.test.ts
import { expect, it } from 'vitest';
import * as ssh from '../../src/index.js';
it('the package loads', () => { expect(ssh).toBeDefined(); });
```

- [ ] **Step 4: Install and run**

Run: `pnpm install && nice pnpm vitest run --project scripts --project ssh-unit && nice pnpm licenses:third-party && nice pnpm typecheck`
Expected: PASS; `THIRD-PARTY-LICENSES.md` gains `ssh2` and its tree (commit it).

- [ ] **Step 5: Commit**

```bash
git add packages/ssh tsconfig.json vitest.config.ts scripts THIRD-PARTY-LICENSES.md pnpm-lock.yaml
git commit -m "ssh: scaffold packages/ssh as a leaf beside the engine"
```

### Task 6: `hosts.yaml` schema and errors

**Files:**

- Create: `packages/ssh/src/errors.ts`, `packages/ssh/src/model.ts`
- Modify: `packages/ssh/src/index.ts` (re-export both)
- Test: `packages/ssh/test/unit/model.test.ts`

**Interfaces (produces):**

```ts
export type SshErrorCode = 'ssh-duplicate-id' | 'ssh-literal-secret' | 'ssh-jump-cycle' | 'ssh-jump-unknown'
  | 'ssh-host-incomplete' | 'ssh-hosts-invalid' | 'ssh-host-key-new' | 'ssh-host-key-changed'
  | 'ssh-auth-failed' | 'ssh-connect-failed' | 'ssh-session-unknown';
export class SshModelError extends Error { readonly code: SshErrorCode; readonly details: Readonly<Record<string, unknown>> }
export type SshAuth = { kind: 'password'; password: string } | { kind: 'key'; key: string; passphrase?: string } | { kind: 'agent' };
export interface SshSettings { user?: string; port?: number; jump?: string; auth?: SshAuth; keepAlive?: number; connectTimeout?: number }
export interface HostEntry { id: string; name: string; address: string; tags: string[]; ssh: SshSettings }
export interface GroupEntry { id: string; name: string; tags: string[]; ssh: SshSettings; groups: GroupEntry[]; hosts: HostEntry[] }
export interface HostsFile { version: 1; groups: GroupEntry[]; hosts: HostEntry[] }
export const EMPTY_HOSTS_FILE: HostsFile;
export const SECRET_TOKEN: RegExp;                      // /^\$\{secret:([A-Za-z_][A-Za-z0-9_]*)\}$/
export function secretNameOf(token: string): string;    // throws ssh-literal-secret when not a token
export function parseHostsFile(text: string): HostsFile; // throws SshModelError
export function serializeHostsFile(file: HostsFile): string;
export function walk(file: HostsFile): Array<{ entry: HostEntry | GroupEntry; kind: 'host' | 'group'; path: readonly string[] }>;
```

`SshAuth` values are the **tokens as written** (`${secret:NAME}`), never resolved values.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/ssh/test/unit/model.test.ts
import { describe, expect, it } from 'vitest';
import { EMPTY_HOSTS_FILE, parseHostsFile, serializeHostsFile, SshModelError } from '../../src/index.js';

const SAMPLE = `
version: 1
groups:
  - id: prod
    name: Production
    tags: [prod]
    ssh:
      user: deploy
      port: 22
      jump: bastion
      auth: { key: '\${secret:prod_key}' }
    groups:
      - id: eu
        name: EU
        hosts:
          - id: api-1
            name: api-1
            address: 10.0.1.5
            ssh:
              auth: { password: '\${secret:api1_pw}' }
hosts:
  - id: bastion
    name: bastion
    address: bastion.example.com
    tags: [jump]
    ssh:
      user: ops
      auth: { agent: true }
`;

function expectCode(fn: () => unknown, code: string): SshModelError {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(SshModelError);
    expect((error as SshModelError).code).toBe(code);
    return error as SshModelError;
  }
  throw new Error(`expected ${code}`);
}

describe('parseHostsFile', () => {
  it('parses the sample into typed entries with defaults filled', () => {
    const file = parseHostsFile(SAMPLE);
    expect(file.groups[0]?.ssh.auth).toEqual({ kind: 'key', key: '${secret:prod_key}' });
    expect(file.groups[0]?.groups[0]?.hosts[0]?.tags).toEqual([]);
    expect(file.hosts[0]?.ssh.auth).toEqual({ kind: 'agent' });
  });
  it('an empty document is the empty file', () => {
    expect(parseHostsFile('')).toEqual(EMPTY_HOSTS_FILE);
    expect(parseHostsFile('version: 1\n')).toEqual(EMPTY_HOSTS_FILE);
  });
  it('refuses a literal password without echoing it', () => {
    const e = expectCode(() => parseHostsFile(`version: 1\nhosts:\n  - { id: a, name: a, address: a, ssh: { auth: { password: hunter2 } } }\n`), 'ssh-literal-secret');
    expect(e.details).toMatchObject({ path: 'hosts[0].ssh.auth.password' });
    expect(e.message).not.toContain('hunter2');
  });
  it('refuses a duplicate id across groups and hosts', () => {
    expectCode(() => parseHostsFile(`version: 1\ngroups:\n  - { id: x, name: g }\nhosts:\n  - { id: x, name: h, address: a }\n`), 'ssh-duplicate-id');
  });
  it('refuses unknown keys, a bad id, a bad version, and an auth with two methods', () => {
    expectCode(() => parseHostsFile(`version: 1\nhosts:\n  - { id: a, name: a, address: a, colour: red }\n`), 'ssh-hosts-invalid');
    expectCode(() => parseHostsFile(`version: 1\nhosts:\n  - { id: 'Bad Id', name: a, address: a }\n`), 'ssh-hosts-invalid');
    expectCode(() => parseHostsFile(`version: 2\n`), 'ssh-hosts-invalid');
    expectCode(() => parseHostsFile(`version: 1\nhosts:\n  - { id: a, name: a, address: a, ssh: { auth: { agent: true, password: '\${secret:p}' } } }\n`), 'ssh-hosts-invalid');
  });
  it('refuses a jump that names no host, and a jump cycle', () => {
    expectCode(() => parseHostsFile(`version: 1\nhosts:\n  - { id: a, name: a, address: a, ssh: { jump: nope } }\n`), 'ssh-jump-unknown');
    const e = expectCode(() => parseHostsFile(`version: 1\nhosts:\n  - { id: a, name: a, address: a, ssh: { jump: b } }\n  - { id: b, name: b, address: b, ssh: { jump: a } }\n`), 'ssh-jump-cycle');
    expect(e.details).toMatchObject({ cycle: ['a', 'b', 'a'] });
  });
  it('round-trips through serializeHostsFile', () => {
    const file = parseHostsFile(SAMPLE);
    expect(parseHostsFile(serializeHostsFile(file))).toEqual(file);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `nice pnpm vitest run --project ssh-unit`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement**

```ts
// packages/ssh/src/errors.ts
export type SshErrorCode = /* the union above */;

/** Mirrors the engine's WirebenchError shape (code, message, details) without importing it. */
export class SshModelError extends Error {
  readonly code: SshErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(code: SshErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'SshModelError';
    this.code = code;
    this.details = details;
  }
}
```

```ts
// packages/ssh/src/model.ts
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { SshModelError } from './errors.js';
import { resolveSettings } from './resolve.js'; // Task 7; in this task use `hosts.get(id)?.ssh.jump` in checkJumps

export const SECRET_TOKEN = /^\$\{secret:([A-Za-z_][A-Za-z0-9_]*)\}$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;

export function secretNameOf(token: string): string {
  const match = SECRET_TOKEN.exec(token);
  if (!match?.[1]) throw new SshModelError('ssh-literal-secret', 'expected a ${secret:NAME} token');
  return match[1];
}

/** A credential as written: a `${secret:NAME}` token. The issue never echoes the value. */
const secretRef = z.string().superRefine((value, ctx) => {
  if (!SECRET_TOKEN.test(value)) ctx.addIssue({ code: 'custom', message: 'must be a ${secret:NAME} token', params: { literalSecret: true } });
});

const authSchema = z.union([
  z.strictObject({ password: secretRef }).transform((a) => ({ kind: 'password' as const, password: a.password })),
  z.strictObject({ key: secretRef, passphrase: secretRef.optional() })
    .transform((a) => ({ kind: 'key' as const, key: a.key, ...(a.passphrase ? { passphrase: a.passphrase } : {}) })),
  z.strictObject({ agent: z.literal(true) }).transform(() => ({ kind: 'agent' as const })),
]);

const settingsSchema = z.strictObject({
  user: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  jump: z.string().regex(ID).optional(),
  auth: authSchema.optional(),
  keepAlive: z.number().int().min(0).optional(),
  connectTimeout: z.number().int().min(1).optional(),
}).default({});

const hostSchema = z.strictObject({
  id: z.string().regex(ID), name: z.string().min(1), address: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]), ssh: settingsSchema,
});

export interface GroupEntry { id: string; name: string; tags: string[]; ssh: SshSettings; groups: GroupEntry[]; hosts: HostEntry[] }
const groupSchema: z.ZodType<GroupEntry> = z.lazy(() => z.strictObject({
  id: z.string().regex(ID), name: z.string().min(1), tags: z.array(z.string().min(1)).default([]),
  ssh: settingsSchema, groups: z.array(groupSchema).default([]), hosts: z.array(hostSchema).default([]),
}));

const fileSchema = z.strictObject({ version: z.literal(1), groups: z.array(groupSchema).default([]), hosts: z.array(hostSchema).default([]) });

export type SshAuth = z.infer<typeof authSchema>;
export type SshSettings = z.infer<typeof settingsSchema>;
export type HostEntry = z.infer<typeof hostSchema>;
export type HostsFile = z.infer<typeof fileSchema>;
export const EMPTY_HOSTS_FILE: HostsFile = { version: 1, groups: [], hosts: [] };

const pathString = (path: readonly PropertyKey[]) =>
  path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`)).join('');

export function parseHostsFile(text: string): HostsFile {
  const raw: unknown = text.trim() === '' ? { version: 1 } : parseYaml(text);
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const literal = parsed.error.issues.find((i) => (i as { params?: { literalSecret?: boolean } }).params?.literalSecret);
    if (literal) throw new SshModelError('ssh-literal-secret', `${pathString(literal.path)} must be a \${secret:NAME} token`, { path: pathString(literal.path) });
    const first = parsed.error.issues[0];
    throw new SshModelError('ssh-hosts-invalid', `hosts.yaml: ${pathString(first?.path ?? [])} ${first?.message ?? 'invalid'}`, {
      path: pathString(first?.path ?? []),
      issues: parsed.error.issues.map((i) => ({ path: pathString(i.path), message: i.message })),
    });
  }
  checkIds(parsed.data);
  checkJumps(parsed.data);
  return parsed.data;
}

export function walk(file: HostsFile) {
  const out: Array<{ entry: HostEntry | GroupEntry; kind: 'host' | 'group'; path: readonly string[] }> = [];
  const visit = (groups: GroupEntry[], hosts: HostEntry[], path: readonly string[]) => {
    for (const group of groups) { out.push({ entry: group, kind: 'group', path }); visit(group.groups, group.hosts, [...path, group.id]); }
    for (const host of hosts) out.push({ entry: host, kind: 'host', path });
  };
  visit(file.groups, file.hosts, []);
  return out;
}

function checkIds(file: HostsFile): void {
  const seen = new Map<string, readonly string[]>();
  for (const { entry, path } of walk(file)) {
    const previous = seen.get(entry.id);
    if (previous) throw new SshModelError('ssh-duplicate-id', `id "${entry.id}" is used twice`, { id: entry.id, paths: [[...previous, entry.id].join('/'), [...path, entry.id].join('/')] });
    seen.set(entry.id, path);
  }
}

function checkJumps(file: HostsFile): void {
  const hosts = new Set(walk(file).filter((i) => i.kind === 'host').map((i) => i.entry.id));
  for (const { entry, kind } of walk(file)) {
    const jump = entry.ssh.jump;
    if (jump !== undefined && !hosts.has(jump)) throw new SshModelError('ssh-jump-unknown', `${kind} "${entry.id}" jumps through unknown host "${jump}"`, { id: entry.id, jump });
  }
  for (const id of hosts) {
    const chain = [id];
    let next = resolveSettings(file, id).jump;
    while (next !== undefined) {
      if (chain.includes(next)) throw new SshModelError('ssh-jump-cycle', `jump chain loops: ${[...chain, next].join(' → ')}`, { cycle: [...chain, next] });
      chain.push(next);
      next = resolveSettings(file, next).jump;
    }
  }
}

export function serializeHostsFile(file: HostsFile): string {
  return stringifyYaml(stripDefaults(file), { lineWidth: 0 });
}
```

`stripDefaults(file)` returns a plain object that omits empty `tags`, empty `ssh`, empty `groups`/`hosts`, and
writes `auth` back in its file form (`{ password }`, `{ key, passphrase? }`, `{ agent: true }`); write it as
three small functions `settings(ssh)`, `host(h)`, `group(g)` (recursive). Keys in document order: id, name,
tags, ssh, groups, hosts.

- [ ] **Step 4: Run the tests**

Run: `nice pnpm vitest run --project ssh-unit && nice pnpm --filter @wirebench/ssh typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ssh
git commit -m "ssh: hosts.yaml schema with secret-only credentials and jump checks"
```

### Task 7: Inheritance with provenance

**Files:**

- Create: `packages/ssh/src/resolve.ts`
- Modify: `packages/ssh/src/index.ts`
- Test: `packages/ssh/test/unit/resolve.test.ts`

**Interfaces (produces):**

```ts
export type Provenance<T> = { readonly value: T; readonly from: 'host' | 'default' | { readonly group: string } };
export interface ResolvedHost {
  readonly id: string; readonly name: string; readonly address: string; readonly tags: readonly string[];
  readonly path: readonly string[];   // group ids, root first
  readonly ssh: {
    readonly user: Provenance<string | undefined>; readonly port: Provenance<number>;            // default 22
    readonly auth: Provenance<SshAuth | undefined>; readonly jump: Provenance<string | undefined>;
    readonly keepAlive: Provenance<number>;                                                        // default 15
    readonly connectTimeout: Provenance<number>;                                                   // default 20
  };
  readonly incomplete?: { readonly field: 'user' | 'auth' };
}
export function resolveSettings(file: HostsFile, id: string): SshSettings;         // merged values, no provenance
export function resolveHost(file: HostsFile, id: string): ResolvedHost;             // throws ssh-jump-unknown when id is not a host
export function listResolvedHosts(file: HostsFile): readonly ResolvedHost[];        // document order
export function jumpChain(file: HostsFile, id: string): readonly ResolvedHost[];    // [outermost hop, …, target]
```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/ssh/test/unit/resolve.test.ts
import { describe, expect, it } from 'vitest';
import { jumpChain, listResolvedHosts, parseHostsFile, resolveHost } from '../../src/index.js';

const FILE = parseHostsFile(`
version: 1
groups:
  - id: prod
    name: Production
    ssh: { user: deploy, port: 2222, jump: bastion, auth: { key: '\${secret:prod_key}' } }
    groups:
      - id: eu
        name: EU
        ssh: { user: eu-deploy }
        hosts:
          - { id: api-1, name: api-1, address: 10.0.1.5, ssh: { auth: { password: '\${secret:api1_pw}' } } }
          - { id: api-2, name: api-2, address: 10.0.1.6 }
hosts:
  - { id: bastion, name: bastion, address: bastion.example.com, ssh: { user: ops, auth: { agent: true } } }
  - { id: bare, name: bare, address: 10.9.9.9 }
`);

describe('resolveHost', () => {
  it('nearer group wins, host wins over group, defaults are marked', () => {
    const host = resolveHost(FILE, 'api-1');
    expect(host.path).toEqual(['prod', 'eu']);
    expect(host.ssh.user).toEqual({ value: 'eu-deploy', from: { group: 'eu' } });
    expect(host.ssh.port).toEqual({ value: 2222, from: { group: 'prod' } });
    expect(host.ssh.auth).toEqual({ value: { kind: 'password', password: '${secret:api1_pw}' }, from: 'host' });
    expect(host.ssh.jump).toEqual({ value: 'bastion', from: { group: 'prod' } });
    expect(host.ssh.keepAlive).toEqual({ value: 15, from: 'default' });
    expect(host.incomplete).toBeUndefined();
  });
  it('auth is replaced whole, never merged', () => {
    expect(resolveHost(FILE, 'api-2').ssh.auth).toEqual({ value: { kind: 'key', key: '${secret:prod_key}' }, from: { group: 'prod' } });
  });
  it('a host with no user or auth anywhere is incomplete', () => {
    expect(resolveHost(FILE, 'bare').incomplete).toEqual({ field: 'user' });
  });
  it('jumpChain lists the hops outermost first and ends with the target', () => {
    expect(jumpChain(FILE, 'api-1').map((h) => h.id)).toEqual(['bastion', 'api-1']);
    expect(jumpChain(FILE, 'bastion').map((h) => h.id)).toEqual(['bastion']);
  });
  it('listResolvedHosts keeps document order', () => {
    expect(listResolvedHosts(FILE).map((h) => h.id)).toEqual(['api-1', 'api-2', 'bastion', 'bare']);
  });
  it('an inherited jump that loops is refused at parse time', () => {
    expect(() => parseHostsFile(`version: 1\ngroups:\n  - id: g\n    name: g\n    ssh: { jump: a }\n    hosts:\n      - { id: a, name: a, address: a }\n`)).toThrow(/loops/);
  });
  it('a group id or unknown id is not a host', () => {
    expect(() => resolveHost(FILE, 'prod')).toThrow(/not a host/);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `nice pnpm vitest run --project ssh-unit packages/ssh/test/unit/resolve.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/ssh/src/resolve.ts
import { SshModelError } from './errors.js';
import { walk } from './model.js';
import type { GroupEntry, HostEntry, HostsFile, SshAuth, SshSettings } from './model.js';

export type Provenance<T> = { readonly value: T; readonly from: 'host' | 'default' | { readonly group: string } };
export interface ResolvedHost { /* as in Interfaces */ }

const DEFAULTS = { port: 22, keepAlive: 15, connectTimeout: 20 } as const;
interface Located { readonly host: HostEntry; readonly chain: readonly GroupEntry[] }

function locate(file: HostsFile, id: string): Located {
  const groups = new Map<string, GroupEntry>();
  const items = walk(file);
  for (const item of items) if (item.kind === 'group') groups.set(item.entry.id, item.entry as GroupEntry);
  const found = items.find((item) => item.kind === 'host' && item.entry.id === id);
  if (!found) throw new SshModelError('ssh-jump-unknown', `"${id}" is not a host`, { id });
  return { host: found.entry as HostEntry, chain: found.path.map((gid) => groups.get(gid)!) };
}

function pick<K extends keyof SshSettings>(located: Located, key: K, fallback: SshSettings[K]): Provenance<SshSettings[K]> {
  if (located.host.ssh[key] !== undefined) return { value: located.host.ssh[key], from: 'host' };
  for (let i = located.chain.length - 1; i >= 0; i -= 1) {
    const group = located.chain[i]!;
    if (group.ssh[key] !== undefined) return { value: group.ssh[key], from: { group: group.id } };
  }
  return { value: fallback, from: 'default' };
}

export function resolveSettings(file: HostsFile, id: string): SshSettings {
  const located = locate(file, id);
  const out: Record<string, unknown> = {};
  for (const key of ['user', 'port', 'jump', 'auth', 'keepAlive', 'connectTimeout'] as const) {
    const { value } = pick(located, key, undefined);
    if (value !== undefined) out[key] = value;
  }
  return out as SshSettings;
}

export function resolveHost(file: HostsFile, id: string): ResolvedHost {
  const located = locate(file, id);
  const ssh = {
    user: pick(located, 'user', undefined) as Provenance<string | undefined>,
    port: pick(located, 'port', DEFAULTS.port) as Provenance<number>,
    auth: pick(located, 'auth', undefined) as Provenance<SshAuth | undefined>,
    jump: pick(located, 'jump', undefined) as Provenance<string | undefined>,
    keepAlive: pick(located, 'keepAlive', DEFAULTS.keepAlive) as Provenance<number>,
    connectTimeout: pick(located, 'connectTimeout', DEFAULTS.connectTimeout) as Provenance<number>,
  };
  const incomplete = ssh.user.value === undefined ? { field: 'user' as const } : ssh.auth.value === undefined ? { field: 'auth' as const } : undefined;
  return { id: located.host.id, name: located.host.name, address: located.host.address, tags: located.host.tags, path: located.chain.map((g) => g.id), ssh, ...(incomplete ? { incomplete } : {}) };
}

export function listResolvedHosts(file: HostsFile): readonly ResolvedHost[] {
  return walk(file).filter((i) => i.kind === 'host').map((i) => resolveHost(file, i.entry.id));
}

export function jumpChain(file: HostsFile, id: string): readonly ResolvedHost[] {
  const chain: ResolvedHost[] = [];
  let current: string | undefined = id;
  while (current !== undefined && !chain.some((h) => h.id === current)) {
    const host = resolveHost(file, current);
    chain.unshift(host);
    current = host.ssh.jump.value;
  }
  return chain;
}
```

`model.ts` ↔ `resolve.ts` import each other (`walk` one way, `resolveSettings` the other). Neither runs
code at module evaluation, so the ESM cycle is harmless; the layer test does not forbid intra-package
cycles. If `tsc` complains, move `walk` into a third file `tree.ts` that both import.

- [ ] **Step 4: Run the tests**

Run: `nice pnpm vitest run --project ssh-unit && nice pnpm --filter @wirebench/ssh typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ssh
git commit -m "ssh: resolve a host through its groups with per-field provenance"
```

### Task 8: `HostsService` and the `ssh.listHosts` / `ssh.saveHosts` channels

**Files:**

- Create: `apps/desktop/src/shared/ssh-wire.ts`, `apps/desktop/src/shared/areas/ssh.ts`,
  `apps/desktop/src/main/hosts-service.ts`, `apps/desktop/src/main/areas/ssh.ts`
- Modify: `apps/desktop/package.json` (`"@wirebench/ssh": "workspace:*"` in `dependencies`),
  `apps/desktop/src/shared/area-module.ts` (`sshArea` appended to `AREAS`), `apps/desktop/src/shared/ipc.ts`
  (`ssh` channel group; `events.ssh.hostsChanged`), `apps/desktop/src/shared/commands.ts` (`view.showHosts`),
  `apps/desktop/src/shared/command-catalog.ts`, `apps/desktop/src/renderer/commands/register-view-commands.ts`,
  `apps/desktop/src/renderer/areas/index.ts` (placeholder `ssh` view until Task 9),
  `apps/desktop/src/main/areas.ts` (`registerEnabledAreaChannels`), `apps/desktop/src/main/index.ts`
- Test: `apps/desktop/test/hosts-service.test.ts`, `apps/desktop/test/ipc-ssh.test.ts`

**Interfaces (produces):**

```ts
// shared/ssh-wire.ts — secret = NAME only; never a token, never a value
export const sshProblemSchema = z.object({ code: z.string(), message: z.string(), path: z.string().optional() });
export const sshAuthWireSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('password'), secret: z.string() }),
  z.object({ kind: z.literal('key'), secret: z.string(), passphraseSecret: z.string().optional() }),
  z.object({ kind: z.literal('agent') }),
]);
export const sshSettingsWireSchema = z.object({ user: z.string().optional(), port: z.number().optional(), jump: z.string().optional(), auth: sshAuthWireSchema.optional(), keepAlive: z.number().optional(), connectTimeout: z.number().optional() });
export const hostEntryWireSchema = z.object({ id: z.string(), name: z.string(), address: z.string(), tags: z.array(z.string()), ssh: sshSettingsWireSchema });
export const groupEntryWireSchema: z.ZodType<GroupEntryWire> = z.lazy(() => z.object({ id, name, tags, ssh: sshSettingsWireSchema, groups: z.array(groupEntryWireSchema), hosts: z.array(hostEntryWireSchema) }));
export const hostsFileWireSchema = z.object({ version: z.literal(1), groups: z.array(groupEntryWireSchema), hosts: z.array(hostEntryWireSchema) });
const prov = <T extends z.ZodType>(value: T) => z.object({ value, from: z.union([z.literal('host'), z.literal('default'), z.object({ group: z.string() })]) });
export const resolvedHostWireSchema = z.object({ id, name, address, tags, path: z.array(z.string()),
  ssh: z.object({ user: prov(z.string().optional()), port: prov(z.number()), auth: prov(sshAuthWireSchema.optional()), jump: prov(z.string().optional()), keepAlive: prov(z.number()), connectTimeout: prov(z.number()) }),
  incomplete: z.object({ field: z.enum(['user', 'auth']) }).optional() });
export const sshListHostsResponseSchema = z.object({ file: hostsFileWireSchema, resolved: z.array(resolvedHostWireSchema), problems: z.array(sshProblemSchema) });
export const sshSaveHostsRequestSchema = z.object({ file: hostsFileWireSchema });
export type HostsFileWire = z.infer<typeof hostsFileWireSchema>; export type ResolvedHostWire = …; export type SshProblemWire = …; export type SshListHostsResponse = …;

// main/hosts-service.ts
export const HOSTS_FILE = 'hosts.yaml';
export class HostsService {
  constructor(deps: { treeDir: () => string | undefined; onChanged?: () => void });
  list(): Promise<SshListHostsResponse>;
  save(file: HostsFileWire): Promise<SshListHostsResponse>;   // throws SshModelError / WirebenchError
  current(): HostsFile | undefined;                           // last parsed model (packages/ssh type)
  invalidate(): void;
}
// main/areas/ssh.ts
export function registerSshChannels(deps: { hosts: Pick<HostsService, 'list' | 'save'>; ssh: SshService }): void;
// main/areas.ts
export function registerEnabledAreaChannels(enabled: readonly AreaId[], deps: Parameters<typeof registerSshChannels>[0]): void;
```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/test/hosts-service.test.ts
// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostsService } from '../src/main/hosts-service.js';

const dir = () => mkdtempSync(join(tmpdir(), 'wb-hosts-'));

describe('HostsService', () => {
  it('a missing hosts.yaml is the empty file with no problems', async () => {
    expect(await new HostsService({ treeDir: () => dir() }).list()).toEqual({ file: { version: 1, groups: [], hosts: [] }, resolved: [], problems: [] });
  });
  it('a malformed file is a problem, not a throw, and never echoes the literal', async () => {
    const d = dir();
    writeFileSync(join(d, 'hosts.yaml'), 'version: 1\nhosts:\n  - { id: a, name: a, address: a, ssh: { auth: { password: oops } } }\n');
    const result = await new HostsService({ treeDir: () => d }).list();
    expect(result.problems).toEqual([{ code: 'ssh-literal-secret', message: expect.stringContaining('${secret:NAME}'), path: 'hosts[0].ssh.auth.password' }]);
    expect(result.resolved).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('oops');
  });
  it('save writes the file, re-reads it, reports secrets by name and notifies', async () => {
    const d = dir();
    let changed = 0;
    const service = new HostsService({ treeDir: () => d, onChanged: () => { changed += 1; } });
    const result = await service.save({ version: 1, groups: [], hosts: [{ id: 'a', name: 'A', address: '10.0.0.1', tags: [], ssh: { user: 'me', auth: { kind: 'password', secret: 'a_pw' } } }] });
    expect(readFileSync(join(d, 'hosts.yaml'), 'utf8')).toContain('password: ${secret:a_pw}');
    expect(result.resolved[0]?.ssh.auth).toEqual({ value: { kind: 'password', secret: 'a_pw' }, from: 'host' });
    expect(changed).toBe(1);
  });
  it('save refuses a secret name that is not a NAME', async () => {
    await expect(new HostsService({ treeDir: () => dir() }).save({ version: 1, groups: [], hosts: [{ id: 'a', name: 'A', address: 'x', tags: [], ssh: { auth: { kind: 'password', secret: 'has space' } } }] }))
      .rejects.toMatchObject({ code: 'ssh-literal-secret' });
  });
  it('no open workspace is workspace-not-open', async () => {
    await expect(new HostsService({ treeDir: () => undefined }).list()).rejects.toMatchObject({ code: 'workspace-not-open' });
  });
});
```

```ts
// apps/desktop/test/ipc-ssh.test.ts
// @vitest-environment node
// Copy the electron/ipcMain mock + `invoke(name, payload)` helper from apps/desktop/test/ipc-secret-sources.test.ts.
import { registerSshChannels } from '../src/main/areas/ssh.js';
const EMPTY = { file: { version: 1, groups: [], hosts: [] }, resolved: [], problems: [] };
it('ssh.listHosts answers the service; ssh.saveHosts passes the file through', async () => {
  const list = vi.fn().mockResolvedValue(EMPTY); const save = vi.fn().mockResolvedValue(EMPTY);
  registerSshChannels({ hosts: { list, save }, ssh: {} as never });
  expect(await invoke('ssh.listHosts', undefined)).toEqual({ ok: true, value: EMPTY });
  await invoke('ssh.saveHosts', { file: EMPTY.file });
  expect(save).toHaveBeenCalledWith(EMPTY.file);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/hosts-service.test.ts apps/desktop/test/ipc-ssh.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`shared/areas/ssh.ts`:

```ts
import type { AreaModule } from '../area-module.js';
export const sshArea = {
  id: 'ssh',
  feature: { id: 'ssh', title: 'SSH', default: true, stage: 'experimental', requires: [] },
  rail: { label: 'Hosts', icon: 'TerminalSquare', command: 'view.showHosts', order: 60, testId: 'activity-hosts' },
  copy: { title: 'Hosts', headline: 'No hosts yet', body: 'Add a host, or a group that holds the user and key its hosts share.' },
} as const satisfies AreaModule<'ssh'>;
```

`COMMAND_IDS` gains `'view.showHosts'`; catalog `{ id: 'view.showHosts', label: 'Show Hosts', category: 'View' }`;
`register-view-commands.ts` registers it like `view.showHistory` (`ui().showSidebarView('ssh')`).
`renderer/areas/index.ts`: `ssh: { View: () => <p className="p-4 text-sm text-fg-subtle">Hosts</p> }` (Task 9
replaces it; the file becomes `.tsx` or the placeholder lives in `features/ssh/hosts-view.tsx` from the start —
prefer the latter: create `hosts-view.tsx` exporting a placeholder `HostsView` now).

`main/hosts-service.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WirebenchError, nodeFs, writeFileAtomic } from '@wirebench/engine';
import { EMPTY_HOSTS_FILE, SshModelError, listResolvedHosts, parseHostsFile, secretNameOf, serializeHostsFile } from '@wirebench/ssh';
import type { GroupEntry, HostEntry, HostsFile, ResolvedHost, SshAuth, SshSettings } from '@wirebench/ssh';
import type { GroupEntryWire, HostEntryWire, HostsFileWire, ResolvedHostWire, SshAuthWire, SshListHostsResponse, SshProblemWire, SshSettingsWire } from '../shared/ssh-wire.js';

export const HOSTS_FILE = 'hosts.yaml';
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class HostsService {
  private cache: { dir: string; file: HostsFile; problems: SshProblemWire[] } | undefined;
  constructor(private readonly deps: { treeDir: () => string | undefined; onChanged?: () => void }) {}

  invalidate(): void { this.cache = undefined; }
  current(): HostsFile | undefined { return this.cache?.file; }

  async list(): Promise<SshListHostsResponse> {
    const { file, problems } = await this.load();
    return { file: fileToWire(file), resolved: listResolvedHosts(file).map(resolvedToWire), problems };
  }

  async save(wire: HostsFileWire): Promise<SshListHostsResponse> {
    const dir = this.requireDir();
    const file = parseHostsFile(serializeHostsFile(fileFromWire(wire))); // the round trip is the full validation
    await writeFileAtomic(nodeFs, join(dir, HOSTS_FILE), serializeHostsFile(file));
    this.cache = { dir, file, problems: [] };
    this.deps.onChanged?.();
    return this.list();
  }

  private requireDir(): string {
    const dir = this.deps.treeDir();
    if (!dir) throw new WirebenchError('workspace-not-open', 'Open a workspace first');
    return dir;
  }

  private async load() {
    const dir = this.requireDir();
    if (this.cache?.dir === dir) return this.cache;
    let text = '';
    try { text = await readFile(join(dir, HOSTS_FILE), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let file = EMPTY_HOSTS_FILE;
    const problems: SshProblemWire[] = [];
    try { file = parseHostsFile(text); }
    catch (error) {
      if (!(error instanceof SshModelError)) throw error;
      const path = error.details['path'];
      problems.push({ code: error.code, message: error.message, ...(typeof path === 'string' ? { path } : {}) });
    }
    this.cache = { dir, file, problems };
    return this.cache;
  }
}

function authToWire(auth: SshAuth | undefined): SshAuthWire | undefined {
  if (!auth) return undefined;
  if (auth.kind === 'agent') return { kind: 'agent' };
  if (auth.kind === 'password') return { kind: 'password', secret: secretNameOf(auth.password) };
  return { kind: 'key', secret: secretNameOf(auth.key), ...(auth.passphrase ? { passphraseSecret: secretNameOf(auth.passphrase) } : {}) };
}
function token(name: string): string {
  if (!NAME.test(name)) throw new SshModelError('ssh-literal-secret', 'a secret name must match [A-Za-z_][A-Za-z0-9_]*', { name });
  return `\${secret:${name}}`;
}
function authFromWire(auth: SshAuthWire | undefined): SshAuth | undefined {
  if (!auth) return undefined;
  if (auth.kind === 'agent') return { kind: 'agent' };
  if (auth.kind === 'password') return { kind: 'password', password: token(auth.secret) };
  return { kind: 'key', key: token(auth.secret), ...(auth.passphraseSecret ? { passphrase: token(auth.passphraseSecret) } : {}) };
}
const settingsToWire = (s: SshSettings): SshSettingsWire => ({ ...s, ...(s.auth ? { auth: authToWire(s.auth) } : {}) });
const settingsFromWire = (s: SshSettingsWire): SshSettings => ({ ...s, ...(s.auth ? { auth: authFromWire(s.auth) } : {}) });
const hostToWire = (h: HostEntry): HostEntryWire => ({ ...h, ssh: settingsToWire(h.ssh) });
const hostFromWire = (h: HostEntryWire): HostEntry => ({ ...h, ssh: settingsFromWire(h.ssh) });
const groupToWire = (g: GroupEntry): GroupEntryWire => ({ ...g, ssh: settingsToWire(g.ssh), groups: g.groups.map(groupToWire), hosts: g.hosts.map(hostToWire) });
const groupFromWire = (g: GroupEntryWire): GroupEntry => ({ ...g, ssh: settingsFromWire(g.ssh), groups: g.groups.map(groupFromWire), hosts: g.hosts.map(hostFromWire) });
const fileToWire = (f: HostsFile): HostsFileWire => ({ version: 1, groups: f.groups.map(groupToWire), hosts: f.hosts.map(hostToWire) });
const fileFromWire = (f: HostsFileWire): HostsFile => ({ version: 1, groups: f.groups.map(groupFromWire), hosts: f.hosts.map(hostFromWire) });
const resolvedToWire = (h: ResolvedHost): ResolvedHostWire => ({ ...h, ssh: { ...h.ssh, auth: { value: authToWire(h.ssh.auth.value), from: h.ssh.auth.from } } });
```

`grep -rn "workspace-not-open" apps/desktop/src/main` first; reuse the existing code string if one exists.

`main/areas/ssh.ts`:

```ts
import { channels } from '../../shared/ipc.js';
import { registerHandler } from '../ipc/register.js';
import type { HostsService } from '../hosts-service.js';
import type { SshService } from '../ssh-service.js'; // Task 11; declare `export type SshService = Record<string, never>` in a stub ssh-service.ts until then

export function registerSshChannels(deps: { hosts: Pick<HostsService, 'list' | 'save'>; ssh: SshService }): void {
  registerHandler(channels.ssh.listHosts, () => deps.hosts.list());
  registerHandler(channels.ssh.saveHosts, (request) => deps.hosts.save(request.file));
}
```

`shared/ipc.ts`: `ssh: { listHosts: defineChannel('ssh.listHosts', z.undefined(), sshListHostsResponseSchema), saveHosts: defineChannel('ssh.saveHosts', sshSaveHostsRequestSchema, sshListHostsResponseSchema) }`
and `events.ssh = { hostsChanged: defineEvent('ssh.hostsChanged', z.object({})) }`.

`main/areas.ts` gains `registerEnabledAreaChannels(enabled, deps) { if (enabled.includes('ssh')) registerSshChannels(deps); }`.
`main/index.ts`: after `WorkspaceService`, `const hostsService = new HostsService({ treeDir: () => workspaceService.treeDir(), onChanged: () => broadcast(events.ssh.hostsChanged, {}) });`
add `hostsService.invalidate();` inside `hooks.onChanged`; after the Wss registration call
`registerEnabledAreaChannels(enabledAreas, { hosts: hostsService, ssh: sshService })` (`sshService` is `{}`
cast until Task 11). Check how `workspace.changedOnDisk` is raised in `workspace-service.ts` and invalidate
there too.

- [ ] **Step 4: Run tests, typecheck, check**

Run: `pnpm install && nice pnpm vitest run --project desktop && WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: PASS (run `pnpm docs:commands` first if the catalog check fails; commit its output).

- [ ] **Step 5: Commit**

```bash
git add -A apps/desktop docs pnpm-lock.yaml
git commit -m "desktop: read and write hosts.yaml through main for the ssh area"
```

### Task 9: The Hosts view and the host dialog

**Files:**

- Create: `apps/desktop/src/renderer/features/ssh/hosts-store.ts`, `hosts-view.tsx` (replace placeholder),
  `host-tree.tsx`, `host-dialog.tsx`, `inherited-field.tsx`,
  `apps/desktop/src/renderer/commands/register-ssh-commands.ts`
- Modify: `renderer/areas/index.ts` (`ssh: { View: HostsView, registerCommands: registerSshCommands }`),
  `shared/commands.ts` (`ssh.newHost`, `ssh.newGroup`, `ssh.editHost`; `CommandCategory` gains `'Hosts'`),
  `shared/command-catalog.ts`, `renderer/state/problems.ts` (`ProblemSource` gains `'hosts'`),
  `renderer/shell/app-shell.tsx` (subscribe `ssh.hostsChanged`)
- Test: `apps/desktop/test/renderer/hosts-store.test.ts`, `host-dialog.test.tsx`, `hosts-view.test.tsx`

**Interfaces (produces):**

```ts
export type HostsDialog = { mode: 'new-host'; parent?: string } | { mode: 'edit-host'; id: string } | { mode: 'new-group'; parent?: string } | { mode: 'edit-group'; id: string } | null;
interface HostsState {
  file: HostsFileWire; resolved: readonly ResolvedHostWire[]; problems: readonly SshProblemWire[]; loaded: boolean;
  filter: string; selectedTags: readonly string[]; dialog: HostsDialog;
  refresh(): Promise<void>; save(file: HostsFileWire): Promise<boolean>;
  setFilter(text: string): void; toggleTag(tag: string): void; openDialog(d: HostsDialog): void; closeDialog(): void;
  visibleHosts(): readonly ResolvedHostWire[];
}
export const useHostsStore: UseBoundStore<StoreApi<HostsState>>;
export function upsertHost(file, host: HostEntryWire, parentGroupId?: string): HostsFileWire;
export function removeHost(file, id): HostsFileWire;
export function upsertGroup(file, group: GroupEntryWire, parentGroupId?: string): HostsFileWire;
export function removeGroup(file, id): HostsFileWire;      // throws Error('group is not empty')
export function moveHost(file, id, toGroupId: string | undefined): HostsFileWire;
// inherited-field.tsx
export function InheritedField<T extends string | number>(props: { label: string; provenance: { value: T | undefined; from: 'host' | 'default' | { group: string } }; override: T | undefined; onChange: (next: T | undefined) => void; type?: 'text' | 'number' }): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/test/renderer/hosts-store.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
const listHosts = vi.fn(); const saveHosts = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({ ipc: () => ({ ssh: { listHosts, saveHosts } }) }));
import { removeGroup, upsertHost, useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';

const defaults = { user: { value: undefined, from: 'default' }, port: { value: 22, from: 'default' }, auth: { value: undefined, from: 'default' }, jump: { value: undefined, from: 'default' }, keepAlive: { value: 15, from: 'default' }, connectTimeout: { value: 20, from: 'default' } } as const;
const RESPONSE = {
  file: { version: 1, groups: [{ id: 'g', name: 'G', tags: [], ssh: {}, groups: [], hosts: [{ id: 'a', name: 'alpha', address: '10.0.0.1', tags: ['prod'], ssh: {} }] }], hosts: [{ id: 'b', name: 'beta', address: 'beta.example', tags: [], ssh: {} }] },
  resolved: [
    { id: 'a', name: 'alpha', address: '10.0.0.1', tags: ['prod'], path: ['g'], ssh: defaults, incomplete: { field: 'user' } },
    { id: 'b', name: 'beta', address: 'beta.example', tags: [], path: [], ssh: defaults, incomplete: { field: 'user' } },
  ],
  problems: [],
};

beforeEach(() => {
  listHosts.mockResolvedValue({ ok: true, value: RESPONSE });
  saveHosts.mockResolvedValue({ ok: true, value: RESPONSE });
  useHostsStore.setState({ file: { version: 1, groups: [], hosts: [] }, resolved: [], problems: [], loaded: false, filter: '', selectedTags: [], dialog: null });
});

describe('hosts store', () => {
  it('refresh loads the file and resolved hosts', async () => {
    await useHostsStore.getState().refresh();
    expect(useHostsStore.getState().loaded).toBe(true);
    expect(useHostsStore.getState().visibleHosts().map((h) => h.id)).toEqual(['a', 'b']);
  });
  it('filter matches name, address and tags; selected tags narrow further', async () => {
    await useHostsStore.getState().refresh();
    useHostsStore.getState().setFilter('beta.ex');
    expect(useHostsStore.getState().visibleHosts().map((h) => h.id)).toEqual(['b']);
    useHostsStore.getState().setFilter('');
    useHostsStore.getState().toggleTag('prod');
    expect(useHostsStore.getState().visibleHosts().map((h) => h.id)).toEqual(['a']);
  });
  it('save sends the whole file; a refused save keeps the old state and records the problem', async () => {
    await useHostsStore.getState().refresh();
    const next = upsertHost(useHostsStore.getState().file, { id: 'c', name: 'c', address: 'c', tags: [], ssh: {} }, 'g');
    expect(next.groups[0]?.hosts.map((h) => h.id)).toEqual(['a', 'c']);
    expect(await useHostsStore.getState().save(next)).toBe(true);
    expect(saveHosts).toHaveBeenCalledWith({ file: next });
    saveHosts.mockResolvedValueOnce({ ok: false, error: { code: 'ssh-duplicate-id', message: 'dup' } });
    expect(await useHostsStore.getState().save(next)).toBe(false);
    expect(useHostsStore.getState().problems).toEqual([{ code: 'ssh-duplicate-id', message: 'dup' }]);
  });
  it('removeGroup refuses a non-empty group', () => {
    expect(() => removeGroup(RESPONSE.file, 'g')).toThrow(/not empty/);
  });
});
```

```tsx
// apps/desktop/test/renderer/host-dialog.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { InheritedField } from '../../src/renderer/features/ssh/inherited-field.js';

describe('InheritedField', () => {
  it('shows the inherited value greyed with its source; Override starts from that value', async () => {
    const onChange = vi.fn();
    render(<InheritedField label="User" provenance={{ value: 'deploy', from: { group: 'prod' } }} override={undefined} onChange={onChange} />);
    expect(screen.getByText('from prod')).toBeInTheDocument();
    expect(screen.getByLabelText('User')).toBeDisabled();
    await userEvent.click(screen.getByRole('switch', { name: 'Override User' }));
    expect(onChange).toHaveBeenCalledWith('deploy');
  });
  it('an overridden field is editable; the switch turns the override off', async () => {
    const onChange = vi.fn();
    render(<InheritedField label="User" provenance={{ value: 'deploy', from: { group: 'prod' } }} override="me" onChange={onChange} />);
    expect(screen.getByLabelText('User')).toHaveValue('me');
    await userEvent.click(screen.getByRole('switch', { name: 'Override User' }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});
```

`hosts-view.test.tsx`: set the store state to `RESPONSE` (plus one problem), render `<HostsView />`, assert
both host names and the group name render, host `a` shows the badge text `needs user`, and the problem's
code renders in a banner.

- [ ] **Step 2: Run them to see them fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/hosts-store.test.ts apps/desktop/test/renderer/host-dialog.test.tsx apps/desktop/test/renderer/hosts-view.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`hosts-store.ts` (zustand + immer, the pattern of `state/problems.ts`):

```ts
export const useHostsStore = create<HostsState>()(immer((set, get) => ({
  file: EMPTY, resolved: [], problems: [], loaded: false, filter: '', selectedTags: [], dialog: null,
  async refresh() { apply(await ipc().ssh.listHosts(undefined)); },
  async save(file) { return apply(await ipc().ssh.saveHosts({ file })); },
  setFilter: (filter) => set((s) => { s.filter = filter; }),
  toggleTag: (tag) => set((s) => { s.selectedTags = s.selectedTags.includes(tag) ? s.selectedTags.filter((t) => t !== tag) : [...s.selectedTags, tag]; }),
  openDialog: (dialog) => set((s) => { s.dialog = dialog; }),
  closeDialog: () => set((s) => { s.dialog = null; }),
  visibleHosts() {
    const { resolved, filter, selectedTags } = get();
    const needle = filter.trim().toLowerCase();
    const matches = (h: ResolvedHostWire) => needle === '' || [h.name, h.address, ...h.tags].some((t) => t.toLowerCase().includes(needle));
    return resolved.filter((h) => matches(h) && selectedTags.every((t) => h.tags.includes(t)));
  },
})));

function apply(result: IpcResult<SshListHostsResponse>): boolean {
  if (!result.ok) {
    useHostsStore.setState({ problems: [{ code: result.error.code, message: result.error.message }] });
    return false;
  }
  useHostsStore.setState({ file: result.value.file, resolved: result.value.resolved, problems: result.value.problems, loaded: true });
  useProblemsStore.getState().clearSource('hosts');
  useProblemsStore.getState().add(result.value.problems.map((p) => ({ groupId: 'hosts', source: 'hosts', severity: 'error', problem: { code: p.code, message: p.message, ...(p.path ? { location: p.path } : {}) } })));
  return true;
}
```

The five pure helpers share `mapGroups(file, fn: (group) => group | null)` (recursive, immutable);
`removeGroup` throws `new Error('group is not empty')` when `groups.length || hosts.length`.

`inherited-field.tsx`:

```tsx
export function InheritedField<T extends string | number>({ label, provenance, override, onChange, type = 'text' }: InheritedFieldProps<T>) {
  const id = useId();
  const overridden = override !== undefined;
  const source = typeof provenance.from === 'object' ? `from ${provenance.from.group}` : provenance.from === 'default' ? 'default' : undefined;
  return (
    <div className="flex items-end gap-2">
      <label htmlFor={id} className="flex-1 text-xs">
        <span className="block text-fg-subtle">{label}</span>
        <input id={id} type={type} disabled={!overridden} className="w-full rounded border border-border bg-bg px-2 py-1 disabled:text-fg-subtle"
          value={overridden ? String(override) : provenance.value === undefined ? '' : String(provenance.value)}
          onChange={(e) => onChange((type === 'number' ? Number(e.target.value) : e.target.value) as T)} />
      </label>
      {source && !overridden ? <span className="pb-1 text-xs text-fg-subtle">{source}</span> : null}
      <button type="button" role="switch" aria-checked={overridden} aria-label={`Override ${label}`} className="…"
        onClick={() => onChange(overridden ? undefined : provenance.value)} />
    </div>
  );
}
```

Reuse the app's existing class names for inputs and switches (read `secret-sources-dialog.tsx`).

`hosts-view.tsx`: filter input + tag chips (union of `resolved[].tags`), problems banner, "New host" /
"New group" buttons, `<HostTree />`, `<HostDialog />`; `useEffect(() => { void refresh(); }, [])`.
`host-tree.tsx`: groups collapsible (local `Set<string>` of collapsed ids), host rows showing name, address,
a status dot placeholder, a badge `needs ${incomplete.field}` when incomplete; row double-click/Enter opens
`edit-host` (Task 12 swaps this for connect); right-click uses `@radix-ui/react-context-menu` with Edit,
Duplicate (`upsertHost` with id suffixed `-copy`), Delete (`removeHost`), Copy address
(`navigator.clipboard.writeText`).
`host-dialog.tsx` (Radix Dialog as `secret-sources-dialog.tsx`): Name, Address, Tags (comma separated);
`InheritedField`s for User, Port (number), Jump (a `<select>` of other host ids, blank = inherit),
Keep-alive, Connect timeout, where provenance for an existing host is `resolved.find(id).ssh.<field>` with
`from: 'host'` entries treated as the override, and for a new host comes from a sibling resolved host under
the same parent or the defaults; Auth as radios Password / Key / Agent with secret `<select>`s over
`ipc().secrets.list(undefined)` → `entries[].name` (check `secretListEntrySchema` in `wire-types.ts` for the
field) plus "New secret…" running the existing command that opens the secrets dialog (find its id in
`COMMAND_IDS`). Save → `upsertHost`/`upsertGroup` → `save(file)`; on `false` stay open and show
`problems[0].message`. Group dialog: Name, Tags, the same `ssh` block.

`register-ssh-commands.ts`: `ssh.newHost` → `openDialog({ mode: 'new-host' })`, `ssh.newGroup`,
`ssh.editHost` (arg id). Catalog entries with category `'Hosts'`. `app-shell.tsx`:
`useEffect(() => window.wirebench.on('ssh.hostsChanged', () => { void useHostsStore.getState().refresh(); }), [])`.

- [ ] **Step 4: Run tests, typecheck, check**

Run: `nice pnpm vitest run --project desktop && pnpm docs:commands && WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit and open PR 2**

```bash
git add -A apps/desktop docs
git commit -m "desktop: Hosts view with group inheritance shown per field"
```

PR title: `ssh: hosts.yaml model and the Hosts view (#316, 2/5)`.

---

## PR 3 — Sessions

### Task 10: Known hosts and the ssh2 session in `packages/ssh`

**Files:**

- Create: `packages/ssh/src/known-hosts.ts`, `packages/ssh/src/session.ts`,
  `packages/ssh/test/helpers/ssh-fixture.ts`, `packages/ssh/test/helpers/index.ts` (re-export)
- Modify: `packages/ssh/src/index.ts`
- Test: `packages/ssh/test/unit/known-hosts.test.ts`, `packages/ssh/test/integration/session.test.ts`

**Interfaces (produces):**

```ts
// known-hosts.ts
export interface KnownHostEntry { readonly host: string /* 'address:port' */; readonly keyType: string; readonly fingerprint: string /* 'SHA256:<base64, no padding>' */ }
export type KnownHostCheck = 'known' | 'new' | 'changed';
export function fingerprintOf(key: Buffer): string;
export function keyTypeOf(key: Buffer): string;                       // first SSH string in the wire-format key
export function checkKnownHost(entries: readonly KnownHostEntry[], candidate: KnownHostEntry): KnownHostCheck;
export function rememberKnownHost(entries: readonly KnownHostEntry[], entry: KnownHostEntry): readonly KnownHostEntry[];
export function parseKnownHosts(text: string): readonly KnownHostEntry[];    // JSON array; '' or broken → []
export function serializeKnownHosts(entries: readonly KnownHostEntry[]): string;

// session.ts
export interface HopCredentials {
  readonly address: string; readonly port: number; readonly user: string;
  readonly auth: { kind: 'password'; password: string } | { kind: 'key'; privateKey: string; passphrase?: string } | { kind: 'agent'; socket: string };
  readonly keepAlive: number; readonly connectTimeout: number;      // seconds
}
export interface OpenSessionOptions {
  readonly hops: readonly HopCredentials[];                          // outermost first, target last
  readonly cols: number; readonly rows: number;
  readonly verifyHostKey: (hop: HopCredentials, key: KnownHostEntry) => Promise<'accept' | 'reject'>;
}
export interface SshSession {
  readonly id: string;
  write(data: Uint8Array): void; resize(cols: number, rows: number): void; close(): void;
  onData(listener: (data: Uint8Array) => void): () => void;
  onExit(listener: (exit: { code: number | null; signal?: string }) => void): () => void;
}
export class SshConnectError extends SshModelError {}   // ssh-host-key-new {host,keyType,fingerprint} · ssh-auth-failed {host,method} · ssh-connect-failed {host,hop}
export function openSession(options: OpenSessionOptions): Promise<SshSession>;

// test/helpers/ssh-fixture.ts
export interface SshFixture { readonly port: number; readonly hostKey: KnownHostEntry; lastResize?: { cols: number; rows: number }; close(): Promise<void> }
export function startSshFixture(options: { password: { user: string; password: string }; allowForwardOut?: boolean }): Promise<SshFixture>;
```

The fixture's shell echoes every byte back, records `pty-req`/`window-change` in `lastResize`, and exits
with code N when the accumulated input line is `exit N`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/ssh/test/unit/known-hosts.test.ts
import { describe, expect, it } from 'vitest';
import { checkKnownHost, parseKnownHosts, rememberKnownHost, serializeKnownHosts } from '../../src/index.js';
const a = { host: 'h:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:aaa' };
describe('known hosts', () => {
  it('new, known, changed', () => {
    expect(checkKnownHost([], a)).toBe('new');
    expect(checkKnownHost([a], a)).toBe('known');
    expect(checkKnownHost([a], { ...a, fingerprint: 'SHA256:bbb' })).toBe('changed');
    expect(checkKnownHost([a], { ...a, host: 'h:2222' })).toBe('new');
  });
  it('remember replaces the entry for the same host and key type', () => {
    expect(rememberKnownHost([a], { ...a, fingerprint: 'SHA256:bbb' })).toEqual([{ ...a, fingerprint: 'SHA256:bbb' }]);
  });
  it('round-trips and tolerates an empty or broken file', () => {
    expect(parseKnownHosts(serializeKnownHosts([a]))).toEqual([a]);
    expect(parseKnownHosts('')).toEqual([]);
    expect(parseKnownHosts('{not json')).toEqual([]);
    expect(parseKnownHosts('[{"host":1}]')).toEqual([]);
  });
});
```

```ts
// packages/ssh/test/integration/session.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { openSession } from '../../src/index.js';
import type { SshSession } from '../../src/index.js';
import { startSshFixture } from '../helpers/ssh-fixture.js';
import type { SshFixture } from '../helpers/ssh-fixture.js';

const accept = async () => 'accept' as const;
const hop = (port: number, password: string) => ({ address: '127.0.0.1', port, user: 'tester', auth: { kind: 'password' as const, password }, keepAlive: 0, connectTimeout: 5 });
const open: SshFixture[] = []; let session: SshSession | undefined;
afterEach(async () => { session?.close(); session = undefined; await Promise.all(open.splice(0).map((f) => f.close())); });
async function fixture(password: string, allowForwardOut = false) { const f = await startSshFixture({ password: { user: 'tester', password }, allowForwardOut }); open.push(f); return f; }
function until(s: SshSession, predicate: (text: string) => boolean): Promise<string> {
  let text = '';
  return new Promise((resolve) => { s.onData((d) => { text += Buffer.from(d).toString('utf8'); if (predicate(text)) resolve(text); }); });
}

describe('openSession', () => {
  it('connects with a password, echoes bytes, resizes and reports the exit code', async () => {
    const f = await fixture('pw');
    session = await openSession({ hops: [hop(f.port, 'pw')], cols: 80, rows: 24, verifyHostKey: accept });
    const echoed = until(session, (t) => t.includes('hello'));
    session.write(Buffer.from('hello'));
    expect(await echoed).toContain('hello');
    session.resize(132, 40);
    await new Promise((r) => setTimeout(r, 100));
    expect(f.lastResize).toEqual({ cols: 132, rows: 40 });
    const exit = new Promise<{ code: number | null }>((r) => session!.onExit(r));
    session.write(Buffer.from('exit 3\n'));
    expect((await exit).code).toBe(3);
  });
  it('reports the host key to verifyHostKey and refuses when rejected', async () => {
    const f = await fixture('pw');
    const seen: string[] = [];
    await expect(openSession({ hops: [hop(f.port, 'pw')], cols: 80, rows: 24, verifyHostKey: async (_h, key) => { seen.push(key.fingerprint); return 'reject'; } }))
      .rejects.toMatchObject({ code: 'ssh-host-key-new', details: { host: `127.0.0.1:${f.port}`, fingerprint: f.hostKey.fingerprint } });
    expect(seen).toEqual([f.hostKey.fingerprint]);
  });
  it('a wrong password is ssh-auth-failed and never carries the value', async () => {
    const f = await fixture('pw');
    const error: unknown = await openSession({ hops: [hop(f.port, 'wrong-one')], cols: 80, rows: 24, verifyHostKey: accept }).catch((e) => e);
    expect(error).toMatchObject({ code: 'ssh-auth-failed', details: { method: 'password' } });
    expect(JSON.stringify({ m: (error as Error).message, d: (error as { details: unknown }).details })).not.toContain('wrong-one');
  });
  it('dials through a jump host', async () => {
    const inner = await fixture('in');
    const outer = await fixture('out', true);
    session = await openSession({ hops: [hop(outer.port, 'out'), hop(inner.port, 'in')], cols: 80, rows: 24, verifyHostKey: accept });
    const echoed = until(session, (t) => t.includes('via'));
    session.write(Buffer.from('via'));
    expect(await echoed).toContain('via');
  });
  it('a closed port is ssh-connect-failed naming the hop', async () => {
    await expect(openSession({ hops: [hop(1, 'x')], cols: 80, rows: 24, verifyHostKey: accept }))
      .rejects.toMatchObject({ code: 'ssh-connect-failed', details: { host: '127.0.0.1:1', hop: 0 } });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `nice pnpm vitest run --project ssh-unit --project ssh-integration`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/ssh/src/known-hosts.ts
import { createHash } from 'node:crypto';
export function fingerprintOf(key: Buffer): string { return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`; }
export function keyTypeOf(key: Buffer): string { const len = key.readUInt32BE(0); return key.subarray(4, 4 + len).toString('ascii'); }
const same = (a: KnownHostEntry, b: KnownHostEntry) => a.host === b.host && a.keyType === b.keyType;
export function checkKnownHost(entries, candidate) { const e = entries.find((x) => same(x, candidate)); return !e ? 'new' : e.fingerprint === candidate.fingerprint ? 'known' : 'changed'; }
export function rememberKnownHost(entries, entry) { return [...entries.filter((x) => !same(x, entry)), entry]; }
const isEntry = (v: unknown): v is KnownHostEntry => typeof v === 'object' && v !== null && ['host', 'keyType', 'fingerprint'].every((k) => typeof (v as Record<string, unknown>)[k] === 'string');
export function parseKnownHosts(text: string) { try { const v: unknown = JSON.parse(text.trim() === '' ? '[]' : text); return Array.isArray(v) ? v.filter(isEntry) : []; } catch { return []; } }
export function serializeKnownHosts(entries) { return `${JSON.stringify(entries, null, 2)}\n`; }
```

```ts
// packages/ssh/src/session.ts
import { randomUUID } from 'node:crypto';
import { Client } from 'ssh2';
import type { ClientChannel, ConnectConfig } from 'ssh2';
import { SshModelError } from './errors.js';
import { fingerprintOf, keyTypeOf } from './known-hosts.js';
import type { KnownHostEntry } from './known-hosts.js';

export class SshConnectError extends SshModelError {}
const hostOf = (hop: HopCredentials) => `${hop.address}:${hop.port}`;

function connectHop(hop: HopCredentials, index: number, options: OpenSessionOptions, sock?: NodeJS.ReadableStream): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let rejectedKey: KnownHostEntry | undefined;
    const config: ConnectConfig = {
      host: hop.address, port: hop.port, username: hop.user,
      readyTimeout: hop.connectTimeout * 1000, keepaliveInterval: hop.keepAlive > 0 ? hop.keepAlive * 1000 : 0,
      ...(hop.auth.kind === 'password' ? { password: hop.auth.password } : {}),
      ...(hop.auth.kind === 'key' ? { privateKey: hop.auth.privateKey, ...(hop.auth.passphrase ? { passphrase: hop.auth.passphrase } : {}) } : {}),
      ...(hop.auth.kind === 'agent' ? { agent: hop.auth.socket } : {}),
      ...(sock ? { sock } : {}),
      hostVerifier: (key: Buffer, done: (ok: boolean) => void) => {
        const entry = { host: hostOf(hop), keyType: keyTypeOf(key), fingerprint: fingerprintOf(key) };
        void options.verifyHostKey(hop, entry).then((d) => { if (d === 'reject') rejectedKey = entry; done(d === 'accept'); }, () => { rejectedKey = entry; done(false); });
      },
    };
    client.once('ready', () => resolve(client));
    client.once('error', (error: Error & { level?: string }) => {
      const host = hostOf(hop);
      if (rejectedKey) reject(new SshConnectError('ssh-host-key-new', `${host} presented an untrusted key`, { ...rejectedKey }));
      else if (error.level === 'client-authentication') reject(new SshConnectError('ssh-auth-failed', `${host} refused ${hop.auth.kind} authentication for ${hop.user}`, { host, method: hop.auth.kind }));
      else reject(new SshConnectError('ssh-connect-failed', `${host}: ${error.message}`, { host, hop: index }));
    });
    client.connect(config);
  });
}

function forwardOut(client: Client, next: HopCredentials): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => client.forwardOut('127.0.0.1', 0, next.address, next.port, (err, stream) =>
    err ? reject(new SshConnectError('ssh-connect-failed', `jump to ${hostOf(next)} failed: ${err.message}`, { host: hostOf(next), hop: -1 })) : resolve(stream)));
}

export async function openSession(options: OpenSessionOptions): Promise<SshSession> {
  const clients: Client[] = [];
  const endAll = () => { for (const c of clients) c.end(); };
  try {
    let sock: NodeJS.ReadableStream | undefined;
    for (const [index, hop] of options.hops.entries()) {
      const client = await connectHop(hop, index, options, sock);
      clients.push(client);
      const next = options.hops[index + 1];
      if (next) sock = await forwardOut(client, next);
    }
    const target = clients[clients.length - 1]!;
    const channel = await new Promise<ClientChannel>((resolve, reject) =>
      target.shell({ term: 'xterm-256color', cols: options.cols, rows: options.rows }, (err, ch) => (err ? reject(err) : resolve(ch))));
    return wrap(channel, endAll);
  } catch (error) { endAll(); throw error; }
}

function wrap(channel: ClientChannel, endAll: () => void): SshSession {
  const data = new Set<(d: Uint8Array) => void>();
  const exits = new Set<(e: { code: number | null; signal?: string }) => void>();
  let exited = false;
  const exit = (code: number | null, signal?: string) => { if (exited) return; exited = true; for (const l of exits) l({ code, ...(signal ? { signal } : {}) }); endAll(); };
  channel.on('data', (d: Buffer) => { for (const l of data) l(d); });
  channel.stderr.on('data', (d: Buffer) => { for (const l of data) l(d); });
  channel.on('exit', (code: number | null, signal?: string) => exit(code, signal));
  channel.on('close', () => exit(null));
  return {
    id: randomUUID(),
    write: (d) => { channel.write(Buffer.from(d)); },
    resize: (cols, rows) => { channel.setWindow(rows, cols, 0, 0); },
    close: () => { channel.end(); endAll(); },
    onData: (l) => { data.add(l); return () => { data.delete(l); }; },
    onExit: (l) => { exits.add(l); return () => { exits.delete(l); }; },
  };
}
```

Fixture (`test/helpers/ssh-fixture.ts`): `import { Server, utils } from 'ssh2'`; host key from
`generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } })`;
`hostKey = { host: '127.0.0.1:<port>', keyType: 'ssh-rsa', fingerprint: fingerprintOf(utils.parseKey(privateKey).getPublicSSH()) }`
(set `host` after `listen` reports the port). `authentication`: accept when
`ctx.method === 'password' && ctx.username === user && ctx.password === password`, else `ctx.reject(['password'])`.
`session`: `session.on('pty', (accept, _r, info) => { fixture.lastResize = { cols: info.cols, rows: info.rows }; accept(); })`,
`session.on('window-change', (accept, _r, info) => { fixture.lastResize = { cols: info.cols, rows: info.rows }; accept?.(); })`,
`session.on('shell', (accept) => { const stream = accept(); let line = ''; stream.on('data', (d: Buffer) => { stream.write(d); line += d.toString(); const m = /exit (\d+)\n/.exec(line); if (m) { stream.exit(Number(m[1])); stream.end(); } }); })`.
When `allowForwardOut`: `client.on('tcpip', (accept, _reject, info) => { const s = accept(); const out = net.connect(info.destPort, info.destIP); s.pipe(out).pipe(s); })`.
`listen(0, '127.0.0.1')`; `close()` ends every client and awaits `server.close`.

The fingerprint in the host-key test must equal the fixture's; if `keyTypeOf` reads a different type string
than `utils.parseKey(...).type`, make the fixture compute `keyTypeOf(getPublicSSH())` too, so both sides use
one function.

- [ ] **Step 4: Run the tests**

Run: `nice pnpm vitest run --project ssh-unit --project ssh-integration && nice pnpm --filter @wirebench/ssh typecheck`
Expected: PASS. If ssh2's auth-failure error has no `level === 'client-authentication'`, print the error once,
match on the real property, and keep the assertions.

- [ ] **Step 5: Commit**

```bash
git add packages/ssh
git commit -m "ssh: open a shell over ssh2 through a jump chain, with host-key verification"
```

### Task 11: `SshService`: sessions, ownership, trust, and the channels

**Files:**

- Create: `apps/desktop/src/main/ssh-service.ts` (replaces the Task 8 stub)
- Modify: `apps/desktop/src/shared/ssh-wire.ts`, `apps/desktop/src/shared/ipc.ts`,
  `apps/desktop/src/main/areas/ssh.ts`, `apps/desktop/src/main/index.ts`
- Test: `apps/desktop/test/ssh-service.test.ts`; extend `apps/desktop/test/ipc-ssh.test.ts`

**Interfaces (produces):**

```ts
// wire
sshConnectRequestSchema  = z.object({ hostId: z.string(), cols: z.number().int().positive(), rows: z.number().int().positive() })
sshConnectResponseSchema = z.object({ sessionId: z.string() })
sshWriteRequestSchema    = z.object({ sessionId: z.string(), data: z.string() })      // base64
sshResizeRequestSchema   = z.object({ sessionId: z.string(), cols: z.number().int().positive(), rows: z.number().int().positive() })
sshCloseRequestSchema    = z.object({ sessionId: z.string() })
sshTrustRequestSchema    = z.object({ host: z.string(), keyType: z.string(), fingerprint: z.string(), replace: z.boolean().default(false) })
events.ssh.data  { sessionId, data }  ·  events.ssh.exit { sessionId, code: z.number().nullable(), signal?: z.string() }  ·  events.ssh.state { sessionId, state: 'open' | 'closed' }
// main
export interface SshServiceDeps {
  readonly hosts: Pick<HostsService, 'current' | 'list'>;
  readonly secretsFor: () => GetSecret;              // index.ts: () => secretsFor(undefined)
  readonly knownHostsFile: string;                    // join(userData, 'ssh-known-hosts.json')
  readonly agentSocket: () => string | undefined;
  readonly emit: (target: WebContents, event: IpcEvent<z.ZodType>, payload: unknown) => void;
  readonly open?: typeof openSession;                 // tests inject a fake
}
export class SshService {
  constructor(deps: SshServiceDeps);
  connect(sender: WebContents, request: SshConnectRequest): Promise<{ sessionId: string }>;
  write(sender, request: SshWriteRequest): Promise<void>; resize(sender, request): Promise<void>; close(sender, request): Promise<void>;
  trust(request: SshTrustRequest): Promise<void>;
  disposeAll(): void; disposeFor(sender: WebContents): void;
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/test/ssh-service.test.ts
// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHostsFile } from '@wirebench/ssh';
import { describe, expect, it, vi } from 'vitest';
import { SshService } from '../src/main/ssh-service.js';

const FILE = parseHostsFile(`version: 1\nhosts:\n  - { id: a, name: a, address: 10.0.0.1, ssh: { user: me, auth: { password: '\${secret:a_pw}' } } }\n`);
const KEY = { host: '10.0.0.1:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:k' };
const sender = (id: number) => ({ id, isDestroyed: () => false, once: vi.fn() }) as never;

function fakeSession() {
  const data = new Set<(d: Uint8Array) => void>(); const exit = new Set<(e: { code: number | null }) => void>();
  return {
    session: { id: 's1', write: vi.fn(), resize: vi.fn(), close: vi.fn(), onData: (l: never) => { data.add(l); return () => data.delete(l); }, onExit: (l: never) => { exit.add(l); return () => exit.delete(l); } },
    pushData: (b: Buffer) => { for (const l of data) l(b); },
    pushExit: (code: number) => { for (const l of exit) l({ code }); },
  };
}

function make(opts: { known?: object[]; file?: typeof FILE; secret?: string | undefined } = {}) {
  const knownHostsFile = join(mkdtempSync(join(tmpdir(), 'wb-ssh-')), 'ssh-known-hosts.json');
  if (opts.known) writeFileSync(knownHostsFile, JSON.stringify(opts.known));
  const fake = fakeSession();
  const open = vi.fn(async (options: { hops: unknown[]; verifyHostKey: (h: unknown, k: typeof KEY) => Promise<string> }) => {
    if ((await options.verifyHostKey(options.hops[0], KEY)) === 'reject') throw Object.assign(new Error('rejected'), { name: 'SshModelError', code: 'ssh-host-key-new', details: KEY });
    return fake.session;
  });
  const emit = vi.fn();
  const service = new SshService({
    hosts: { current: () => opts.file ?? FILE, list: () => Promise.reject(new Error('unused')) },
    secretsFor: () => async (ref: string) => (ref === 'secret:a_pw' ? (opts.secret === undefined && !('secret' in opts) ? 'pw' : opts.secret) : undefined),
    knownHostsFile, agentSocket: () => undefined, emit, open: open as never,
  });
  return { service, open, emit, fake, knownHostsFile };
}

describe('SshService', () => {
  it('first contact fails with ssh-host-key-new and the fingerprint, and trusts nothing', async () => {
    const { service, knownHostsFile } = make();
    await expect(service.connect(sender(1), { hostId: 'a', cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'ssh-host-key-new', details: { fingerprint: 'SHA256:k', host: '10.0.0.1:22' } });
    expect(() => readFileSync(knownHostsFile)).toThrow();
  });
  it('a changed key fails with ssh-host-key-changed; trust without replace refuses; replace then connects', async () => {
    const { service, fake, emit } = make({ known: [{ ...KEY, fingerprint: 'SHA256:old' }] });
    const s = sender(1);
    await expect(service.connect(s, { hostId: 'a', cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'ssh-host-key-changed', details: { previous: 'SHA256:old', fingerprint: 'SHA256:k' } });
    await expect(service.trust({ ...KEY, replace: false })).rejects.toMatchObject({ code: 'ssh-host-key-changed' });
    await service.trust({ ...KEY, replace: true });
    const { sessionId } = await service.connect(s, { hostId: 'a', cols: 80, rows: 24 });
    fake.pushData(Buffer.from('hi'));
    expect(emit).toHaveBeenCalledWith(s, expect.objectContaining({ name: 'ssh.data' }), { sessionId, data: Buffer.from('hi').toString('base64') });
  });
  it('resolves the secret into openSession and never into the result', async () => {
    const { service, open } = make({ known: [KEY] });
    const result = await service.connect(sender(1), { hostId: 'a', cols: 80, rows: 24 });
    expect(open.mock.calls[0]![0].hops[0]).toMatchObject({ address: '10.0.0.1', port: 22, user: 'me', auth: { kind: 'password', password: 'pw' }, keepAlive: 15, connectTimeout: 20 });
    expect(JSON.stringify(result)).not.toContain('pw');
  });
  it('a missing secret is secret-missing with the name, before any connection', async () => {
    const { service, open } = make({ known: [KEY], secret: undefined });
    await expect(service.connect(sender(1), { hostId: 'a', cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'secret-missing' });
    expect(open).not.toHaveBeenCalled();
  });
  it('write/resize/close refuse another sender; exit emits ssh.exit and frees the id', async () => {
    const { service, fake, emit } = make({ known: [KEY] });
    const s = sender(1);
    const { sessionId } = await service.connect(s, { hostId: 'a', cols: 80, rows: 24 });
    await expect(service.write(sender(2), { sessionId, data: 'aGk=' })).rejects.toMatchObject({ code: 'ssh-session-unknown' });
    await service.write(s, { sessionId, data: 'aGk=' });
    expect(fake.session.write).toHaveBeenCalledWith(Buffer.from('hi'));
    fake.pushExit(0);
    expect(emit).toHaveBeenCalledWith(s, expect.objectContaining({ name: 'ssh.exit' }), { sessionId, code: 0 });
    await expect(service.write(s, { sessionId, data: 'aGk=' })).rejects.toMatchObject({ code: 'ssh-session-unknown' });
    await service.close(s, { sessionId }); // idempotent after exit
  });
  it('an incomplete host is refused before any connection', async () => {
    const bare = parseHostsFile(`version: 1\nhosts:\n  - { id: b, name: b, address: x }\n`);
    const { service, open } = make({ file: bare });
    await expect(service.connect(sender(1), { hostId: 'b', cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'ssh-host-incomplete', details: { field: 'user' } });
    expect(open).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/ssh-service.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/ssh-service.ts
import { readFile } from 'node:fs/promises';
import type { WebContents } from 'electron';
import { WirebenchError, nodeFs, writeFileAtomic } from '@wirebench/engine';
import type { GetSecret } from '@wirebench/engine';
import { SshModelError, checkKnownHost, jumpChain, openSession, parseKnownHosts, rememberKnownHost, secretNameOf, serializeKnownHosts } from '@wirebench/ssh';
import type { HopCredentials, KnownHostEntry, ResolvedHost, SshSession } from '@wirebench/ssh';
import { events } from '../shared/ipc.js';
import type { SshConnectRequest, SshTrustRequest } from '../shared/ssh-wire.js';

interface Live { readonly session: SshSession; readonly sender: WebContents; readonly stop: () => void }

export class SshService {
  private readonly live = new Map<string, Live>();
  constructor(private readonly deps: SshServiceDeps) {}

  async connect(sender: WebContents, request: SshConnectRequest): Promise<{ sessionId: string }> {
    let file = this.deps.hosts.current();
    if (!file) { await this.deps.hosts.list(); file = this.deps.hosts.current(); }
    if (!file) throw new WirebenchError('workspace-not-open', 'Open a workspace first');
    const chain = jumpChain(file, request.hostId);
    for (const hop of chain) {
      if (hop.incomplete) throw new WirebenchError('ssh-host-incomplete', `${hop.name} has no ${hop.incomplete.field}; set it on the host or one of its groups`, { details: { hostId: hop.id, field: hop.incomplete.field } });
    }
    const hops = await this.credentialsFor(chain);
    const known = await this.readKnownHosts();
    let changed: { entry: KnownHostEntry; previous: string } | undefined;
    const session = await (this.deps.open ?? openSession)({
      hops, cols: request.cols, rows: request.rows,
      verifyHostKey: async (_hop, key) => {
        const check = checkKnownHost(known, key);
        if (check === 'known') return 'accept';
        if (check === 'changed') changed = { entry: key, previous: known.find((e) => e.host === key.host && e.keyType === key.keyType)!.fingerprint };
        return 'reject';
      },
    }).catch((error: unknown) => {
      const code = (error as { code?: string }).code;
      if (changed && code === 'ssh-host-key-new') throw new WirebenchError('ssh-host-key-changed', `${changed.entry.host} presented a different key than before`, { details: { ...changed.entry, previous: changed.previous } });
      if (error instanceof SshModelError || (typeof code === 'string' && code.startsWith('ssh-'))) throw new WirebenchError(code!, (error as Error).message, { details: (error as { details?: Record<string, unknown> }).details ?? {} });
      throw error;
    });
    const sessionId = session.id;
    const offData = session.onData((data) => this.deps.emit(sender, events.ssh.data, { sessionId, data: Buffer.from(data).toString('base64') }));
    const offExit = session.onExit((exit) => { this.deps.emit(sender, events.ssh.exit, { sessionId, ...exit }); this.drop(sessionId); });
    sender.once('destroyed', () => this.disposeFor(sender));
    this.live.set(sessionId, { session, sender, stop: () => { offData(); offExit(); } });
    this.deps.emit(sender, events.ssh.state, { sessionId, state: 'open' });
    return { sessionId };
  }

  async write(sender: WebContents, r: { sessionId: string; data: string }): Promise<void> { this.owned(sender, r.sessionId).session.write(Buffer.from(r.data, 'base64')); }
  async resize(sender: WebContents, r: { sessionId: string; cols: number; rows: number }): Promise<void> { this.owned(sender, r.sessionId).session.resize(r.cols, r.rows); }
  async close(sender: WebContents, r: { sessionId: string }): Promise<void> {
    const live = this.live.get(r.sessionId);
    if (!live || live.sender.id !== sender.id) return;
    live.session.close(); this.drop(r.sessionId);
  }

  async trust(request: SshTrustRequest): Promise<void> {
    const known = await this.readKnownHosts();
    const entry = { host: request.host, keyType: request.keyType, fingerprint: request.fingerprint };
    if (checkKnownHost(known, entry) === 'changed' && !request.replace) throw new WirebenchError('ssh-host-key-changed', `${request.host} already has a different key; replacing it needs confirmation`, { details: entry });
    await writeFileAtomic(nodeFs, this.deps.knownHostsFile, serializeKnownHosts(rememberKnownHost(known, entry)));
  }

  disposeAll(): void { for (const [id, live] of [...this.live]) { live.session.close(); this.drop(id); } }
  disposeFor(sender: WebContents): void { for (const [id, live] of [...this.live]) if (live.sender.id === sender.id) { live.session.close(); this.drop(id); } }

  private owned(sender: WebContents, sessionId: string): Live {
    const live = this.live.get(sessionId);
    if (!live || live.sender.id !== sender.id) throw new WirebenchError('ssh-session-unknown', 'No such session');
    return live;
  }
  private drop(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    live.stop(); this.live.delete(sessionId);
    if (!live.sender.isDestroyed()) this.deps.emit(live.sender, events.ssh.state, { sessionId, state: 'closed' });
  }
  private async readKnownHosts(): Promise<readonly KnownHostEntry[]> {
    try { return parseKnownHosts(await readFile(this.deps.knownHostsFile, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  private async credentialsFor(chain: readonly ResolvedHost[]): Promise<HopCredentials[]> {
    const getSecret = this.deps.secretsFor();
    const value = async (token: string) => {
      const name = secretNameOf(token);
      const v = await getSecret(`secret:${name}`);
      if (v === undefined) throw new WirebenchError('secret-missing', `Secret "${name}" is not set`, { details: { ref: `secret:${name}`, name } });
      return v;
    };
    return Promise.all(chain.map(async (hop) => {
      const auth = hop.ssh.auth.value!;
      const credentials =
        auth.kind === 'password' ? { kind: 'password' as const, password: await value(auth.password) }
        : auth.kind === 'key' ? { kind: 'key' as const, privateKey: await value(auth.key), ...(auth.passphrase ? { passphrase: await value(auth.passphrase) } : {}) }
        : { kind: 'agent' as const, socket: this.requireAgent() };
      return { address: hop.address, port: hop.ssh.port.value, user: hop.ssh.user.value!, auth: credentials, keepAlive: hop.ssh.keepAlive.value, connectTimeout: hop.ssh.connectTimeout.value };
    }));
  }
  private requireAgent(): string {
    const socket = this.deps.agentSocket();
    if (!socket) throw new WirebenchError('ssh-auth-failed', 'No SSH agent is running (SSH_AUTH_SOCK is unset)', { details: { method: 'agent' } });
    return socket;
  }
}
```

Check the engine's `secret-missing` error shape (`resolveSecretTokens` in `packages/engine/src/secrets/resolve.ts`)
and the pseudo-ref form (`secretPseudoRef(name)` in `secret-token.ts`); use those exports instead of the
literal `secret:${name}` string.

`areas/ssh.ts` adds `registerHandler(channels.ssh.connect, (r, sender) => deps.ssh.connect(sender, r))` and
the same for `write`, `resize`, `close`; `registerHandler(channels.ssh.trustHostKey, (r) => deps.ssh.trust(r))`.
`index.ts`: `const sshService = new SshService({ hosts: hostsService, secretsFor: () => secretsFor(undefined), knownHostsFile: join(app.getPath('userData'), 'ssh-known-hosts.json'), agentSocket: () => (process.platform === 'win32' ? 'pageant' : process.env['SSH_AUTH_SOCK']), emit: emitEvent });`
`sshService.disposeAll()` inside `hooks.onChanged` and in `app.on('before-quit')`. `ipc-ssh.test.ts` gains one
case per channel asserting the sender object is forwarded as the first argument.

- [ ] **Step 4: Run tests, typecheck, check**

Run: `nice pnpm vitest run --project desktop && WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/desktop
git commit -m "desktop: ssh sessions live in main, owned by the window that opened them"
```

### Task 12: The trust prompt and the `ssh.connect` command

**Files:**

- Create: `apps/desktop/src/renderer/features/ssh/connect.ts`, `trust-dialog.tsx`
- Modify: `hosts-store.ts` (`sessions`, `trustPrompt`, `setSession`, `setTrustPrompt`),
  `register-ssh-commands.ts` (`ssh.connect`), `shared/commands.ts`, `shared/command-catalog.ts`,
  `host-tree.tsx` (double-click/Enter and a Connect menu item run `ssh.connect`; status dot from `sessions`),
  `hosts-view.tsx` (mount `<TrustDialog />`)
- Test: `apps/desktop/test/renderer/ssh-connect.test.ts`, `apps/desktop/test/renderer/trust-dialog.test.tsx`

**Interfaces (produces):**

```ts
// hosts-store.ts additions
sessions: Readonly<Record<string, { sessionId?: string; state: 'connecting' | 'open' | 'closed' }>>;
trustPrompt: { hostId: string; size: { cols: number; rows: number }; host: string; keyType: string; fingerprint: string; previous?: string } | null;
setSession(hostId: string, session: HostsState['sessions'][string] | undefined): void;
setTrustPrompt(prompt: HostsState['trustPrompt']): void;
// connect.ts
export function connectToHost(hostId: string, size: { cols: number; rows: number }): Promise<{ sessionId: string } | undefined>;
export function confirmTrust(replace: boolean): Promise<{ sessionId: string } | undefined>;
```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/test/renderer/ssh-connect.test.ts
import { beforeEach, expect, it, vi } from 'vitest';
const connect = vi.fn(); const trustHostKey = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({ ipc: () => ({ ssh: { connect, trustHostKey } }) }));
import { confirmTrust, connectToHost } from '../../src/renderer/features/ssh/connect.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
beforeEach(() => { useHostsStore.setState({ sessions: {}, trustPrompt: null }); connect.mockReset(); trustHostKey.mockReset(); });

it('a new host key opens the trust prompt; confirming trusts then connects', async () => {
  connect.mockResolvedValueOnce({ ok: false, error: { code: 'ssh-host-key-new', message: 'untrusted', details: { host: 'h:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:k' } } });
  expect(await connectToHost('a', { cols: 80, rows: 24 })).toBeUndefined();
  expect(useHostsStore.getState().trustPrompt).toMatchObject({ hostId: 'a', fingerprint: 'SHA256:k' });
  expect(useHostsStore.getState().trustPrompt?.previous).toBeUndefined();
  trustHostKey.mockResolvedValueOnce({ ok: true, value: undefined });
  connect.mockResolvedValueOnce({ ok: true, value: { sessionId: 's1' } });
  expect(await confirmTrust(false)).toEqual({ sessionId: 's1' });
  expect(trustHostKey).toHaveBeenCalledWith({ host: 'h:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:k', replace: false });
  expect(useHostsStore.getState().trustPrompt).toBeNull();
  expect(useHostsStore.getState().sessions['a']).toEqual({ sessionId: 's1', state: 'open' });
});
it('a changed key carries the previous fingerprint', async () => {
  connect.mockResolvedValueOnce({ ok: false, error: { code: 'ssh-host-key-changed', message: 'changed', details: { host: 'h:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:k', previous: 'SHA256:old' } } });
  await connectToHost('a', { cols: 80, rows: 24 });
  expect(useHostsStore.getState().trustPrompt?.previous).toBe('SHA256:old');
});
it('any other error clears the connecting state and records a problem', async () => {
  connect.mockResolvedValueOnce({ ok: false, error: { code: 'ssh-auth-failed', message: 'nope' } });
  await connectToHost('a', { cols: 80, rows: 24 });
  expect(useHostsStore.getState().sessions['a']).toBeUndefined();
});
```

`trust-dialog.test.tsx`: with `trustPrompt.previous` undefined the dialog shows the fingerprint and a button
"Trust and connect"; with `previous` set it shows both fingerprints, the words "has changed", and the button
"Replace key and connect" stays disabled until the checkbox "I understand the key changed" is ticked.

- [ ] **Step 2: Run them to see them fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/ssh-connect.test.ts apps/desktop/test/renderer/trust-dialog.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// connect.ts
export async function connectToHost(hostId, size) {
  const store = useHostsStore.getState();
  store.setSession(hostId, { state: 'connecting' });
  const result = await ipc().ssh.connect({ hostId, ...size });
  if (result.ok) { store.setSession(hostId, { sessionId: result.value.sessionId, state: 'open' }); return result.value; }
  store.setSession(hostId, undefined);
  const { code, message, details } = result.error;
  if ((code === 'ssh-host-key-new' || code === 'ssh-host-key-changed') && details) {
    store.setTrustPrompt({ hostId, size, host: String(details['host']), keyType: String(details['keyType']), fingerprint: String(details['fingerprint']), ...(typeof details['previous'] === 'string' ? { previous: details['previous'] } : {}) });
    return undefined;
  }
  useProblemsStore.getState().add([{ groupId: `ssh:${hostId}`, source: 'hosts', severity: 'error', problem: { code, message } }]);
  return undefined;
}
export async function confirmTrust(replace) {
  const prompt = useHostsStore.getState().trustPrompt;
  if (!prompt) return undefined;
  useHostsStore.getState().setTrustPrompt(null);
  const trusted = await ipc().ssh.trustHostKey({ host: prompt.host, keyType: prompt.keyType, fingerprint: prompt.fingerprint, replace });
  if (!trusted.ok) { useProblemsStore.getState().add([{ groupId: `ssh:${prompt.hostId}`, source: 'hosts', severity: 'error', problem: { code: trusted.error.code, message: trusted.error.message } }]); return undefined; }
  return connectToHost(prompt.hostId, prompt.size);
}
```

`TrustDialog` (Radix AlertDialog): reads `trustPrompt`; Cancel → `setTrustPrompt(null)`; confirm →
`confirmTrust(previous !== undefined)`. `ssh.connect` command: `run: (_ctx, arg) => { if (typeof arg === 'string') void connectToHost(arg, { cols: 80, rows: 24 }); }`
(Task 13 routes it through the terminal tab). Catalog: `{ id: 'ssh.connect', label: 'Connect to Host', category: 'Hosts' }`.
Status dot in `host-tree.tsx`: grey idle, amber connecting, green open.

- [ ] **Step 4: Run tests, typecheck, check**

Run: `nice pnpm vitest run --project desktop && pnpm docs:commands && WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit and open PR 3**

```bash
git add -A apps/desktop docs
git commit -m "desktop: trust a host key on first use with an explicit click"
```

PR title: `ssh: sessions, known hosts and the trust prompt (#316, 3/5)`.

---

## PR 4 — The terminal

### Task 13: The terminal tab

**Files:**

- Modify: `apps/desktop/package.json` (devDependencies `@xterm/xterm`, `@xterm/addon-fit`,
  `@xterm/addon-web-links`, exact pins; add the three to `BUNDLED_DEV_DEPENDENCIES` in
  `scripts/third-party-licenses.ts:36-58`)
- Create: `apps/desktop/src/renderer/features/ssh/terminal-session.ts`, `terminal-tab.tsx`
- Modify: `apps/desktop/src/renderer/state/editors.ts` (`EditorTab.kind` gains `'ssh-terminal'`, field
  `hostId?: string`; **not** added to `PERSISTED_TAB_KINDS` in `ui-state.ts`),
  `apps/desktop/src/renderer/shell/editor-area.tsx` (lazy `TerminalTab` branch),
  `connect.ts` (`openTerminalFor(hostId)`), `register-ssh-commands.ts` (`ssh.connect` → `openTerminalFor`),
  `hosts-store.ts` (`reconnectNonce: Record<hostId, number>`, `bumpReconnect(hostId)`),
  `app-shell.tsx` (`subscribeToSshEvents()`)
- Test: `apps/desktop/test/renderer/terminal-session.test.ts`, `apps/desktop/test/renderer/editors-ssh-tab.test.ts`

**Interfaces (produces):**

```ts
// terminal-session.ts
export function bytesToBase64(bytes: Uint8Array): string; export function base64ToBytes(text: string): Uint8Array;
export function attachTerminal(sessionId: string, handlers: { write(data: Uint8Array): void; exit(code: number | null): void }): void;
export function detachTerminal(sessionId: string): void;
export function subscribeToSshEvents(): () => void;       // window.wirebench.on('ssh.data'|'ssh.exit'|'ssh.state')
export function __dispatchForTest(name: 'ssh.data' | 'ssh.exit', payload: unknown): void;
// Data that arrives before attach is buffered (≤ 1 MiB, oldest dropped) and replayed on attach.
// connect.ts
export function openTerminalFor(hostId: string): void;    // opens/activates tab `ssh:${hostId}`; the tab connects itself
```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/test/renderer/terminal-session.test.ts
import { expect, it, vi } from 'vitest';
import { __dispatchForTest as dispatch, attachTerminal, bytesToBase64, detachTerminal } from '../../src/renderer/features/ssh/terminal-session.js';

it('buffers data before attach, streams after, and forwards exit', () => {
  dispatch('ssh.data', { sessionId: 's', data: bytesToBase64(new Uint8Array([97, 98])) });
  const write = vi.fn(); const exit = vi.fn();
  attachTerminal('s', { write, exit });
  expect(write).toHaveBeenCalledWith(new Uint8Array([97, 98]));
  dispatch('ssh.data', { sessionId: 's', data: bytesToBase64(new Uint8Array([99])) });
  expect(write).toHaveBeenLastCalledWith(new Uint8Array([99]));
  dispatch('ssh.exit', { sessionId: 's', code: 0 });
  expect(exit).toHaveBeenCalledWith(0);
  detachTerminal('s');
  expect(() => dispatch('ssh.data', { sessionId: 's', data: 'ZA==' })).not.toThrow();
});
it('base64 round-trips UTF-8 input', () => {
  const bytes = new TextEncoder().encode('ls -la ✓');
  expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
});
```

```ts
// apps/desktop/test/renderer/editors-ssh-tab.test.ts — use the persisted-ui helpers ui-state.ts already tests
it('an ssh-terminal tab is not persisted', () => {
  const persisted = persistTabsForTest([{ id: 'ssh:a', kind: 'ssh-terminal', title: 'a', hostId: 'a' }, { id: 'r1', kind: 'request', title: 'r', requestId: 'r1' }]);
  expect(persisted.map((t) => t.kind)).toEqual(['request']);
});
```

(Find the function `ui-state.ts` uses to turn `EditorTab[]` into `PersistedTab[]` and call it; if it is
module-private, export it with a `__forTest` alias as the file already does for similar helpers, or test
through `readTab`.)

- [ ] **Step 2: Run them to see them fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/terminal-session.test.ts apps/desktop/test/renderer/editors-ssh-tab.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// terminal-session.ts
const attached = new Map<string, { write(d: Uint8Array): void; exit(code: number | null): void }>();
const pending = new Map<string, { chunks: Uint8Array[]; bytes: number; exit?: number | null }>();
const LIMIT = 1024 * 1024;
export const bytesToBase64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(''));
export const base64ToBytes = (t: string) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
function onData(sessionId: string, data: Uint8Array) {
  const handler = attached.get(sessionId);
  if (handler) { handler.write(data); return; }
  const p = pending.get(sessionId) ?? { chunks: [], bytes: 0 };
  p.chunks.push(data); p.bytes += data.length;
  while (p.bytes > LIMIT && p.chunks.length) p.bytes -= p.chunks.shift()!.length;
  pending.set(sessionId, p);
}
function onExit(sessionId: string, code: number | null) {
  const handler = attached.get(sessionId);
  if (handler) { handler.exit(code); return; }
  const p = pending.get(sessionId) ?? { chunks: [], bytes: 0 };
  p.exit = code; pending.set(sessionId, p);
}
export function attachTerminal(sessionId, handlers) {
  attached.set(sessionId, handlers);
  const p = pending.get(sessionId);
  if (p) { for (const c of p.chunks) handlers.write(c); if (p.exit !== undefined) handlers.exit(p.exit); pending.delete(sessionId); }
}
export function detachTerminal(sessionId) { attached.delete(sessionId); pending.delete(sessionId); }
export function __dispatchForTest(name, payload) {
  const p = payload as { sessionId: string; data?: string; code?: number | null };
  if (name === 'ssh.data') onData(p.sessionId, base64ToBytes(p.data!)); else onExit(p.sessionId, p.code ?? null);
}
export function subscribeToSshEvents(): () => void {
  const offs = [
    window.wirebench.on('ssh.data', ((p: { sessionId: string; data: string }) => onData(p.sessionId, base64ToBytes(p.data))) as (payload: unknown) => void),
    window.wirebench.on('ssh.exit', ((p: { sessionId: string; code: number | null }) => onExit(p.sessionId, p.code)) as (payload: unknown) => void),
    window.wirebench.on('ssh.state', ((p: { sessionId: string; state: 'open' | 'closed' }) => useHostsStore.getState().noteSessionState(p.sessionId, p.state)) as (payload: unknown) => void),
  ];
  return () => { for (const off of offs) off(); };
}
```

(`noteSessionState` marks the host whose `sessions[hostId].sessionId === sessionId` as `closed` on
`'closed'`; add it to the store.)

```tsx
// terminal-tab.tsx
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { ipc } from '../../state/ipc-client.js';
import { connectToHost } from './connect.js';
import { useHostsStore } from './hosts-store.js';
import { attachTerminal, bytesToBase64, detachTerminal } from './terminal-session.js';
import { themeFromCss } from './terminal-theme.js';

export function TerminalTab({ hostId }: { readonly hostId: string }) {
  const holder = useRef<HTMLDivElement>(null);
  const nonce = useHostsStore((s) => s.reconnectNonce[hostId] ?? 0);
  const [ended, setEnded] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    setEnded(undefined);
    const term = new Terminal({ cursorBlink: true, fontFamily: 'var(--font-mono)', fontSize: 13, theme: themeFromCss() });
    const fit = new FitAddon();
    term.loadAddon(fit); term.loadAddon(new WebLinksAddon());
    term.open(holder.current!); fit.fit();
    let sessionId: string | undefined;
    let disposed = false;
    void connectToHost(hostId, { cols: term.cols, rows: term.rows }).then((result) => {
      if (!result || disposed) return;
      sessionId = result.sessionId;
      attachTerminal(sessionId, { write: (d) => term.write(d), exit: (code) => setEnded(code) });
      term.focus();
    });
    const input = term.onData((text) => { if (sessionId) void ipc().ssh.write({ sessionId, data: bytesToBase64(new TextEncoder().encode(text)) }); });
    const observer = new ResizeObserver(() => { fit.fit(); if (sessionId) void ipc().ssh.resize({ sessionId, cols: term.cols, rows: term.rows }); });
    observer.observe(holder.current!);
    return () => {
      disposed = true; observer.disconnect(); input.dispose();
      if (sessionId) { detachTerminal(sessionId); void ipc().ssh.close({ sessionId }); }
      term.dispose();
    };
  }, [hostId, nonce]);

  return (
    <div className="flex h-full flex-col">
      <div ref={holder} className="min-h-0 flex-1 p-2" data-testid="ssh-terminal" />
      {ended !== undefined ? (
        <div className="flex items-center gap-3 border-t border-border px-3 py-2 text-sm">
          <span>Session ended{ended === null ? '' : ` (code ${ended})`}</span>
          <button type="button" className="…" onClick={() => useHostsStore.getState().bumpReconnect(hostId)}>Reconnect</button>
        </div>
      ) : null}
    </div>
  );
}
```

`terminal-theme.ts`: `themeFromCss()` reads the app's colour tokens with
`getComputedStyle(document.documentElement).getPropertyValue(...)` — find the token names in the renderer's
stylesheet (`grep -rn "^\s*--color" apps/desktop/src/renderer/*.css`) and map background, foreground,
cursor, selection and the 16 ANSI colours (fall back to xterm defaults for ANSI colours the theme does not
define). `connect.ts`: `openTerminalFor(hostId)` looks up the host name in `useHostsStore` and calls
`useEditorsStore.getState().open({ id: \`ssh:${hostId}\`, kind: 'ssh-terminal', title: name, hostId })`
(check in `editors.ts` whether `open` activates an existing id; if it replaces, call `activate(id)` when the
tab exists). `ssh.connect` now calls `openTerminalFor`. `editor-area.tsx`: add the lazy import of
`TerminalTab` and the branch `activeTab.kind === 'ssh-terminal' && activeTab.hostId !== undefined ? <Suspense …><TerminalTab key={activeTab.hostId} hostId={activeTab.hostId} /></Suspense>`
before the `requestId` fallback. `app-shell.tsx`: `useEffect(() => subscribeToSshEvents(), [])`.

- [ ] **Step 4: Run tests, typecheck, check**

Run: `pnpm install && nice pnpm vitest run --project desktop && nice pnpm licenses:third-party && WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: PASS; `THIRD-PARTY-LICENSES.md` lists the xterm packages.

- [ ] **Step 5: Commit**

```bash
git add -A apps/desktop scripts/third-party-licenses.ts THIRD-PARTY-LICENSES.md pnpm-lock.yaml
git commit -m "desktop: an xterm tab drives an ssh session"
```

### Task 14: Paste guard, palette and quick-open entries

**Files:**

- Create: `apps/desktop/src/renderer/features/ssh/paste-guard.ts`, `paste-dialog.tsx`
- Modify: `terminal-tab.tsx` (paste interception), `apps/desktop/src/renderer/shell/command-palette.tsx`
  (`PaletteMode` gains `'hosts'`; host entries appended in `'quick-open'`), `shell/quick-open.ts`
  (`QuickOpenEntry.kind` gains `'host'`, field `hostId?`, `quickOpenHostEntries()`),
  `register-ssh-commands.ts` (`ssh.connectPalette`), `shared/commands.ts`, `shared/command-catalog.ts`,
  the preferences service + dialog (`terminal.confirmMultilinePaste: boolean`, default `true`; follow how an
  existing boolean preference is declared, stored and rendered)
- Test: `apps/desktop/test/renderer/paste-guard.test.ts`, `apps/desktop/test/renderer/quick-open-hosts.test.ts`

**Interfaces (produces):**

```ts
export function guardPaste(text: string, prefs: { confirmMultilinePaste: boolean }): 'send' | 'ask';
export function quickOpenHostEntries(resolved: readonly ResolvedHostWire[]): readonly QuickOpenEntry[];
// entry: { key: `host:${id}`, kind: 'host', label: name, detail: `${address} · ${path.join('/')}`, value: [name, address, ...path, ...tags].join(' '), hostId: id }
```

- [ ] **Step 1: Write the failing tests**

```ts
// paste-guard.test.ts
import { expect, it } from 'vitest';
import { guardPaste } from '../../src/renderer/features/ssh/paste-guard.js';
it('asks for multi-line text only when the preference is on; one trailing newline is fine', () => {
  expect(guardPaste('ls\n', { confirmMultilinePaste: true })).toBe('send');
  expect(guardPaste('ls\nrm -rf /tmp/x\n', { confirmMultilinePaste: true })).toBe('ask');
  expect(guardPaste('ls\nrm -rf /tmp/x\n', { confirmMultilinePaste: false })).toBe('send');
  expect(guardPaste('a\rb', { confirmMultilinePaste: true })).toBe('ask');
});
// quick-open-hosts.test.ts
import { expect, it } from 'vitest';
import { quickOpenHostEntries } from '../../src/renderer/shell/quick-open.js';
it('matches on name, address, path and tags', () => {
  const [entry] = quickOpenHostEntries([{ id: 'a', name: 'api-1', address: '10.0.1.5', tags: ['prod'], path: ['prod', 'eu'], ssh: {} as never }]);
  expect(entry).toMatchObject({ kind: 'host', hostId: 'a', label: 'api-1', detail: '10.0.1.5 · prod/eu' });
  expect(entry!.value).toContain('prod');
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/paste-guard.test.ts apps/desktop/test/renderer/quick-open-hosts.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// paste-guard.ts
export function guardPaste(text, prefs) {
  if (!prefs.confirmMultilinePaste) return 'send';
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return /[\r\n]/.test(body) ? 'ask' : 'send';
}
```

In `terminal-tab.tsx`, add a capture-phase `paste` listener on the holder: read
`event.clipboardData?.getData('text') ?? ''`; when `guardPaste(text, prefs) === 'ask'`, `preventDefault()`,
`stopPropagation()`, and open `PasteDialog` with the first five lines, a "Don't ask again" checkbox (writes the
preference through the existing preferences channel) and buttons Paste / Cancel; Paste sends the text with
`ssh.write`. Otherwise let xterm handle the paste.

Palette: `PaletteMode = 'commands' | 'quick-open' | 'hosts'`; in `'hosts'` mode render one
`Command.Group heading="Hosts"` from `quickOpenHostEntries(useHostsStore((s) => s.resolved))`, select →
`openTerminalFor(entry.hostId)`; in `'quick-open'` mode append the same group after the existing ones.
`ssh.connectPalette` runs `openPalette('hosts')`; catalog `{ id: 'ssh.connectPalette', label: 'Connect to Host…', category: 'Hosts', shortcut: 'Mod+Shift+H' }`
(grep the catalog for `Mod+Shift+H` first; pick a free chord if taken). `registerShellCommands` must pass
`openPalette` to the ssh `registerCommands` — extend `RendererArea.registerCommands` to
`(openPalette: (mode?: PaletteMode) => void) => void` and update the call in `register-shell-commands.ts`.

- [ ] **Step 4: Run tests, typecheck, check**

Run: `nice pnpm vitest run --project desktop && pnpm docs:commands && WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/desktop docs
git commit -m "desktop: connect to a host from the palette and quick-open; guard multi-line paste"
```

### Task 15: End-to-end proof

**Files:**

- Modify: `packages/ssh/test/helpers/index.ts` (export `startSshFixture`), `e2e/package.json`
  (`"@wirebench/ssh": "workspace:*"` in devDependencies)
- Create: `e2e/specs/ssh-terminal.spec.ts`; add `setSecret(page, name, value)` to the e2e helpers if no
  helper already drives the secrets dialog (read `e2e/specs/secret-sources.spec.ts` and `e2e/helpers/` first)

- [ ] **Step 1: Write the spec**

```ts
// e2e/specs/ssh-terminal.spec.ts
import { expect, test } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSshFixture } from '@wirebench/ssh/test-helpers';
import type { SshFixture } from '@wirebench/ssh/test-helpers';
import { launchApp } from '../helpers/launch-app.js';
import type { LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace, setSecret } from '../helpers/workspace.js'; // real names from e2e/helpers

let launched: LaunchedApp | undefined; let fixture: SshFixture | undefined;
test.afterEach(async () => { await launched?.close(); await fixture?.close(); launched = undefined; fixture = undefined; });

test('connect to a host, trust its key, type, see the echo, end the session', async () => {
  test.setTimeout(180_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' } });
  launched = await launchApp({ userDataDir: mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-')), keepUserDataDir: true });
  const page = launched.window;
  await createWorkspace(page, 'Ops');
  await setSecret(page, 'box_pw', 'pw');

  await page.getByTestId('activity-hosts').click();
  await page.getByRole('button', { name: 'New host' }).click();
  await page.getByLabel('Name').fill('box');
  await page.getByLabel('Address').fill('127.0.0.1');
  await page.getByRole('switch', { name: 'Override Port' }).click();
  await page.getByLabel('Port').fill(String(fixture.port));
  await page.getByRole('switch', { name: 'Override User' }).click();
  await page.getByLabel('User').fill('tester');
  await page.getByRole('radio', { name: 'Password' }).check();
  await page.getByLabel('Secret').selectOption('box_pw');
  await page.getByRole('button', { name: 'Save' }).click();

  await page.getByText('box', { exact: true }).dblclick();
  await expect(page.getByText(fixture.hostKey.fingerprint)).toBeVisible();
  await page.getByRole('button', { name: 'Trust and connect' }).click();

  const terminal = page.getByTestId('ssh-terminal');
  await expect(terminal.locator('.xterm')).toBeVisible();
  await terminal.click();
  await page.keyboard.type('echo hi');
  await expect(terminal).toContainText('echo hi');
  await page.keyboard.type('exit 0\n');
  await expect(page.getByText('Session ended (code 0)')).toBeVisible();
});

test('WIREBENCH_AREAS=ssh=off hides the area and its commands', async () => {
  launched = await launchApp({ extraEnv: { WIREBENCH_AREAS: 'ssh=off' } });
  const page = launched.window;
  await createWorkspace(page, 'Quiet');
  await expect(page.getByTestId('activity-hosts')).toHaveCount(0);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.getByPlaceholder(/command/i).fill('Connect to Host');
  await expect(page.getByRole('option', { name: /Connect to Host/ })).toHaveCount(0);
});
```

- [ ] **Step 2: Run the e2e in CI**

Do not run Electron e2e on the owner's machine. Push the branch; CI runs `pnpm build && xvfb-run -a pnpm test:e2e`.
Expected: both tests PASS. Fix selectors against the real markup if they fail; keep the assertions.

- [ ] **Step 3: Commit and open PR 4**

```bash
git add e2e packages/ssh pnpm-lock.yaml
git commit -m "e2e: open a terminal to a fixture ssh server and switch the area off"
```

PR title: `ssh: terminal tab, palette entries and e2e (#316, 4/5)`.

---

## PR 5 — Docs

### Task 16: Docs page, ADR, spec status

**Files:**

- Create: `docs/adr/0021-a-desktop-area-is-a-module-behind-one-interface.md`
- Create: the docs-site page (find the folder and frontmatter convention in `docs-site/`; copy the shape of
  the secret-sources page)
- Modify: `docs/architecture/` (a short note on area modules and `shared/area-module.ts`),
  `docs/specs/2026-10-08-ssh-area-design.md` (Status → "shipped <merge date>"), `docs/roadmap.md` if it
  lists areas

- [ ] **Step 1: Write the ADR**: status accepted, date = merge date; context = the hardcoded rail and
  sidebar chain; decision = `AreaModule`, static `AREAS`, feature switch through `createFeatureSet`,
  `@internal`; consequences = a new area touches no shell file, later slices extend the module, a loadable
  plugin API stays out of scope.
- [ ] **Step 2: Write the docs page**: `hosts.yaml` with the spec's example, inheritance and the
  "from <group>" display, `${secret:NAME}` only, host keys (first use, changed), `WIREBENCH_AREAS`, what is
  not in this slice. No product names.
- [ ] **Step 3: Run the doc gates and commit**

```bash
nice pnpm check:docs
git add docs docs-site
git commit -m "docs: hosts and terminals, and the area-module ADR"
```

PR title: `docs: SSH area slice 1 (#316, 5/5)`. After merge: close #316 (board → Done) and file follow-up
issues: audit action `desktop.ssh_session` (A1); S2 snippets spec; S3 SFTP spec; S4 forwarding + workspaces
spec; S5 tunnels spec; an operator setting for area switches.

---

## Self-review

**Spec coverage.** D1 → Tasks 2–4. D2 → Tasks 6–7. D3 → Tasks 5, 10. D4 → Tasks 8, 11 (audit deferred by
A1). D5 → Task 9. D6 → Tasks 13–14. D7 → Tasks 12, 14. D8 → every code is raised in Tasks 6, 7, 10, 11.
D9 → Tasks 8 (names only on the wire), 11 (ownership, trust), 5 (layer test), 13 (licence list). Testing
section → each task's step 1 plus Task 15. Docs → Task 16. Delivery order → PR 1–5 as the spec lists.

**Placeholders.** `<VIEWS.history.headline>` in Task 2 and the version pins in Task 5 are explicit "copy
from this file / this command" instructions, not gaps. Every function named in a later task is defined in an
earlier one or in the same task.

**Type consistency.** `ResolvedHost`/`HostsFile` (packages, auth holds tokens) vs `ResolvedHostWire`/
`HostsFileWire` (desktop, auth holds secret names) are converted only in `hosts-service.ts`. `SshService`
methods (`connect`, `write`, `resize`, `close`, `trust`, `disposeAll`, `disposeFor`) match Tasks 11–13.
`useHostsStore` gains `sessions`, `trustPrompt`, `setSession`, `setTrustPrompt` in Task 12 and
`reconnectNonce`, `bumpReconnect`, `noteSessionState` in Task 13. `RendererArea.registerCommands` takes
`openPalette` from Task 14 on; Task 9's `registerSshCommands` must accept (and may ignore) that argument.
