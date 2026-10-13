import { create } from 'zustand';
import type { IpcResult } from '../../../shared/ipc.js';
import type {
  GroupEntryWire,
  HostEntryWire,
  HostsFileWire,
  ResolvedHostWire,
  SshHostOsWire,
  SshListHostsResponse,
  SshProblemWire,
} from '../../../shared/ssh-wire.js';
import { ipc } from '../../state/ipc-client.js';
import { useProblemsStore } from '../../state/problems.js';

/** Which host / group form is open, if any. `parent` is the group a new entry is created in. */
export type HostsDialog =
  | { mode: 'new-host'; parent?: string }
  | { mode: 'edit-host'; id: string }
  | { mode: 'new-group'; parent?: string }
  | { mode: 'edit-group'; id: string }
  | null;

/**
 * A host key main refused until the user decides; `previous` is set when the stored key differs. A terminal's
 * prompt carries the size to connect at; another caller (a Files tab) passes `retry`, run once the key is
 * trusted, and `cancel`, run instead of marking the host's connect failed when the prompt is dismissed.
 */
export interface TrustPrompt {
  /** The pane whose connect the key stopped; confirming connects it again. */
  paneId: string;
  hostId: string;
  size?: { cols: number; rows: number };
  host: string;
  keyType: string;
  fingerprint: string;
  previous?: string;
  retry?: () => void;
  cancel?: () => void;
}

/** One terminal pane's session to its host. */
export interface PaneSession {
  hostId: string;
  sessionId?: string;
  state: 'connecting' | 'open' | 'closed';
}

/** How a host (or a tab) stands, from its panes: open over connecting over idle. */
export type HostStatus = 'open' | 'connecting' | 'idle';

/** The best state of the given panes; a pane with no entry, or a closed session, counts as idle. */
export function statusOf(panes: Readonly<Record<string, PaneSession>>, paneIds: Iterable<string>): HostStatus {
  let status: HostStatus = 'idle';
  for (const id of paneIds) {
    const state = panes[id]?.state;
    if (state === 'open') return 'open';
    if (state === 'connecting') status = 'connecting';
  }
  return status;
}

/** A host's status: the best of every pane on it, in any tab. */
export function hostStatusOf(panes: Readonly<Record<string, PaneSession>>, hostId: string): HostStatus {
  return statusOf(
    panes,
    Object.keys(panes).filter((id) => panes[id]?.hostId === hostId),
  );
}

/** What the SSH area's fixed first tab shows, picked from the area's menu. */
export type SshHomeView = 'hosts' | 'snippets' | 'layouts' | 'keychain' | 'known-hosts';

interface HostsState {
  /** Stays across workspaces, like the filter: it is where the user was, not workspace data. */
  homeView: SshHomeView;
  setHomeView: (view: SshHomeView) => void;
  /** The host picked on the Hosts tab: its card is highlighted and its details can show on the right. */
  selectedHostId: string | undefined;
  /** Whether the details slide-over is wanted; picking a host asks for it, Escape or its close icon put it away. */
  detailsOpen: boolean;
  /** What is known of each server's OS on this machine, by `address:port` (see {@link osKeyOf}). */
  osByHost: Readonly<Record<string, SshHostOsWire>>;
  refreshOs: () => Promise<void>;
  /** The group the Hosts tab is narrowed to (its subgroups included), if any. */
  groupFilter: string | undefined;
  setGroupFilter: (groupId: string | undefined) => void;
  /** Picks a host (or none) and opens its details. */
  selectHost: (id: string | undefined) => void;
  setDetailsOpen: (open: boolean) => void;
  file: HostsFileWire;
  resolved: readonly ResolvedHostWire[];
  problems: readonly SshProblemWire[];
  loaded: boolean;
  filter: string;
  selectedTags: readonly string[];
  dialog: HostsDialog;
  /** Whether the "Import from SSH config" dialog is open. */
  importOpen: boolean;
  /** The session per terminal pane id; a pane absent from the record is idle. */
  panes: Readonly<Record<string, PaneSession>>;
  /** A host's status, derived from its panes. */
  hostStatus: (hostId: string) => HostStatus;
  trustPrompt: TrustPrompt | null;
  /**
   * Panes whose last connect ended without a session: refused, failed, or the trust prompt cancelled.
   * Cleared when the pane's next connect starts; the pane shows it with a Reconnect.
   */
  connectFailed: Readonly<Record<string, true>>;
  /** Bumped by a pane's Reconnect, per pane id; the pane keyed on it tears down and connects afresh. */
  reconnectNonce: Readonly<Record<string, number>>;
  /** When each terminal tab was last in front (a counter, higher is later): Connect picks the latest. */
  terminalTabUse: Readonly<Record<string, number>>;
  noteTerminalTabUsed: (tabId: string) => void;
  refresh: () => Promise<void>;
  /** Sends the whole file; `false` when main refused it (the old state stays, the refusal is a problem). */
  save: (file: HostsFileWire) => Promise<boolean>;
  setFilter: (text: string) => void;
  toggleTag: (tag: string) => void;
  openDialog: (dialog: HostsDialog) => void;
  closeDialog: () => void;
  setImportOpen: (open: boolean) => void;
  /** Takes main's answer to an import's apply: the reloaded file, as after a save. */
  applyImported: (result: SshListHostsResponse) => void;
  /** `undefined` removes the pane's entry (idle). */
  setPane: (paneId: string, session: PaneSession | undefined) => void;
  setTrustPrompt: (prompt: TrustPrompt | null) => void;
  /** Main's `ssh.state`: a session that closed marks its pane `closed` (the id stays, for the pane to see). */
  noteSessionState: (sessionId: string, state: 'open' | 'closed') => void;
  bumpReconnect: (paneId: string) => void;
  noteConnectFailed: (paneId: string) => void;
  /** The user dismissed the trust prompt: no session, so the host's connect failed. */
  cancelTrust: () => void;
  visibleHosts: () => readonly ResolvedHostWire[];
  /**
   * Forgets the open workspace's hosts: the file, its problems, every session, failure and prompt, and an
   * open form (which would otherwise save into the next workspace). The filter and tags stay.
   */
  reset: () => void;
}

