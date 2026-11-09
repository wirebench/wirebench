/**
 * Keeps a browser tab's address on where it is (see `address.ts`), and goes back there from it: on load, so a
 * reload or a bookmark lands where it was, and on Back and Forward. A move to another place — a workspace, a tab,
 * a sidebar area, a settings page — is a history entry, as following a link is; showing or hiding a panel only
 * replaces the address. The desktop has no address bar, so this does nothing there.
 */
import { useEffect } from 'react';
import type { WorkspaceWire } from '@shared/wire-base.js';
import { showToast } from '../../components/toast.js';
import { isBrowserTab } from '../../lib/capabilities.js';
import { activeAccount, useAccountStore } from '../../state/account.js';
import { useEditorsStore, type EditorTab } from '../../state/editors.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { openPersistedTab, persist, whenTabsRestored } from '../../state/workspace-tabs.js';
import type { ConsoleTab, SidebarView } from '../../state/ui-state.js';
import type { SettingsSectionRequest } from '../preferences/settings-model.js';
import { USER_PAGES, type UserSettingsPageId } from '../preferences/user-settings-model.js';
import { readTeamDeepLink } from '../team/team-link.js';
import { isTeamSettingsPage } from '../team/team-settings-model.js';
import { workspaceActions } from '../workspace/workspace-actions.js';
import { formatAddress, isNewPlace, parseAddress, type Address, type AddressTab } from './address.js';
import { useSettingsPlaceStore } from './settings-place.js';

/** How long a just-opened workspace's tab restore may take before the address stops waiting for it. */
const RESTORE_WAIT_MS = 5_000;

/** The id a workspace has in the address: its team workspace's for a server workspace, else its own. */
export function workspaceKey(workspace: Pick<WorkspaceWire, 'id' | 'share'> | null | undefined): string | undefined {
  if (workspace === null || workspace === undefined) return undefined;
  const server = workspace.share?.kind === 'server' ? workspace.share.server : undefined;
  return server?.workspaceId ?? workspace.id;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a === b;
  }
}

function activeTab(): EditorTab | undefined {
  const { tabs, activeId } = useEditorsStore.getState();
  return activeId === undefined ? undefined : tabs.find((tab) => tab.id === activeId);
}

/** Where the tab is now, read off the stores. */
export function currentAddress(): Address {
  const ui = useUiStore.getState();
  const { preferences } = ui;
  const place = useSettingsPlaceStore.getState();
  const settings: Address['settings'] = preferences.open
    ? {
        area: preferences.area,
        ...(place.page !== undefined ? { page: place.page } : {}),
        ...(preferences.area === 'team' && place.team !== undefined ? { team: place.team } : {}),
      }
    : undefined;
  const workspace = workspaceKey(useWorkspaceStore.getState().workspace);
  if (workspace === undefined) return settings === undefined ? {} : { settings };
  const active = activeTab();
  const tab = active === undefined ? undefined : persist(active);
  const { slideOver } = ui;
  return {
    workspace,
    ...(tab !== undefined ? { tab } : {}),
    ...(ui.sidebar.view !== ui.enabledAreas[0] ? { view: ui.sidebar.view } : {}),
    ...(ui.sidebar.visible ? {} : { sidebarHidden: true }),
    ...(ui.console.visible ? { console: ui.console.activeTab } : {}),
    ...(slideOver.open ? { code: true } : {}),
    ...(slideOver.environmentProjectsOpen === true
      ? { environmentPanel: 'projects' as const }
      : slideOver.environmentDetailsOpen === false
        ? { environmentPanel: 'off' as const }
        : {}),
    ...(slideOver.hostDetailsOpen === true ? { hostDetails: true } : {}),
    ...(settings !== undefined ? { settings } : {}),
  };
}

/** Opens the workspace the address names: from this account's list, else joined from the server. */
async function openWorkspace(key: string): Promise<void> {
  const store = useWorkspaceStore.getState();
  if (store.workspaces.length === 0) await store.list().catch(() => undefined);
  const rows = useWorkspaceStore.getState().workspaces;
  const server = (row: (typeof rows)[number]): { url: string; workspaceId: string } | undefined =>
    row.share?.kind === 'server' ? row.share.server : undefined;
  const row =
    rows.find((candidate) => server(candidate)?.workspaceId === key && candidate.unreadable !== true) ??
    rows.find((candidate) => candidate.id === key);
  if (row !== undefined) {
    await workspaceActions.open(row.id);
    return;
  }
  // A team workspace this account has not opened here yet: a teammate's link, or one opened in another browser.
  const { servers, active } = useAccountStore.getState();
  const url = activeAccount(servers, active)?.url ?? window.location.origin;
  if (!sameOrigin(url, window.location.origin)) return;
  const outcome = await workspaceActions.joinFromServer(url, key);
  if (outcome === true) return;
  if ('workspaceId' in outcome) {
    await workspaceActions.open(outcome.workspaceId);
    return;
  }
  showToast(outcome.message);
}

