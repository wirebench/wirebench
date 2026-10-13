import { useEffect } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { SquareTerminal } from 'lucide-react';
import { Button } from '../../../components/button.js';
import { ConfirmDialog } from '../../../components/confirm-dialog.js';
import { setCloseGuard, useEditorsStore } from '../../../state/editors.js';
import { ConflictDialog } from './conflict-dialog.js';
import { FilePane } from './file-pane.js';
import { localPaneId, useFilesStore } from './files-store.js';
import { openTerminal } from './open-files.js';
import { TransfersStrip } from './transfers-strip.js';
import { listenToTransfers, useTransfersStore } from './transfers-store.js';

const SEPARATOR = 'w-px bg-hairline transition-colors hover:bg-accent-muted focus-visible:bg-accent';

/**
 * A host's Files tab: this machine on the left, the host on the right through the tab's own SFTP session
 * (separate from the terminal's), opened when the tab mounts and closed when the tab goes. Either pane's place
 * picker moves it to this machine or another host, each host pane with its own session; the transfers strip
 * under both, and the conflict question over them. The tab stays mounted behind other tabs, like a terminal,
 * so switching away keeps the folders, the session and the copies. Closing it with copies running asks first.
 */
export function FilesTab({ tabId, hostId }: { readonly tabId: string; readonly hostId: string }) {
  const conflict = useTransfersStore((s) => s.conflicts[tabId]?.[0] ?? null);
  const closing = useTransfersStore((s) => s.closing[tabId] === true);

  useEffect(() => {
    const files = useFilesStore.getState();
    if (files.panes[tabId] === undefined) void files.connect(tabId, hostId);
    void files.openLocal(localPaneId(tabId));
    const off = window.wirebench.on('sftp.closed', ((event: { sessionId: string }) => {
      useFilesStore.getState().noteClosed(event.sessionId);
    }) as (payload: unknown) => void);
    const stopListening = listenToTransfers();
    setCloseGuard(tabId, () => useTransfersStore.getState().holdClose(tabId));
    return () => {
      off();
      stopListening();
      setCloseGuard(tabId, undefined);
      // A remount of the same tab (StrictMode, an area toggle) keeps the session; a closed tab ends it.
      if (!useEditorsStore.getState().tabs.some((t) => t.id === tabId)) {
        useFilesStore.getState().close(tabId);
        useTransfersStore.getState().forgetTab(tabId);
      }
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
      <Group orientation="horizontal" className="flex min-h-0 flex-1">
        <Panel id="files-local-pane" defaultSize="50%" minSize="20%">
          <FilePane paneId={localPaneId(tabId)} />
        </Panel>
        <Separator aria-label="Resize" className={SEPARATOR} />
        <Panel id="files-remote-pane" minSize="20%">
          <FilePane paneId={tabId} />
        </Panel>
      </Group>
      <TransfersStrip tabId={tabId} />
      <ConflictDialog
        conflict={conflict}
        onAnswer={(decision, applyToRest) => {
          useTransfersStore.getState().answer(tabId, decision, applyToRest);
        }}
      />
      <ConfirmDialog
        open={closing}
        onOpenChange={(open) => {
          if (!open) useTransfersStore.getState().dismissClose(tabId);
        }}
        title="Cancel the copies?"
        description="Files are still being copied in this tab. Closing it cancels them; files not finished are not kept."
        confirmLabel="Cancel copies and close"
        destructive
        onConfirm={() => {
          useTransfersStore.getState().confirmClose(tabId);
        }}
        testId="files-close-confirm"
        confirmTestId="files-close-confirm-ok"
      />
    </div>
  );
}
