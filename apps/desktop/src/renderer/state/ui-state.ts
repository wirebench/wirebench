/** Which view the sidebar shows; mirrors the activity bar's icons. */
export type SidebarView = 'explorer' | 'environments' | 'search' | 'history' | 'wss' | 'settings';

/** The console's four tabs, in the order the spec lists them. */
export type ConsoleTab = 'http-log' | 'problems' | 'ws-i-report' | 'errors';

/** How a request editor arranges its panes; see `features/request-editor/layout.ts`. */
export interface EditorLayoutSnapshot {
  readonly orientation: 'side-by-side' | 'stacked';
  readonly mode: 'split' | 'tabs';
}

/**
 * One editor tab remembered across restarts. Only the three kinds that name a durable entity
 * are persisted: a diff, a history entry or the preferences tab describes a moment, not a
 * thing the next session can reopen.
 */
export interface PersistedTab {
  readonly kind: 'request' | 'interface' | 'environment' | 'project';
  /** The entity id — the request, interface, environment or project the tab edits. */
  readonly id: string;
}

/** What one workspace leaves behind when it is closed, so reopening it looks the same. */
export interface PersistedWorkspaceUi {
  readonly tabs: readonly PersistedTab[];
  /** The entity id of the tab that was active, when one was. */
  readonly activeId?: string;
  readonly sidebarView?: SidebarView;
}

/** Theme preference; `system` follows the OS via `prefers-color-scheme`. */
export type ThemePreference = 'dark' | 'light' | 'system';

/** Which shell the Code slide-over quotes its `curl` command for. */
export type CodeShell = 'posix' | 'powershell';

/** The serialisable half of the UI store — layout and theme, no actions. */
export interface UiSnapshot {
  readonly sidebar: {
    readonly visible: boolean;
    readonly view: SidebarView;
    readonly size: number;
    /** The size to restore on expand, after a collapse; Task 9's collapse button reads this. */
    readonly lastSize: number;
  };
  readonly console: {
    readonly visible: boolean;
    readonly activeTab: ConsoleTab;
    readonly size: number;
    /** The size to restore on expand, after a collapse; Task 9's collapse button reads this. */
    readonly lastSize: number;
  };
  /** The right-hand slide-over hosting the Code panel; opened from the right rail. */
  readonly slideOver: {
    readonly open: boolean;
    readonly width: number;
    /** The Code panel's POSIX/PowerShell choice; carried here since the panel now lives in the slide-over. */
    readonly codeShell: CodeShell;
  };
  readonly theme: ThemePreference;
  /** Whether request/response Monaco editors show line numbers. */
  readonly editorLineNumbers: boolean;
  /** The default request-editor layout; a request may override it for the session. */
  readonly editorLayout: EditorLayoutSnapshot;
  /**
   * Per-workspace editor state, keyed by workspace id. Everything above is global — one theme,
   * one sidebar width — but which tabs are open is a property of the workspace you were in.
   */
  readonly workspaces: Readonly<Record<string, PersistedWorkspaceUi>>;
}

/** `localStorage` key holding the persisted layout. */
export const UI_STORAGE_KEY = 'wirebench.ui';

/**
 * Bumped only when a stored payload can no longer be reconciled with the current shape. This
 * went 3 → 4 when the right panel (and its `details` slice) was replaced by the right rail and
 * the Code slide-over: `readUi` still accepts a version-3 blob (its `sidebar`/`console`/`theme`/
 * `editorLineNumbers`/`editorLayout`/`workspaces` fields are structurally the same as v4's), it
 * simply never reads the old `details` key, so a v3 blob loses only that slice and keeps every
 * other preference — except `details.codeShell`, the Code panel's POSIX/PowerShell choice, which
 * `readUi` carries forward into `slideOver.codeShell` since the Code panel now lives in the
 * slide-over (see {@link mergeSlideOver}). Adding a field to a section handled by a merge
 * function does not need a further bump.
 */
export const UI_STORAGE_VERSION = 4;

/** The previous storage version, whose stored shape `readUi` still accepts (see above). */
const PRIOR_UI_STORAGE_VERSION = 3;

/** The layout a first run gets: everything visible, Explorer selected, dark theme. */
export const DEFAULT_UI_STATE: UiSnapshot = {
  sidebar: { visible: true, view: 'explorer', size: 20, lastSize: 20 },
  console: { visible: true, activeTab: 'http-log', size: 25, lastSize: 25 },
  slideOver: { open: false, width: 420, codeShell: 'posix' },
  theme: 'dark',
  editorLineNumbers: true,
  editorLayout: { orientation: 'side-by-side', mode: 'split' },
  workspaces: {},
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function mergeSection<T extends Record<string, unknown>>(defaults: T, stored: unknown): T {
  const record = asRecord(stored);
  if (record === undefined) {
    return defaults;
  }
  const merged: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const value = record[key];
    if (value !== undefined && typeof value === typeof merged[key]) {
      merged[key] = value;
    }
  }
  return merged as T;
}

/** Reads a persisted editor layout, falling back per-field to the default for anything odd. */
function mergeEditorLayout(stored: unknown): EditorLayoutSnapshot {
  const record = asRecord(stored);
  const orientation = record?.['orientation'];
  const mode = record?.['mode'];
  return {
    orientation:
      orientation === 'side-by-side' || orientation === 'stacked'
        ? orientation
        : DEFAULT_UI_STATE.editorLayout.orientation,
    mode: mode === 'split' || mode === 'tabs' ? mode : DEFAULT_UI_STATE.editorLayout.mode,
  };
}