/** Selects the tab the address names, opening it if needed; the Start tab when it names none (or one gone). */
function showTab(tab: AddressTab | undefined): void {
  const editors = useEditorsStore.getState();
  const current = activeTab();
  const persisted = current === undefined ? undefined : persist(current);
  if (tab === undefined) {
    if (current !== undefined) editors.showStart();
    return;
  }
  if (persisted?.kind === tab.kind && persisted.id === tab.id) return;
  const existing = editors.tabs.find((candidate) => {
    const named = persist(candidate);
    return named?.kind === tab.kind && named.id === tab.id;
  });
  if (existing !== undefined) {
    editors.activate(existing.id);
  } else if (openPersistedTab(tab) === undefined) {
    editors.showStart();
  }
}

/** Puts the sidebar, the console and the side panels as the address has them. */
function showView(target: Address): void {
  const ui = useUiStore.getState();
  const view = (target.view ?? ui.enabledAreas[0]) as SidebarView | undefined;
  if (view !== undefined && view !== ui.sidebar.view && ui.enabledAreas.includes(view)) ui.setSidebarView(view);
  if (target.sidebarHidden === true && ui.sidebar.visible) ui.collapseSidebar();
  if (target.sidebarHidden !== true && !ui.sidebar.visible) ui.expandSidebar();
  const consoleTab = target.console as ConsoleTab | undefined;
  if (consoleTab !== undefined && (!ui.console.visible || ui.console.activeTab !== consoleTab)) {
    ui.showConsoleTab(consoleTab);
  }
  if (consoleTab === undefined && ui.console.visible) ui.collapseConsole();
  if (target.code === true && !ui.slideOver.open) ui.openCode();
  if (target.code !== true && ui.slideOver.open) ui.closeCode();
  const panel = target.environmentPanel;
  if (panel === 'projects') {
    if (ui.slideOver.environmentProjectsOpen !== true) ui.setEnvironmentProjectsOpen(true);
  } else {
    if (ui.slideOver.environmentProjectsOpen === true) ui.setEnvironmentProjectsOpen(false);
    const details = panel !== 'off';
    if ((ui.slideOver.environmentDetailsOpen !== false) !== details) ui.setEnvironmentDetailsOpen(details);
  }
  if ((ui.slideOver.hostDetailsOpen === true) !== (target.hostDetails === true)) {
    ui.setHostDetailsOpen(target.hostDetails === true);
  }
}

/** Opens (or closes) Settings as the address has it, unless it already shows that page. */
function showSettings(target: Address, search: string): void {
  const ui = useUiStore.getState();
  const settings = target.settings;
  if (settings === undefined) {
    if (ui.preferences.open) ui.setPreferencesOpen(false);
    return;
  }
  const place = useSettingsPlaceStore.getState();
  const samePage = settings.page === undefined || settings.page === place.page;
  const sameTeam = settings.team === undefined || settings.team === place.team;
  if (ui.preferences.open && ui.preferences.area === settings.area && samePage && sameTeam) return;
  const page = settings.page;
  if (settings.area === 'app') {
    ui.openPreferences(page as SettingsSectionRequest | undefined);
  } else if (settings.area === 'user') {
    const userPage = page !== undefined && (USER_PAGES as readonly string[]).includes(page) ? page : undefined;
    ui.openUserSettings(userPage as UserSettingsPageId | undefined);
  } else {
    // The desktop's *Manage team…* may name a workspace instead of a team: its team is the one to open.
    const workspaceId = readTeamDeepLink(search)?.workspaceId;
    ui.openTeamSettings({
      ...(settings.team !== undefined ? { teamId: settings.team } : {}),
      ...(workspaceId !== undefined ? { workspaceId } : {}),
      ...(page !== undefined && isTeamSettingsPage(page) ? { page } : {}),
    });
  }
}

