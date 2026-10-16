/**
 * Per-workspace editor tabs: saved when a workspace closes, restored when it opens again.
 *
 * Only the tab kinds that name a durable entity survive a switch — a request of either protocol,
 * an imported interface, an API, an environment, a project. A diff, a history entry and the
 * preferences tab all describe a moment rather than a thing, so they are simply dropped.
 */

import { entityIdOf, TAB_KINDS, tabOwner, type TabContribution } from '../kinds/index.js';
import { kindLabel } from '../kinds/placeholders.js';
import type { WorkspaceWire } from '../../shared/wire-base.js';
import type { PersistedTab } from './ui-state.js';
import { useEditorsStore, type EditorTab } from './editors.js';
import { useProjectStore } from './project.js';
import { useUiStore } from './ui.js';
import { useWorkspaceStore } from './workspace.js';

/** The contribution of a tab kind that survives a workspace switch. */
function persistedContribution(kind: EditorTab['kind']): TabContribution | undefined {
  const contribution = TAB_KINDS[kind];
  return contribution?.persisted === true ? contribution : undefined;
}

/** The persisted shape of an open tab, or `undefined` for a kind that does not survive. */
function persist(tab: EditorTab): PersistedTab | undefined {
  const contribution = persistedContribution(tab.kind);
  const id = contribution === undefined ? undefined : entityIdOf(tab, contribution);
  return id === undefined ? undefined : { kind: tab.kind as PersistedTab['kind'], id };
}

/** The title one persisted tab reopens with, or `undefined` when its entity is gone. */
function titleFor(contribution: TabContribution, id: string): string | undefined {
  return contribution.title(id, {
    project: useProjectStore.getState(),
    workspaceEnvironments: useWorkspaceStore.getState().workspace?.environments ?? [],
    hookNames: {},
    scheduleNames: {},
  });
}

/**
 * Records the open tabs and the sidebar view of `workspaceId`. Called just before a workspace
 * is replaced or closed, while the editors store still holds its tabs.
 */
export function saveWorkspaceTabs(workspaceId: string): void {
  const { tabs, activeId } = useEditorsStore.getState();
  const persisted = tabs.map(persist).filter((tab): tab is PersistedTab => tab !== undefined);
  const active = tabs.find((tab) => tab.id === activeId);
  const activeEntity = active === undefined ? undefined : persist(active);
  // The explorer's fold state is written as it changes, not here; carry it over untouched.
  const explorerOpen = useUiStore.getState().workspaces[workspaceId]?.explorerOpen;
  useUiStore.getState().setWorkspaceUi(workspaceId, {
    tabs: persisted,
    ...(activeEntity === undefined ? {} : { activeId: activeEntity.id }),
    sidebarView: useUiStore.getState().sidebar.view,
    ...(explorerOpen === undefined ? {} : { explorerOpen }),
  });
}

/**
 * Reopens what {@link saveWorkspaceTabs} recorded for `workspaceId`, dropping every tab whose
 * entity the project mirror no longer resolves — a request deleted, an interface removed, a
 * project unlinked between two sessions. Must run after the mirror is filled.
 */
export function restoreWorkspaceTabs(workspaceId: string): void {
  const entry = useUiStore.getState().workspaces[workspaceId];
  if (entry === undefined) {
    return;
  }
  const editors = useEditorsStore.getState();
  let activeTabId: string | undefined;
  const enabledKinds = useUiStore.getState().enabledKinds;
  for (const tab of entry.tabs) {
    const contribution = persistedContribution(tab.kind);
    // A tab of a kind this run switched off reopens as a placeholder panel rather than vanishing: its
    // entity is not in the mirror, so it is named for its kind.
    const owner = tabOwner(tab.kind);
    const off = owner !== undefined && !enabledKinds.includes(owner);
    const title = contribution === undefined ? undefined : off ? kindLabel(owner) : titleFor(contribution, tab.id);
    if (contribution === undefined || title === undefined) {
      continue;
    }
    const id = `${contribution.prefix}${tab.id}`;
    editors.open({ id, kind: tab.kind, title, [contribution.idField]: tab.id });
    if (tab.id === entry.activeId) {
      activeTabId = id;
    }
  }
  // `open` activates whatever it opened last, so the remembered tab is selected afterwards;
  // with none remembered (or resolvable) the Start tab shows instead.
  if (activeTabId === undefined) {
    useEditorsStore.getState().showStart();
  } else {
    useEditorsStore.getState().activate(activeTabId);
  }
  if (entry.sidebarView !== undefined) {
    useUiStore.getState().setSidebarView(entry.sidebarView);
  }
}