const EMPTY: HostsFileWire = { version: 1, groups: [], hosts: [] };

/** The part of the state that belongs to the open workspace; `reset` puts it back. */
const WORKSPACE_STATE = {
  file: EMPTY,
  resolved: [],
  problems: [],
  loaded: false,
  dialog: null,
  importOpen: false,
  panes: {},
  trustPrompt: null,
  reconnectNonce: {},
  terminalTabUse: {},
  connectFailed: {},
  selectedHostId: undefined,
  groupFilter: undefined,
} satisfies Partial<HostsState>;

export const useHostsStore = create<HostsState>()((set, get) => ({
  ...WORKSPACE_STATE,
  homeView: 'hosts',
  setHomeView: (homeView) => {
    set({ homeView });
  },
  detailsOpen: false,
  // Per machine, not per workspace: what a server runs does not change with the workspace open.
  osByHost: {},
  async refreshOs() {
    // Only labels: a read that fails keeps the ones shown rather than surfacing an error.
    try {
      const result = await ipc().ssh.hostOs(undefined);
      if (result.ok) set({ osByHost: result.value.entries });
    } catch {
      // Nothing to do.
    }
  },
  setGroupFilter: (groupFilter) => {
    set({ groupFilter });
  },
  selectHost: (selectedHostId) => {
    // Picking another host leaves the one being edited: its form lives in the details panel.
    const { dialog } = get();
    const leaving = dialog?.mode === 'edit-host' && dialog.id !== selectedHostId;
    set({ selectedHostId, detailsOpen: selectedHostId !== undefined, ...(leaving ? { dialog: null } : {}) });
  },
  setDetailsOpen: (detailsOpen) => {
    // Putting the panel away cancels an edit in it.
    set({ detailsOpen, ...(!detailsOpen && get().dialog?.mode === 'edit-host' ? { dialog: null } : {}) });
  },
  filter: '',
  selectedTags: [],
  reset: () => {
    set(WORKSPACE_STATE);
  },
  async refresh() {
    apply(await ipc().ssh.listHosts(undefined));
  },
  async save(file) {
    return apply(await ipc().ssh.saveHosts({ file }));
  },
  setFilter: (filter) => {
    set({ filter });
  },
  toggleTag: (tag) => {
    const { selectedTags } = get();
    set({ selectedTags: selectedTags.includes(tag) ? selectedTags.filter((t) => t !== tag) : [...selectedTags, tag] });
  },
  openDialog: (dialog) => {
    set({ dialog });
  },
  closeDialog: () => {
    set({ dialog: null });
  },
  setImportOpen: (importOpen) => {
    set({ importOpen });
  },
  applyImported: (result) => {
    apply({ ok: true, value: result });
  },
  hostStatus: (hostId) => hostStatusOf(get().panes, hostId),
  setPane: (paneId, session) => {
    const panes = { ...get().panes };
    if (session === undefined) {
      delete panes[paneId];
      set({ panes });
      return;
    }
    panes[paneId] = session;
    const connectFailed = { ...get().connectFailed };
    delete connectFailed[paneId];
    set({ panes, connectFailed });
  },
  setTrustPrompt: (trustPrompt) => {
    set({ trustPrompt });
  },
  noteSessionState: (sessionId, state) => {
    if (state !== 'closed') return;
    const { panes } = get();
    const paneId = Object.keys(panes).find((id) => panes[id]?.sessionId === sessionId);
    const pane = paneId === undefined ? undefined : panes[paneId];
    if (paneId !== undefined && pane !== undefined) {
      set({ panes: { ...panes, [paneId]: { hostId: pane.hostId, sessionId, state: 'closed' } } });
    }
  },
  noteConnectFailed: (paneId) => {
    set({ connectFailed: { ...get().connectFailed, [paneId]: true } });
  },
  cancelTrust: () => {
    const prompt = get().trustPrompt;
    if (prompt === null) return;
    if (prompt.cancel !== undefined) {
      set({ trustPrompt: null });
      prompt.cancel();
      return;
    }
    set({ trustPrompt: null, connectFailed: { ...get().connectFailed, [prompt.paneId]: true } });
  },
  bumpReconnect: (paneId) => {
    const { reconnectNonce } = get();
    set({ reconnectNonce: { ...reconnectNonce, [paneId]: (reconnectNonce[paneId] ?? 0) + 1 } });
  },
  noteTerminalTabUsed: (tabId) => {
    const { terminalTabUse } = get();
    const latest = Math.max(0, ...Object.values(terminalTabUse));
    if (terminalTabUse[tabId] === latest && latest > 0) return;
    set({ terminalTabUse: { ...terminalTabUse, [tabId]: latest + 1 } });
  },
  visibleHosts() {
    const { resolved, filter, selectedTags } = get();
    const needle = filter.trim().toLowerCase();
    const matches = (h: ResolvedHostWire): boolean =>
      needle === '' || [h.name, h.address, ...h.tags].some((t) => t.toLowerCase().includes(needle));
    return resolved.filter((h) => matches(h) && selectedTags.every((t) => h.tags.includes(t)));
  },
}));