/** The address's sync, one per tab. */
export function createAddressSync(): { start: () => Promise<void>; stop: () => void } {
  /** No writes before the address has been read (the reopened workspace must not overwrite it), nor while applying. */
  let started = false;
  let applying = 0;
  /** While a just-opened workspace restores its tabs: what that restore changes replaces the entry it opened. */
  let settling = false;

  /**
   * A workspace opened here, not from an address (the picker, *Open a team workspace…*), starts on the first area
   * unless it remembers a view of its own: the window's sidebar view belongs to the workspace left behind, and
   * carrying it over opened a new workspace on History. `true` when it moved the view.
   */
  const startsOnFirstArea = (): boolean => {
    const workspace = useWorkspaceStore.getState().workspace;
    const ui = useUiStore.getState();
    const first = ui.enabledAreas[0];
    if (workspace === null || first === undefined || ui.sidebar.view === first) return false;
    if (ui.workspaces[workspace.id]?.sidebarView !== undefined) return false;
    applying += 1;
    try {
      ui.setSidebarView(first);
    } finally {
      applying -= 1;
    }
    return true;
  };

  const write = (): void => {
    if (!started || applying > 0) return;
    const { pathname, search, hash } = window.location;
    const was = parseAddress(pathname, search);
    let next = currentAddress();
    if (was.workspace !== next.workspace && next.workspace !== undefined && startsOnFirstArea()) {
      next = currentAddress();
    }
    const url = formatAddress(next, search);
    if (url === `${pathname}${search}`) return;
    const workspaceChanged = was.workspace !== next.workspace;
    if (!settling && isNewPlace(was, next)) {
      window.history.pushState(null, '', `${url}${hash}`);
    } else {
      window.history.replaceState(window.history.state, '', `${url}${hash}`);
    }
    const workspace = useWorkspaceStore.getState().workspace;
    if (workspaceChanged && workspace !== null) {
      settling = true;
      void whenTabsRestored(workspace.id, RESTORE_WAIT_MS).then(() => {
        settling = false;
        write();
      });
    }
  };

  /** Goes to `target`: Settings, the workspace, then its tab and view once its own tabs are back. */
  const apply = async (target: Address, search: string, initial: boolean): Promise<void> => {
    applying += 1;
    try {
      showSettings(target, search);
      const open = useWorkspaceStore.getState().workspace;
      if (target.workspace === undefined) {
        // A first load at `/` keeps the workspace the server reopened; Back to `/` leaves it for the list.
        if (!initial && open !== null)
          await useWorkspaceStore
            .getState()
            .close()
            .catch(() => undefined);
        return;
      }
      if (workspaceKey(open) !== target.workspace) {
        const restored = new Promise<void>((resolve) => {
          const stopWatching = useWorkspaceStore.subscribe((state) => {
            if (state.workspace !== null && workspaceKey(state.workspace) === target.workspace) {
              stopWatching();
              void whenTabsRestored(state.workspace.id, RESTORE_WAIT_MS).then(resolve);
            }
          });
          setTimeout(() => {
            stopWatching();
            resolve();
          }, RESTORE_WAIT_MS * 2);
        });
        await openWorkspace(target.workspace);
        if (workspaceKey(useWorkspaceStore.getState().workspace) !== target.workspace) return;
        await restored;
      } else if (open !== null) {
        // The server reopened this very workspace: its remembered tabs go back first, the address's on top.
        await whenTabsRestored(open.id, RESTORE_WAIT_MS);
      }
      showTab(target.tab);
      showView(target);
    } finally {
      applying -= 1;
    }
  };

  /** After going somewhere, the address says where the tab ended up (a tab that is gone drops out of it). */
  const settle = (): void => {
    const { pathname, search, hash } = window.location;
    const url = formatAddress(currentAddress(), search);
    if (url !== `${pathname}${search}`) window.history.replaceState(window.history.state, '', `${url}${hash}`);
  };

  const onPopState = (): void => {
    const { pathname, search } = window.location;
    void apply(parseAddress(pathname, search), search, false).then(settle);
  };

  const unsubscribers: (() => void)[] = [];
  return {
    start: async () => {
      unsubscribers.push(
        useWorkspaceStore.subscribe(write),
        useEditorsStore.subscribe(write),
        useUiStore.subscribe(write),
        useSettingsPlaceStore.subscribe(write),
      );
      window.addEventListener('popstate', onPopState);
      // The server's reopen of the last workspace settles first, so the address goes on top of it.
      if (!useWorkspaceStore.getState().ready) {
        await new Promise<void>((resolve) => {
          const stopWatching = useWorkspaceStore.subscribe((state) => {
            if (state.ready) {
              stopWatching();
              resolve();
            }
          });
        });
      }
      const { pathname, search } = window.location;
      await apply(parseAddress(pathname, search), search, true);
      started = true;
      settle();
    },
    stop: () => {
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      window.removeEventListener('popstate', onPopState);
      started = false;
    },
  };
}

/** Runs the address sync for the life of the shell, in a browser tab only. */
export function useAddress(): void {
  useEffect(() => {
    if (!isBrowserTab()) return undefined;
    const sync = createAddressSync();
    void sync.start();
    return sync.stop;
  }, []);
}
