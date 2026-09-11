/** Which view the sidebar shows; mirrors the activity bar's icons. */
export type SidebarView = 'explorer' | 'search' | 'history' | 'wss' | 'settings';

/** The console's four tabs, in the order the spec lists them. */
export type ConsoleTab = 'http-log' | 'problems' | 'ws-i-report' | 'errors';

/** The Details panel's tabs: the selection inspector, the global property table, the Code panel. */
export type DetailsTab = 'selection' | 'globals' | 'code';

/** Which shell the Code panel quotes its `curl` command for. */
export type CodeShell = 'posix' | 'powershell';

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
  readonly kind: 'request' | 'interface' | 'environment';
  /** The entity id — the request, interface or environment the tab edits. */
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

/** The serialisable half of the UI store — layout and theme, no actions. */
export interface UiSnapshot {
  readonly sidebar: { readonly visible: boolean; readonly view: SidebarView; readonly size: number };
  readonly console: { readonly visible: boolean; readonly activeTab: ConsoleTab; readonly size: number };
  readonly details: {
    readonly visible: boolean;
    readonly size: number;
    readonly tab: DetailsTab;
    /** The Code panel's shell choice, remembered across sessions. */
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
 * Bumped only when a stored payload can no longer be reconciled with the current shape. Adding a
 * field to a section handled by a merge function (e.g. `details`, whose new `tab`/`codeShell`
 * fall back to their defaults per key in {@link mergeDetails}) does not need a bump.
 */
export const UI_STORAGE_VERSION = 3;

/** The layout a first run gets: everything visible, Explorer selected, dark theme. */
export const DEFAULT_UI_STATE: UiSnapshot = {
  sidebar: { visible: true, view: 'explorer', size: 20 },
  console: { visible: true, activeTab: 'http-log', size: 25 },
  details: { visible: true, size: 20, tab: 'selection', codeShell: 'posix' },
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

/**
 * Reads the persisted Details section. `tab` and `codeShell` arrived after the first releases,
 * so a payload written without them (or with a value no longer understood) keeps the default
 * rather than being discarded — the panel must never open on a tab that does not exist.
 */
function mergeDetails(stored: unknown): UiSnapshot['details'] {
  const merged = mergeSection(
    { visible: DEFAULT_UI_STATE.details.visible, size: DEFAULT_UI_STATE.details.size },
    stored,
  );
  const record = asRecord(stored);
  const tab = record?.['tab'];
  const codeShell = record?.['codeShell'];
  return {
    ...merged,
    tab: tab === 'selection' || tab === 'globals' || tab === 'code' ? tab : DEFAULT_UI_STATE.details.tab,
    codeShell: codeShell === 'posix' || codeShell === 'powershell' ? codeShell : DEFAULT_UI_STATE.details.codeShell,
  };
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

const SIDEBAR_VIEWS: readonly SidebarView[] = ['explorer', 'search', 'history', 'wss', 'settings'];

/** Reads one persisted tab, or `undefined` for anything that is not a `{ kind, id }` pair. */
function readTab(value: unknown): PersistedTab | undefined {
  const record = asRecord(value);
  const kind = record?.['kind'];
  const id = record?.['id'];
  if (typeof id !== 'string' || id.length === 0) {
    return undefined;
  }
  return kind === 'request' || kind === 'interface' || kind === 'environment' ? { kind, id } : undefined;
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
 * storage unavailable, absent key, corrupt JSON, a payload from another version — yields the
 * defaults rather than an error: a broken layout preference must never block startup.
 */
export function readUi(storage: Storage = localStorage): UiSnapshot {
  try {
    const raw = storage.getItem(UI_STORAGE_KEY);
    if (raw === null) {
      return DEFAULT_UI_STATE;
    }
    const payload = asRecord(JSON.parse(raw));
    if (payload?.['version'] !== UI_STORAGE_VERSION) {
      return DEFAULT_UI_STATE;
    }
    const stored = asRecord(payload['state']) ?? {};
    const theme = stored['theme'];
    const editorLineNumbers = stored['editorLineNumbers'];
    return {
      sidebar: mergeSection(DEFAULT_UI_STATE.sidebar, stored['sidebar']),
      console: mergeSection(DEFAULT_UI_STATE.console, stored['console']),
      details: mergeDetails(stored['details']),
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
