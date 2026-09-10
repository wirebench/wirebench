import { EnvironmentsSection } from '../features/environments/environments-section.js';
import { ExplorerView } from '../features/explorer/explorer-view.js';
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
  settings: {
    title: 'Settings',
    headline: 'Preferences',
    body: 'Proxy, TLS, timeouts, and editor preferences arrive with the settings editor.',
  },
};

/** The sidebar panel: a section title plus the active view's content. */
export function Sidebar() {
  const view = useUiStore((state) => state.sidebar.view);
  const copy = VIEWS[view];

  return (
    <aside
      data-testid="sidebar"
      aria-label={copy.title}
      className="flex h-full min-w-0 flex-col bg-surface-base text-fg-default"
    >
      <h2 className="flex h-row shrink-0 items-center px-3 text-xs font-medium tracking-wider text-fg-subtle uppercase">
        {copy.title}
      </h2>
      {view === 'explorer' ? (
        <>
          <ExplorerView />
          <EnvironmentsSection />
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
          <p className="text-md text-fg-muted">{copy.headline}</p>
          <p className="mt-1 text-sm text-fg-subtle">{copy.body}</p>
        </div>
      )}
    </aside>
  );
}
