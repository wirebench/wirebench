import { FileDown, FolderOpen, FilePlus } from 'lucide-react';
import { Button } from '../components/button.js';
import { EmptyState } from '../components/empty-state.js';

export interface EditorAreaProps {
  readonly onImportDefinition: () => void;
  readonly onOpenProject: () => void;
  readonly onNewProject: () => void;
}

/**
 * The tabbed editor area. Until Task 14 lands real editors there is exactly one tab, Welcome,
 * whose three actions are the only ways into the app.
 */
export function EditorArea({ onImportDefinition, onOpenProject, onNewProject }: EditorAreaProps) {
  return (
    <section data-testid="editor-area" aria-label="Editors" className="flex h-full min-h-0 flex-col bg-surface-base">
      <div role="tablist" aria-label="Open editors" className="flex h-row shrink-0 border-b border-hairline">
        <button
          type="button"
          role="tab"
          aria-selected="true"
          className="inline-flex items-center border-r border-hairline bg-surface-raised px-3 text-sm text-fg-default"
        >
          Welcome
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
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
      </div>
    </section>
  );
}
