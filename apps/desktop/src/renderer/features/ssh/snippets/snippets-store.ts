import { create } from 'zustand';
import type { IpcError, IpcResult } from '../../../../shared/ipc.js';
import type {
  SnippetListItemWire,
  SnippetProblemWire,
  SnippetsFileWire,
  SshListSnippetsResponse,
} from '../../../../shared/snippets-wire.js';
import { ipc } from '../../../state/ipc-client.js';
import { useProblemsStore } from '../../../state/problems.js';

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
  const { selectedId } = useSnippetsStore.getState();
  useSnippetsStore.setState({
    file,
    snippets,
    problems,
    loaded: true,
    // A snippet removed (here, or by an edit outside) is no longer picked.
    ...(selectedId !== undefined && !snippets.some((s) => s.id === selectedId) ? { selectedId: undefined } : {}),
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