function apply(result: IpcResult<SshListHostsResponse>): boolean {
  if (!result.ok) {
    const { code, message, details } = result.error;
    const path = details?.['path'];
    useHostsStore.setState({
      problems: [{ code, message, ...(typeof path === 'string' ? { path } : {}) }],
    });
    return false;
  }
  const { file, resolved, problems } = result.value;
  useHostsStore.setState({ file, resolved, problems, loaded: true });
  const store = useProblemsStore.getState();
  store.clearSource('hosts');
  store.add(
    problems.map((p) => ({
      groupId: 'hosts',
      source: 'hosts' as const,
      severity: 'error' as const,
      problem: { code: p.code, message: p.message, ...(p.path === undefined ? {} : { location: p.path }) },
    })),
  );
  return true;
}

/** Keeps the tree current when main saves or `hosts.yaml` is edited outside; called once from the shell. */
export function subscribeToHosts(): () => void {
  const offHosts = window.wirebench.on('ssh.hostsChanged', () => {
    void useHostsStore.getState().refresh();
  });
  const offOs = window.wirebench.on('ssh.hostOsChanged', () => {
    void useHostsStore.getState().refreshOs();
  });
  void useHostsStore.getState().refreshOs();
  return () => {
    offHosts();
    offOs();
  };
}

// ---------------------------------------------------------------------------
// Pure edits of the file; each returns a new file and leaves its input alone.
// ---------------------------------------------------------------------------

/** Rebuilds the group tree bottom-up; `fn` returns the replacement group, or `null` to drop it. */
function mapGroups(
  groups: readonly GroupEntryWire[],
  fn: (g: GroupEntryWire) => GroupEntryWire | null,
): GroupEntryWire[] {
  return groups.flatMap((g) => {
    const next = fn({ ...g, groups: mapGroups(g.groups, fn) });
    return next === null ? [] : [next];
  });
}

function withoutHost(file: HostsFileWire, id: string): HostsFileWire {
  return {
    ...file,
    hosts: file.hosts.filter((h) => h.id !== id),
    groups: mapGroups(file.groups, (g) => ({ ...g, hosts: g.hosts.filter((h) => h.id !== id) })),
  };
}

function putHost(file: HostsFileWire, host: HostEntryWire, parentGroupId: string | undefined): HostsFileWire {
  if (parentGroupId === undefined) return { ...file, hosts: [...file.hosts, host] };
  return {
    ...file,
    groups: mapGroups(file.groups, (g) => (g.id === parentGroupId ? { ...g, hosts: [...g.hosts, host] } : g)),
  };
}

