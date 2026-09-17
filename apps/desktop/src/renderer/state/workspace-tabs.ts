/**
 * Per-workspace editor tabs: saved when a workspace closes, restored when it opens again.
 *
 * Only the tab kinds that name a durable entity survive a switch — a request of either protocol,
 * an imported interface, an API, an environment, a project. A diff, a history entry and the
 * preferences tab all describe a moment rather than a thing, so they are simply dropped.
 */

import type { PersistedTab } from './ui-state.js';
import { useEditorsStore, type EditorTab } from './editors.js';
import { useProjectStore, selectEnvironment } from './project.js';
import { useUiStore } from './ui.js';
import { useWorkspaceStore } from './workspace.js';

/**
 * The editor-tab id for one persisted entity. These prefixes are the ones
 * `request-actions.ts`, `interface-actions.ts` and `environment-actions.ts` open under;
 * they are repeated here rather than imported so this module stays free of the feature
 * layer (which imports the stores back). `ui-state-workspaces.test.ts` pins the two together.
 */
function tabIdFor(tab: PersistedTab): string {
  switch (tab.kind) {
    case 'request':
      return `request:${tab.id}`;
    case 'interface':
      return `interface:${tab.id}`;
    case 'environment':
      return `env:${tab.id}`;
    case 'project':
      return `project:${tab.id}`;
    case 'rest-request':
      return `rest:${tab.id}`;
    case 'api':
      return `api:${tab.id}`;
    case 'grpc-request':
      return `grpc:${tab.id}`;
    case 'grpc-api':
      return `grpc-api:${tab.id}`;
  }
}

/** The persisted shape of an open tab, or `undefined` for a kind that does not survive. */
function persist(tab: EditorTab): PersistedTab | undefined {
  if (tab.kind === 'request' && tab.requestId !== undefined) {
    return { kind: 'request', id: tab.requestId };
  }
  if (tab.kind === 'interface' && tab.interfaceId !== undefined) {
    return { kind: 'interface', id: tab.interfaceId };
  }
  if (tab.kind === 'environment' && tab.environmentId !== undefined) {
    return { kind: 'environment', id: tab.environmentId };
  }
  if (tab.kind === 'project' && tab.projectId !== undefined) {
    return { kind: 'project', id: tab.projectId };
  }
  if (tab.kind === 'rest-request' && tab.restRequestId !== undefined) {
    return { kind: 'rest-request', id: tab.restRequestId };
  }
  if (tab.kind === 'api' && tab.apiId !== undefined) {
    return { kind: 'api', id: tab.apiId };
  }
  if (tab.kind === 'grpc-request' && tab.grpcRequestId !== undefined) {
    return { kind: 'grpc-request', id: tab.grpcRequestId };
  }
  if (tab.kind === 'grpc-api' && tab.grpcApiId !== undefined) {
    return { kind: 'grpc-api', id: tab.grpcApiId };
  }
  return undefined;
}

/** The title one persisted tab reopens with, or `undefined` when its entity is gone. */
function titleFor(tab: PersistedTab): string | undefined {
  const projects = useProjectStore.getState();
  switch (tab.kind) {
    case 'request':
      return projects.requests[tab.id]?.name;
    case 'interface':
      return projects.interfaces[tab.id]?.name;
    case 'environment': {
      // 'globals' and 'workspace' are sentinel ids for the two fixed scopes that are not a real
      // environment — see `environment-actions.ts`'s `targetId`. Neither is ever a real
      // environment's id (those are UUIDs), so this check never shadows a real one.
      if (tab.id === 'globals') {
        return 'Globals';
      }
      if (tab.id === 'workspace') {
        return 'Workspace';
      }
      const workspace = useWorkspaceStore.getState().workspace;
      const environment =
        workspace?.environments.find((candidate) => candidate.id === tab.id) ?? selectEnvironment(projects, tab.id);
      return environment?.name;
    }
    case 'project':
      return projects.projects[tab.id]?.name;
    case 'rest-request':
      return projects.restRequests[tab.id]?.name;
    case 'api':
      return projects.apis[tab.id]?.name;
    case 'grpc-request':
      return projects.grpcRequests[tab.id]?.name;
    case 'grpc-api':
      return projects.grpcApis[tab.id]?.name;
  }
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
  for (const tab of entry.tabs) {
    const title = titleFor(tab);
    if (title === undefined) {
      continue;
    }
    const id = tabIdFor(tab);
    editors.open({
      id,
      kind: tab.kind,
      title,
      ...(tab.kind === 'request' ? { requestId: tab.id } : {}),
      ...(tab.kind === 'interface' ? { interfaceId: tab.id } : {}),
      ...(tab.kind === 'environment' ? { environmentId: tab.id } : {}),
      ...(tab.kind === 'project' ? { projectId: tab.id } : {}),
      ...(tab.kind === 'rest-request' ? { restRequestId: tab.id } : {}),
      ...(tab.kind === 'api' ? { apiId: tab.id } : {}),
      ...(tab.kind === 'grpc-request' ? { grpcRequestId: tab.id } : {}),
      ...(tab.kind === 'grpc-api' ? { grpcApiId: tab.id } : {}),
    });
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
