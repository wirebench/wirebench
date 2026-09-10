import { FileDown, FolderOpen, FilePlus } from 'lucide-react';
import { Button } from '../components/button.js';
import { EmptyState } from '../components/empty-state.js';
import { useEditorsStore } from '../state/editors.js';
import { useProjectStore } from '../state/project.js';

export interface EditorAreaProps {
  readonly onImportDefinition: () => void;
  readonly onOpenProject: () => void;
  readonly onNewProject: () => void;
}

const WELCOME_ID = 'welcome';

/**
 * The tabbed editor area. A Welcome tab is always present; opening a request from the
 * explorer adds a real tab from `state/editors.ts`. Task 15 replaces the request tab's
 * placeholder body with the full editor.
 */
export function EditorArea({ onImportDefinition, onOpenProject, onNewProject }: EditorAreaProps) {
  const tabs = useEditorsStore((state) => state.tabs);
  const activeId = useEditorsStore((state) => state.activeId);
  const activate = useEditorsStore((state) => state.activate);
  const close = useEditorsStore((state) => state.close);
  const requests = useProjectStore((state) => state.requests);

  const activeTab = tabs.find((t) => t.id === activeId);
  const showingWelcome = activeTab === undefined;

  return (
    <section data-testid="editor-area" aria-label="Editors" className="flex h-full min-h-0 flex-col bg-surface-base">
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
              {tab.title}
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

      <div className="min-h-0 flex-1 overflow-auto">
        {showingWelcome ? (
          <EmptyState
            title="Start with a definition"
            description="Wirebench works from a WSDL: import one to get an interface, its operations, and a ready-to-send request."
          >
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button variant="primary" onClick={onImportDefinition}>
                <FileDown size={14} aria-hidden="true" />
                Import WSDL
              </Button>
              <Button onClick={onOpenProject}>
                <FolderOpen size={14} aria-hidden="true" />
                Open project
              </Button>
              <Button onClick={onNewProject}>
                <FilePlus size={14} aria-hidden="true" />
                New project
              </Button>
            </div>
          </EmptyState>
        ) : (
          <div className="p-4">
            <p className="text-sm text-fg-subtle">Request editor arrives in Task 15</p>
            {activeTab.requestId !== undefined && (
              <pre className="mt-3 overflow-auto rounded bg-surface-raised p-3 text-xs text-fg-default">
                {requests[activeTab.requestId]?.envelopeXml ?? ''}
              </pre>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