/**
 * Reads the persisted slide-over slice. `codeShell` is validated as an enum rather than by
 * `mergeSection`'s `typeof` check (any string would pass that), and falls back to
 * `legacyCodeShell` — the v3 blob's `details.codeShell`, when there is one — before the default,
 * so a version-3 payload's shell preference survives the v3 → v4 migration.
 */
function mergeSlideOver(stored: unknown, legacyCodeShell: unknown): UiSnapshot['slideOver'] {
  const record = asRecord(stored);
  const open = record?.['open'];
  const width = record?.['width'];
  const codeShell = record?.['codeShell'] ?? legacyCodeShell;
  return {
    open: typeof open === 'boolean' ? open : DEFAULT_UI_STATE.slideOver.open,
    width: typeof width === 'number' ? width : DEFAULT_UI_STATE.slideOver.width,
    codeShell: codeShell === 'posix' || codeShell === 'powershell' ? codeShell : DEFAULT_UI_STATE.slideOver.codeShell,
  };
}

const SIDEBAR_VIEWS: readonly SidebarView[] = ['explorer', 'environments', 'search', 'history', 'wss', 'settings'];

/** Reads one persisted tab, or `undefined` for anything that is not a `{ kind, id }` pair. */
function readTab(value: unknown): PersistedTab | undefined {
  const record = asRecord(value);
  const kind = record?.['kind'];
  const id = record?.['id'];
  if (typeof id !== 'string' || id.length === 0) {
    return undefined;
  }
  return kind === 'request' || kind === 'interface' || kind === 'environment' || kind === 'project'
    ? { kind, id }
    : undefined;
}

/**
 * Reads the per-workspace map, dropping anything malformed entry by entry: a corrupt entry for
 * one workspace must not cost the user the tabs of every other one.
 */
function mergeWorkspaces(stored: unknown): Record<string, PersistedWorkspaceUi> {
  const record = asRecord(stored);
  if (record === undefined) {
    return {};
  }
  const merged: Record<string, PersistedWorkspaceUi> = {};
  for (const [workspaceId, value] of Object.entries(record)) {
    const entry = asRecord(value);
    if (entry === undefined) {
      continue;
    }
    const rawTabs = entry['tabs'];
    const tabs = Array.isArray(rawTabs)
      ? rawTabs.map(readTab).filter((tab): tab is PersistedTab => tab !== undefined)
      : [];
    const activeId = entry['activeId'];
    const sidebarView = entry['sidebarView'];
    merged[workspaceId] = {
      tabs,
      ...(typeof activeId === 'string' ? { activeId } : {}),
      ...(SIDEBAR_VIEWS.includes(sidebarView as SidebarView) ? { sidebarView: sidebarView as SidebarView } : {}),
    };
  }
  return merged;
}

/**
 * Reads the persisted layout, merging it over {@link DEFAULT_UI_STATE}. Every failure mode —
 * storage unavailable, absent key, corrupt JSON, a payload from a version this reader does not
 * know how to read — yields the defaults rather than an error: a broken layout preference must
 * never block startup.
 *
 * A `version: 4` payload is read directly; a `version: 3` payload is accepted too (see
 * {@link UI_STORAGE_VERSION}'s doc comment) — only `sidebar`, `console`, `theme`,
 * `editorLineNumbers`, `editorLayout` and `workspaces` are ever read off `state`, so the v3
 * blob's `details` key is silently dropped and everything else survives. Any other version
 * (missing, too old, too new, corrupt) falls back to the defaults wholesale.
 */
export function readUi(storage: Storage = localStorage): UiSnapshot {
  try {
    const raw = storage.getItem(UI_STORAGE_KEY);
    if (raw === null) {
      return DEFAULT_UI_STATE;
    }
    const payload = asRecord(JSON.parse(raw));
    const version = payload?.['version'];
    if (version !== UI_STORAGE_VERSION && version !== PRIOR_UI_STORAGE_VERSION) {
      return DEFAULT_UI_STATE;
    }
    const stored = asRecord(payload?.['state']) ?? {};
    const theme = stored['theme'];
    const editorLineNumbers = stored['editorLineNumbers'];
    // Only a version-3 blob carries the legacy `details.codeShell`; a v4 blob's `slideOver`
    // already has its own `codeShell` (or doesn't, and gets the default).
    const legacyCodeShell =
      version === PRIOR_UI_STORAGE_VERSION ? asRecord(stored['details'])?.['codeShell'] : undefined;
    return {
      sidebar: mergeSection(DEFAULT_UI_STATE.sidebar, stored['sidebar']),
      console: mergeSection(DEFAULT_UI_STATE.console, stored['console']),
      slideOver: mergeSlideOver(stored['slideOver'], legacyCodeShell),
      theme: theme === 'dark' || theme === 'light' || theme === 'system' ? theme : DEFAULT_UI_STATE.theme,
      editorLineNumbers:
        typeof editorLineNumbers === 'boolean' ? editorLineNumbers : DEFAULT_UI_STATE.editorLineNumbers,
      editorLayout: mergeEditorLayout(stored['editorLayout']),
      workspaces: mergeWorkspaces(stored['workspaces']),
    };
  } catch {
    return DEFAULT_UI_STATE;
  }
}

/** Writes the layout, swallowing storage failures — persistence is a convenience, not a contract. */
export function writeUi(state: UiSnapshot, storage: Storage = localStorage): void {
  try {
    storage.setItem(UI_STORAGE_KEY, JSON.stringify({ version: UI_STORAGE_VERSION, state }));
  } catch {
    // Private windows and blocked site data throw here; the session simply forgets the layout.
  }
}
