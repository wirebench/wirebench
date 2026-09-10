/** Which view the sidebar shows; mirrors the activity bar's four icons. */
export type SidebarView = 'explorer' | 'search' | 'history' | 'settings';

/** The console's four tabs, in the order the spec lists them. */
export type ConsoleTab = 'http-log' | 'problems' | 'ws-i-report' | 'errors';

/** How a request editor arranges its panes; see `features/request-editor/layout.ts`. */
export interface EditorLayoutSnapshot {
  readonly orientation: 'side-by-side' | 'stacked';
  readonly mode: 'split' | 'tabs';
}

/** Theme preference; `system` follows the OS via `prefers-color-scheme`. */
export type ThemePreference = 'dark' | 'light' | 'system';

/** The serialisable half of the UI store — layout and theme, no actions. */
export interface UiSnapshot {
  readonly sidebar: { readonly visible: boolean; readonly view: SidebarView; readonly size: number };
  readonly console: { readonly visible: boolean; readonly activeTab: ConsoleTab; readonly size: number };
  readonly details: { readonly visible: boolean; readonly size: number };
  readonly theme: ThemePreference;
  /** Whether request/response Monaco editors show line numbers. */
  readonly editorLineNumbers: boolean;
  /** The default request-editor layout; a request may override it for the session. */
  readonly editorLayout: EditorLayoutSnapshot;
}

/** `localStorage` key holding the persisted layout. */
export const UI_STORAGE_KEY = 'wirebench.ui';

/** Bumped whenever {@link UiSnapshot} changes shape; older payloads are discarded, not migrated. */
export const UI_STORAGE_VERSION = 2;

/** The layout a first run gets: everything visible, Explorer selected, dark theme. */
export const DEFAULT_UI_STATE: UiSnapshot = {
  sidebar: { visible: true, view: 'explorer', size: 20 },
  console: { visible: true, activeTab: 'http-log', size: 25 },
  details: { visible: true, size: 20 },
  theme: 'dark',
  editorLineNumbers: true,
  editorLayout: { orientation: 'side-by-side', mode: 'split' },
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
      details: mergeSection(DEFAULT_UI_STATE.details, stored['details']),
      theme: theme === 'dark' || theme === 'light' || theme === 'system' ? theme : DEFAULT_UI_STATE.theme,
      editorLineNumbers:
        typeof editorLineNumbers === 'boolean' ? editorLineNumbers : DEFAULT_UI_STATE.editorLineNumbers,
      editorLayout: mergeEditorLayout(stored['editorLayout']),
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
