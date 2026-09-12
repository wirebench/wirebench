import { PanelLeftClose } from 'lucide-react';
import { IconButton } from '../components/icon-button.js';
import { EnvironmentsView } from '../features/environments/environments-view.js';
import { ExplorerView } from '../features/explorer/explorer-view.js';
import { HistoryView } from '../features/history/history-view.js';
import { PreferencesSectionList } from '../features/preferences/section-list.js';
import { SearchView } from '../features/search/search-view.js';
import { WssSection } from '../features/wss/wss-section.js';
import type { SidebarView } from '../state/ui-state.js';
import { useUiStore } from '../state/ui.js';

interface ViewCopy {
  readonly title: string;
  readonly headline: string;
  readonly body: string;
}

const VIEWS: Readonly<Record<SidebarView, ViewCopy>> = {
  explorer: {
    title: 'Explorer',
    headline: 'No project open',
    body: 'Import a WSDL or open a project to see its interfaces, operations, and requests here.',
  },
  environments: {
    title: 'Environments',
    headline: 'No workspace open',
    body: 'Open a workspace to see its environments here.',
  },
  search: {
    title: 'Search',
    headline: 'Search the project',
    body: 'Find operations, requests, and endpoints once a project is open.',
  },
  history: {
    title: 'History',
    headline: 'Nothing sent yet',
    body: 'Every request you send is listed here with its status, duration, and size.',
  },
  wss: {
    title: 'WS-Security',
    headline: 'WS-Security',
    body: 'Client keystores, and the outgoing/incoming configurations requests can apply.',
  },
  settings: {
    title: 'Settings',
    headline: 'Preferences',
    body: 'HTTP, proxy, TLS, WSDL, editor and UI preferences.',
  },
};

/** The sidebar panel: a section title plus the active view's content. */
export function Sidebar() {
  const view = useUiStore((state) => state.sidebar.view);
  const collapseSidebar = useUiStore((state) => state.collapseSidebar);
  const copy = VIEWS[view];

  return (
    <aside
      data-testid="sidebar"
      aria-label={copy.title}
      className="flex h-full min-w-0 flex-col bg-surface-base text-fg-default"
    >
      <h2 className="flex h-row shrink-0 items-center justify-between px-3 text-xs font-medium tracking-wider text-fg-subtle uppercase">
        {copy.title}
        <IconButton
          label="Collapse Sidebar"
          data-testid="sidebar-collapse"
          className="normal-case"
          onClick={() => {
            collapseSidebar();
          }}
        >
          <PanelLeftClose size={14} aria-hidden="true" />
        </IconButton>
      </h2>
      {view === 'explorer' ? (
        <ExplorerView />
      ) : view === 'environments' ? (
        <EnvironmentsView />
      ) : view === 'search' ? (
        <SearchView />
      ) : view === 'history' ? (
        <HistoryView />
      ) : view === 'wss' ? (
        <WssSection />
      ) : view === 'settings' ? (
        <PreferencesSectionList />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
          <p className="text-md text-fg-muted">{copy.headline}</p>
          <p className="mt-1 text-sm text-fg-subtle">{copy.body}</p>
        </div>
      )}
    </aside>
  );
}