function findHost(file: HostsFileWire, id: string): HostEntryWire | undefined {
  const inGroups = (groups: readonly GroupEntryWire[]): HostEntryWire | undefined => {
    for (const g of groups) {
      const found = g.hosts.find((h) => h.id === id) ?? inGroups(g.groups);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return file.hosts.find((h) => h.id === id) ?? inGroups(file.groups);
}

function findGroup(file: HostsFileWire, id: string): GroupEntryWire | undefined {
  const search = (groups: readonly GroupEntryWire[]): GroupEntryWire | undefined => {
    for (const g of groups) {
      const found = g.id === id ? g : search(g.groups);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return search(file.groups);
}

/** The groups enclosing a host or group (`kind`), outermost first; empty at the root or when `id` is unknown. */
export function ancestorsOf(file: HostsFileWire, kind: 'host' | 'group', id: string): GroupEntryWire[] {
  const walk = (groups: readonly GroupEntryWire[], trail: GroupEntryWire[]): GroupEntryWire[] | undefined => {
    for (const g of groups) {
      if (kind === 'group' && g.id === id) return trail;
      const next = [...trail, g];
      if (kind === 'host' && g.hosts.some((h) => h.id === id)) return next;
      const found = walk(g.groups, next);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(file.groups, []) ?? [];
}

export { findGroup, findHost };

/** Replaces the host with the same id in place; a new id is appended to `parentGroupId` (or the root). */
export function upsertHost(file: HostsFileWire, host: HostEntryWire, parentGroupId?: string): HostsFileWire {
  if (findHost(file, host.id) === undefined) return putHost(file, host, parentGroupId);
  const swap = (hosts: readonly HostEntryWire[]): HostEntryWire[] => hosts.map((h) => (h.id === host.id ? host : h));
  return {
    ...file,
    hosts: swap(file.hosts),
    groups: mapGroups(file.groups, (g) => ({ ...g, hosts: swap(g.hosts) })),
  };
}

export function removeHost(file: HostsFileWire, id: string): HostsFileWire {
  return withoutHost(file, id);
}

/**
 * Replaces the group with the same id (keeping its children, which the form does not edit); a new id is
 * appended to `parentGroupId` (or the root).
 */
export function upsertGroup(file: HostsFileWire, group: GroupEntryWire, parentGroupId?: string): HostsFileWire {
  if (findGroup(file, group.id) !== undefined) {
    return {
      ...file,
      groups: mapGroups(file.groups, (g) => {
        if (g.id !== group.id) return g;
        const { protected: dropped, ...rest } = g;
        void dropped;
        return {
          ...rest,
          name: group.name,
          tags: group.tags,
          ...(group.protected === undefined ? {} : { protected: group.protected }),
          ssh: group.ssh,
        };
      }),
    };
  }
  if (parentGroupId === undefined) return { ...file, groups: [...file.groups, group] };
  return {
    ...file,
    groups: mapGroups(file.groups, (g) => (g.id === parentGroupId ? { ...g, groups: [...g.groups, group] } : g)),
  };
}

/** @throws Error `group is not empty` while the group still has hosts or subgroups. */
export function removeGroup(file: HostsFileWire, id: string): HostsFileWire {
  const group = findGroup(file, id);
  if (group !== undefined && (group.groups.length > 0 || group.hosts.length > 0)) {
    throw new Error('group is not empty');
  }
  return { ...file, groups: mapGroups(file.groups, (g) => (g.id === id ? null : g)) };
}

export function moveHost(file: HostsFileWire, id: string, toGroupId: string | undefined): HostsFileWire {
  const host = findHost(file, id);
  return host === undefined ? file : putHost(withoutHost(file, id), host, toGroupId);
}

/** Every host and group id in the file. */
export function allIds(file: HostsFileWire): Set<string> {
  const ids = new Set<string>();
  const walk = (groups: readonly GroupEntryWire[], hosts: readonly HostEntryWire[]): void => {
    for (const h of hosts) ids.add(h.id);
    for (const g of groups) {
      ids.add(g.id);
      walk(g.groups, g.hosts);
    }
  };
  walk(file.groups, file.hosts);
  return ids;
}

/** `base`, or `base-2`, `base-3`, … — the first id no host or group in the file uses. */
export function freeId(file: HostsFileWire, base: string): string {
  const taken = allIds(file);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${String(n)}`;
  return id;
}

/** Every group in the file with its nesting depth, outermost first. */
export function flattenGroups(file: HostsFileWire): { group: GroupEntryWire; depth: number }[] {
  const out: { group: GroupEntryWire; depth: number }[] = [];
  const walk = (groups: readonly GroupEntryWire[], depth: number): void => {
    for (const group of groups) {
      out.push({ group, depth });
      walk(group.groups, depth + 1);
    }
  };
  walk(file.groups, 0);
  return out;
}

/** The key a host's OS is kept under: the server it connects to, as the known hosts name it. */
export function osKeyOf(host: Pick<ResolvedHostWire, 'address' | 'ssh'>): string {
  return `${host.address}:${String(host.ssh.port.value)}`;
}
