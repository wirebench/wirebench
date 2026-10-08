import { create } from 'zustand';
import type { IpcResult } from '../../../shared/ipc.js';
import type {
  GroupEntryWire,
  HostEntryWire,
  HostsFileWire,
  ResolvedHostWire,
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

/** A host key main refused until the user decides; `previous` is set when the stored key differs. */
export interface TrustPrompt {
  hostId: string;
  size: { cols: number; rows: number };
  host: string;
  keyType: string;
  fingerprint: string;
  previous?: string;
}

export interface HostSession {
  sessionId?: string;
  state: 'connecting' | 'open' | 'closed';
}

interface HostsState {
  file: HostsFileWire;
  resolved: readonly ResolvedHostWire[];
  problems: readonly SshProblemWire[];
  loaded: boolean;
  filter: string;
  selectedTags: readonly string[];
  dialog: HostsDialog;
  /** The session state per host id; a host absent from the record is idle. */
  sessions: Readonly<Record<string, HostSession>>;
  trustPrompt: TrustPrompt | null;
  /** Bumped by a terminal tab's Reconnect; the tab keyed on it tears down and connects afresh. */
  reconnectNonce: Readonly<Record<string, number>>;
  refresh: () => Promise<void>;
  /** Sends the whole file; `false` when main refused it (the old state stays, the refusal is a problem). */
  save: (file: HostsFileWire) => Promise<boolean>;
  setFilter: (text: string) => void;
  toggleTag: (tag: string) => void;
  openDialog: (dialog: HostsDialog) => void;
  closeDialog: () => void;
  /** `undefined` removes the host's entry (idle). */
  setSession: (hostId: string, session: HostSession | undefined) => void;
  setTrustPrompt: (prompt: TrustPrompt | null) => void;
  /** Main's `ssh.state`: a session that closed marks its host `closed` (the id stays, for the tab to see). */
  noteSessionState: (sessionId: string, state: 'open' | 'closed') => void;
  bumpReconnect: (hostId: string) => void;
  visibleHosts: () => readonly ResolvedHostWire[];
}

const EMPTY: HostsFileWire = { version: 1, groups: [], hosts: [] };

export const useHostsStore = create<HostsState>()((set, get) => ({
  file: EMPTY,
  resolved: [],
  problems: [],
  loaded: false,
  filter: '',
  selectedTags: [],
  dialog: null,
  sessions: {},
  trustPrompt: null,
  reconnectNonce: {},
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
  setSession: (hostId, session) => {
    const sessions = { ...get().sessions };
    if (session === undefined) delete sessions[hostId];
    else sessions[hostId] = session;
    set({ sessions });
  },
  setTrustPrompt: (trustPrompt) => {
    set({ trustPrompt });
  },
  noteSessionState: (sessionId, state) => {
    if (state !== 'closed') return;
    const { sessions } = get();
    const hostId = Object.keys(sessions).find((id) => sessions[id]?.sessionId === sessionId);
    if (hostId !== undefined) set({ sessions: { ...sessions, [hostId]: { sessionId, state: 'closed' } } });
  },
  bumpReconnect: (hostId) => {
    const { reconnectNonce } = get();
    set({ reconnectNonce: { ...reconnectNonce, [hostId]: (reconnectNonce[hostId] ?? 0) + 1 } });
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
  return window.wirebench.on('ssh.hostsChanged', () => {
    void useHostsStore.getState().refresh();
  });
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
      groups: mapGroups(file.groups, (g) =>
        g.id === group.id ? { ...g, name: group.name, tags: group.tags, ssh: group.ssh } : g,
      ),
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
