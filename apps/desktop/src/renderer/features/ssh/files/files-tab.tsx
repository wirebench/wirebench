import { useEffect } from 'react';
import { SquareTerminal } from 'lucide-react';
import { Button } from '../../../components/button.js';
import { useEditorsStore } from '../../../state/editors.js';
import { FilePane } from './file-pane.js';
import { useFilesStore } from './files-store.js';
import { openTerminal } from './open-files.js';

/**
 * A host's Files tab: its own SFTP session (separate from the terminal's), opened when the tab mounts and
 * closed when the tab goes. The tab stays mounted behind other tabs, like a terminal, so switching away keeps
 * the folder and the session.
 */
export function FilesTab({ tabId, hostId }: { readonly tabId: string; readonly hostId: string }) {
  useEffect(() => {
    if (useFilesStore.getState().panes[tabId] === undefined) void useFilesStore.getState().connect(tabId, hostId);
    const off = window.wirebench.on('sftp.closed', ((event: { sessionId: string }) => {
      useFilesStore.getState().noteClosed(event.sessionId);
    }) as (payload: unknown) => void);
    return () => {
      off();
      // A remount of the same tab (StrictMode, an area toggle) keeps the session; a closed tab ends it.
      if (!useEditorsStore.getState().tabs.some((t) => t.id === tabId)) useFilesStore.getState().close(tabId);
    };
  }, [tabId, hostId]);

  return (
    <div className="flex h-full flex-col" data-testid="ssh-files">
      <div className="flex items-center gap-2 border-b border-hairline px-2 py-1">
        <span className="min-w-0 flex-1" />
        <Button
          variant="ghost"
          onClick={() => {
            openTerminal(hostId);
          }}
        >
          <SquareTerminal size={14} aria-hidden="true" /> Open terminal
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <FilePane tabId={tabId} />
      </div>
    </div>
  );
}