/**
 * Records the *open* workspace's tabs, for the one moment {@link saveWorkspaceTabs} never
 * sees: the window going away.
 *
 * Tabs are otherwise written only when a workspace is left for another one, because that is
 * the only point at which the outgoing workspace's tabs are still on screen. Quitting is the
 * exception — nothing is "left", the renderer simply stops — so without this a relaunch would
 * reopen the last workspace with no tabs at all, which the app promises it does not.
 */
export function rememberOpenWorkspaceTabs(): void {
  const workspaceId = useWorkspaceStore.getState().workspace?.id;
  if (workspaceId !== undefined) {
    saveWorkspaceTabs(workspaceId);
  }
}

/** The project `tab`'s entity belongs to, or `undefined` for a tab that names none (Settings, SSH, a workspace environment). */
export function projectOfTab(
  tab: EditorTab | undefined,
  projectOf: Readonly<Record<string, string>>,
): string | undefined {
  const contribution = tab === undefined ? undefined : TAB_KINDS[tab.kind];
  const entityId = tab === undefined || contribution === undefined ? undefined : entityIdOf(tab, contribution);
  return entityId !== undefined && Object.hasOwn(projectOf, entityId) ? projectOf[entityId] : undefined;
}

/** The focused tab, if any. */
function focusedTab(editors: {
  readonly tabs: readonly EditorTab[];
  readonly activeId: string | undefined;
}): EditorTab | undefined {
  return editors.activeId === undefined ? undefined : editors.tabs.find((tab) => tab.id === editors.activeId);
}

/** `lastProjectId` while it still names a project of the open workspace. */
function lastProjectOf(state: {
  readonly workspace: WorkspaceWire | null;
  readonly lastProjectId?: string | undefined;
}): string | undefined {
  const last = state.lastProjectId;
  return last !== undefined && state.workspace?.projects.some((project) => project.id === last) === true
    ? last
    : undefined;
}

/**
 * The current project (#468), read outside React: the focused tab's project, else the last project
 * a focused tab had (see {@link rememberFocusedProject}). `undefined` before any project tab was focused.
 */
export function currentProjectId(): string | undefined {
  const focused = projectOfTab(focusedTab(useEditorsStore.getState()), useProjectStore.getState().projectOf);
  return focused ?? lastProjectOf(useWorkspaceStore.getState());
}

/** {@link currentProjectId}, kept current: what the title-bar switcher acts on. */
export function useCurrentProjectId(): string | undefined {
  const tab = useEditorsStore((state) => focusedTab(state));
  const focused = useProjectStore((state) => projectOfTab(tab, state.projectOf));
  const last = useWorkspaceStore(lastProjectOf);
  return focused ?? last;
}

/**
 * Records the focused tab's project as the workspace store's `lastProjectId` whenever it changes, so
 * the current project survives focusing a tab with none. Started once by the shell; returns the stop.
 */
export function rememberFocusedProject(): () => void {
  const record = (): void => {
    const focused = projectOfTab(focusedTab(useEditorsStore.getState()), useProjectStore.getState().projectOf);
    if (focused !== undefined && focused !== useWorkspaceStore.getState().lastProjectId) {
      useWorkspaceStore.setState({ lastProjectId: focused });
    }
  };
  record();
  const offEditors = useEditorsStore.subscribe((state, previous) => {
    if (state.activeId !== previous.activeId || state.tabs !== previous.tabs) record();
  });
  const offProject = useProjectStore.subscribe((state, previous) => {
    if (state.projectOf !== previous.projectOf) record();
  });
  // A workspace (re)opening clears `lastProjectId`; the tab focused then is the new one's.
  const offWorkspace = useWorkspaceStore.subscribe((state, previous) => {
    if (state.workspace !== previous.workspace) record();
  });
  return () => {
    offEditors();
    offProject();
    offWorkspace();
  };
}
