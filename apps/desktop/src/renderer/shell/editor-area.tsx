import { lazy, Suspense } from 'react';
import { ChangedOnDiskBanner } from '../features/project/changed-on-disk-banner.js';
import { WelcomeScreen } from '../features/welcome/welcome-screen.js';
import { useEditorsStore } from '../state/editors.js';
import { useProjectStore } from '../state/project.js';

// Monaco is by far the heaviest thing the renderer loads, so the request editor — the only
// thing that pulls it in — is split out and fetched the first time a request tab is opened.
const RequestEditor = lazy(async () => {
  const module = await import('../features/request-editor/request-editor.js');
  return { default: module.RequestEditor };
});

export interface EditorAreaProps {
  readonly onImportDefinition: () => void;
}

const WELCOME_ID = 'welcome';

/**
 * The tabbed editor area. A Welcome tab is always present; opening a request from the
 * explorer adds a real tab from `state/editors.ts`; its body is the lazily-loaded request editor.
 */
export function EditorArea({ onImportDefinition }: EditorAreaProps) {
  const tabs = useEditorsStore((state) => state.tabs);
  const activeId = useEditorsStore((state) => state.activeId);
  const activate = useEditorsStore((state) => state.activate);
  const close = useEditorsStore((state) => state.close);
  const requests = useProjectStore((state) => state.requests);

  const activeTab = tabs.find((t) => t.id === activeId);
  const showingWelcome = activeTab === undefined;

  return (
    <section data-testid="editor-area" aria-label="Editors" className="flex h-full min-h-0 flex-col bg-surface-base">
      <ChangedOnDiskBanner />
      <div
        role="tablist"
        aria-label="Open editors"
        className="flex h-row shrink-0 overflow-x-auto border-b border-hairline"
      >
        <button
          type="button"
          role="tab"
          aria-selected={showingWelcome}
          onClick={() => activate(WELCOME_ID)}
          className={`inline-flex shrink-0 items-center border-r border-hairline px-3 text-sm ${
            showingWelcome ? 'bg-surface-raised text-fg-default' : 'text-fg-subtle hover:bg-surface-raised'
          }`}
        >
          Welcome
        </button>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeId}
            className={`group inline-flex shrink-0 items-center gap-2 border-r border-hairline px-3 text-sm ${
              tab.id === activeId ? 'bg-surface-raised text-fg-default' : 'text-fg-subtle hover:bg-surface-raised'
            }`}
          >
            <button type="button" onClick={() => activate(tab.id)}>
              {(tab.requestId !== undefined ? requests[tab.requestId]?.name : undefined) ?? tab.title}
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              className="text-fg-subtle hover:text-fg-default"
              onClick={() => close(tab.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {showingWelcome ? (
          <WelcomeScreen onImportDefinition={onImportDefinition} />
        ) : activeTab.requestId !== undefined ? (
          <Suspense fallback={<p className="p-4 text-sm text-fg-subtle">Loading editor…</p>}>
            <RequestEditor requestId={activeTab.requestId} />
          </Suspense>
        ) : null}
      </div>
    </section>
  );
}
