import { create } from 'zustand';
import type { IpcError, IpcResult } from '../../../../shared/ipc.js';
import type {
  SnippetListItemWire,
  SnippetProblemWire,
  SnippetsFileWire,
  SshListSnippetsResponse,
} from '../../../../shared/snippets-wire.js';
import { useEditorsStore } from '../../../state/editors.js';
import { ipc } from '../../../state/ipc-client.js';
import { useProblemsStore } from '../../../state/problems.js';
import { useHostsStore } from '../hosts-store.js';

/** What the right panel edits: a saved snippet, or a new one (in `packageId`, when one is given). */
export type SnippetEditorTarget = { mode: 'edit'; id: string } | { mode: 'new'; packageId?: string };

interface SnippetsState {
  file: SnippetsFileWire;
  /** The flat list main derives from the file, in file order (packages first, then no package). */
  snippets: SnippetListItemWire[];
  problems: SnippetProblemWire[];
  loaded: boolean;
  refresh: () => Promise<void>;
  /** Sends the whole file; a refusal leaves the file shown as it was and is answered for the form to show. */
  save: (file: SnippetsFileWire) => Promise<{ ok: true } | { ok: false; error: IpcError }>;
  selectedId: string | undefined;
  select: (id: string | undefined) => void;
  /** The right panel's snippet, if it is open. */
  editor: SnippetEditorTarget | null;
  /** Opens the right panel on a snippet (picking it) or on a new one. */
  openEditor: (target: SnippetEditorTarget) => void;
  closeEditor: () => void;
  /** Stays across workspaces, like the hosts filter. */
  filter: string;
  setFilter: (text: string) => void;
  selectedTags: readonly string[];
  toggleTag: (tag: string) => void;
  /** Package ids folded shut in the view. */
  collapsed: readonly string[];
  toggleCollapsed: (packageId: string) => void;
  /** Forgets the open workspace's snippets (the filter and tags stay). */
  reset: () => void;
}

const EMPTY: SnippetsFileWire = { version: 1, packages: [], snippets: [] };

const WORKSPACE_STATE = {
  file: EMPTY,
  snippets: [],
  problems: [],
  loaded: false,
  selectedId: undefined,
  editor: null,
  collapsed: [],
} satisfies Partial<SnippetsState>;

export const useSnippetsStore = create<SnippetsState>()((set, get) => ({
  ...WORKSPACE_STATE,
  filter: '',
  selectedTags: [],
  async refresh() {
    apply(await ipc().ssh.listSnippets(undefined));
  },
  async save(file) {
    const result = await ipc().ssh.saveSnippets({ file });
    if (!result.ok) return { ok: false, error: result.error };
    apply(result);
    return { ok: true };
  },
  select: (selectedId) => {
    set({ selectedId });
  },
  openEditor: (editor) => {
    set({ editor, ...(editor.mode === 'edit' ? { selectedId: editor.id } : {}) });
  },
  closeEditor: () => {
    set({ editor: null });
  },
  setFilter: (filter) => {
    set({ filter });
  },
  toggleTag: (tag) => {
    const { selectedTags } = get();
    set({ selectedTags: selectedTags.includes(tag) ? selectedTags.filter((t) => t !== tag) : [...selectedTags, tag] });
  },
  toggleCollapsed: (packageId) => {
    const { collapsed } = get();
    set({
      collapsed: collapsed.includes(packageId) ? collapsed.filter((id) => id !== packageId) : [...collapsed, packageId],
    });
  },
  reset: () => {
    set(WORKSPACE_STATE);
  },
}));

function apply(result: IpcResult<SshListSnippetsResponse>): void {
  if (!result.ok) {
    const { code, message, details } = result.error;
    const path = details?.['path'];
    useSnippetsStore.setState({ problems: [{ code, message, ...(typeof path === 'string' ? { path } : {}) }] });
    return;
  }
  const { file, snippets, problems } = result.value;
  const { selectedId, editor } = useSnippetsStore.getState();
  const gone = (id: string): boolean => !snippets.some((s) => s.id === id);
  useSnippetsStore.setState({
    file,
    snippets,
    problems,
    loaded: true,
    // A snippet removed (here, or by an edit outside) is no longer picked, nor edited.
    ...(selectedId !== undefined && gone(selectedId) ? { selectedId: undefined } : {}),
    ...(editor?.mode === 'edit' && gone(editor.id) ? { editor: null } : {}),
  });
  const store = useProblemsStore.getState();
  store.clearSource('snippets');
  store.add(
    problems.map((p) => ({
      groupId: 'snippets',
      source: 'snippets' as const,
      severity: 'error' as const,
      problem: { code: p.code, message: p.message, ...(p.path === undefined ? {} : { location: p.path }) },
    })),
  );
}

/** Re-reads the list after a save (here or in another window) or an outside edit; called once from the shell. */
export function subscribeToSnippets(): () => void {
  return window.wirebench.on('ssh.snippetsChanged', () => {
    useSnippetsStore
      .getState()
      .refresh()
      .catch(() => undefined); // the next change or the view's own read tries again
  });
}

/** Pure: by text over name, description, first line, tags and package name; then by every chosen tag. */
export function filterSnippets(
  items: readonly SnippetListItemWire[],
  text: string,
  tags: readonly string[],
): SnippetListItemWire[] {
  const needle = text.trim().toLowerCase();
  const matches = (s: SnippetListItemWire): boolean =>
    needle === '' ||
    [s.name, s.description ?? '', s.firstLine, s.packageName ?? '', ...s.tags].some((t) =>
      t.toLowerCase().includes(needle),
    );
  return items.filter((s) => matches(s) && tags.every((t) => s.tags.includes(t)));
}

/**
 * Whether the snippet panel is in front: the Snippets view is showing, and its snippet exists (or is new).
 * Here, not beside the editor, so the shell can ask without loading the editor (it is Monaco).
 */
export function useSnippetEditorShown(): boolean {
  const homeInFront = useEditorsStore((s) => s.displayedSet === 'ssh' && s.activeId === undefined);
  const onSnippets = useHostsStore((s) => s.homeView === 'snippets');
  const exists = useSnippetsStore((s) => {
    const target = s.editor;
    if (target === null) return false;
    return target.mode === 'new' || s.snippets.some((x) => x.id === target.id);
  });
  return homeInFront && onSnippets && exists;
}
